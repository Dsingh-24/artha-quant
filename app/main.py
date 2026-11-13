"""FastAPI application and Backend-for-Frontend (BFF) layer for ArthaQuant.

Enforces mandatory web security controls:
- Localhost-only server binding (`127.0.0.1`) in entrypoint.
- HTTP method allow-list (`GET`, `POST`), sliding-window rate limiting, and strict CORS.
- Strict CSP, anti-clickjacking (`X-Frame-Options: DENY`), `nosniff`, and `Cache-Control: no-store`.
- Server-side session cookies (`HttpOnly`, `SameSite=Strict`, `__Host-` under HTTPS) + synchronizer CSRF on all POSTs,
  including pre-auth double-submit CSRF verification on setup/login endpoints.
"""

from __future__ import annotations

import hmac
import logging
import os
import secrets
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import pandas as pd
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.backtester import run_point_in_time_backtest
from app.database import DEFAULT_DB_PATH, Database
from app.factors import PRESET_WEIGHTS, score_universe_point_in_time
from app.live_funnel import (
    BENCHMARK_TICKER,
    refresh_live_prices_only,
    run_stage1_bulk_funnel,
    run_stage2_deep_fundamentals,
    sync_single_live_ticker,
)
from app.planner import build_investment_plan
from app.schemas import (
    AuthCredentials,
    BacktestRequest,
    FunnelExpandRequest,
    FunnelRefreshRequest,
    PlannerRequest,
    ScreenerRequest,
    TickerSyncRequest,
)
from app.security import (
    SESSION_TTL_SECONDS,
    SlidingWindowRateLimiter,
    generate_session_tokens,
    hash_password,
    hash_session_id,
    safe_sandbox_path,
    validate_password_strength,
    verify_password,
)
from app.universe import import_fundamentals_csv, seed_calibrated_nse_universe

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("arthaquant.api")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
UPLOAD_DIR = BASE_DIR / "data" / "uploads"
MAX_CSV_BYTES = 2 * 1024 * 1024  # 2 MB cap

HTTPS_SESSION_COOKIE = "__Host-artha_session"
LOCAL_HTTP_SESSION_COOKIE = "artha_local_session"
PREAUTH_CSRF_COOKIE = "artha_preauth_csrf"


class MarketDataCache:
    """Thread-safe in-memory cache of pivoted price matrix, fundamentals DataFrame, and Stage-1 funnel."""

    def __init__(self, db: Database) -> None:
        self.db = db
        self._lock = threading.Lock()
        self._companies: Optional[list] = None
        self._fundamentals_df: Optional[pd.DataFrame] = None
        self._price_matrix: Optional[pd.DataFrame] = None
        self._stage1_funnel: Optional[list] = None
        self._quarterly_signals: Optional[Dict[str, Dict[str, Any]]] = None

    def invalidate(self) -> None:
        with self._lock:
            self._companies = None
            self._fundamentals_df = None
            self._price_matrix = None
            self._stage1_funnel = None
            self._quarterly_signals = None

    def get_quarterly_signals(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            if self._quarterly_signals is None:
                self._quarterly_signals = self.db.get_all_quarterly_signals()
            return self._quarterly_signals

    def load(self) -> Tuple[list, pd.DataFrame, pd.DataFrame, list]:
        with self._lock:
            if (
                self._companies is not None
                and self._fundamentals_df is not None
                and self._price_matrix is not None
                and self._stage1_funnel is not None
            ):
                return self._companies, self._fundamentals_df, self._price_matrix, self._stage1_funnel

            companies = self.db.get_all_companies()
            fund_rows = self.db.get_all_fundamentals()
            price_rows = self.db.get_all_prices()
            stage1_rows = self.db.get_stage1_funnel()

            fund_df = pd.DataFrame(fund_rows)
            if price_rows:
                p_df = pd.DataFrame(price_rows)
                p_mat = p_df.pivot(index="trade_date", columns="ticker", values="close_price").sort_index().ffill()
            else:
                p_mat = pd.DataFrame()

            self._companies = companies
            self._fundamentals_df = fund_df
            self._price_matrix = p_mat
            self._stage1_funnel = stage1_rows
            return companies, fund_df, p_mat, stage1_rows


def create_app(db_path: Path = DEFAULT_DB_PATH, seed_fallback_if_empty: bool = True) -> FastAPI:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(UPLOAD_DIR, 0o700)
    except OSError:
        pass

    db = Database(db_path=db_path)
    if seed_fallback_if_empty and db.count_companies() == 0:
        seed_calibrated_nse_universe(db)
    market_cache = MarketDataCache(db)
    rate_limiter = SlidingWindowRateLimiter(max_requests=220, window_seconds=60)

    app = FastAPI(
        title="ArthaQuant — Indian Equity Investment Advisor & Backtester",
        version="1.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.db = db
    app.state.market_cache = market_cache

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:8000", "http://localhost:8000"],
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-CSRF-Token"],
    )

    @app.middleware("http")
    async def security_guard_middleware(request: Request, call_next):
        if request.method not in {"GET", "POST"}:
            return JSONResponse(status_code=405, content={"detail": "Method not allowed."})

        client_host = request.client.host if request.client else "127.0.0.1"
        if not rate_limiter.allow(client_host):
            return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded. Please retry shortly."})

        try:
            response: Response = await call_next(request)
        except Exception as exc:
            logger.error("Unhandled internal error on %s: %s", request.url.path, type(exc).__name__)
            response = JSONResponse(status_code=500, content={"detail": "An internal processing error occurred."})

        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self'; "
            "img-src 'self' data:; "
            "font-src 'self'; "
            "connect-src 'self'; "
            "object-src 'none'; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"

        return response

    def _set_session_cookie(response: Response, request: Request, raw_session_id: str) -> None:
        is_https = request.url.scheme == "https"
        # TODO(security): On local HTTP (`http://127.0.0.1`), macOS Safari drops `Secure`/`__Host-` cookies.
        # In production TLS deployments, `is_https` is True and strictly enforces `__Host-` + `Secure`.
        cookie_name = HTTPS_SESSION_COOKIE if is_https else LOCAL_HTTP_SESSION_COOKIE
        response.set_cookie(
            key=cookie_name,
            value=raw_session_id,
            max_age=SESSION_TTL_SECONDS,
            httponly=True,
            secure=is_https,
            samesite="strict",
            path="/",
        )

    def _clear_session_cookies(response: Response) -> None:
        response.delete_cookie(key=HTTPS_SESSION_COOKIE, path="/")
        response.delete_cookie(key=LOCAL_HTTP_SESSION_COOKIE, path="/")

    def _extract_session(request: Request) -> Optional[Dict[str, Any]]:
        raw_sid = request.cookies.get(HTTPS_SESSION_COOKIE) or request.cookies.get(LOCAL_HTTP_SESSION_COOKIE)
        if not raw_sid:
            return None
        return db.get_active_session(hash_session_id(raw_sid))

    def require_session(
        request: Request,
        x_csrf_token: Optional[str] = Header(default=None, alias="X-CSRF-Token"),
    ) -> Dict[str, Any]:
        sess = _extract_session(request)
        if not sess:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
        if request.method == "POST":
            if not x_csrf_token or not hmac.compare_digest(x_csrf_token, sess["csrf_token"]):
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token validation failed.")
        return sess

    def verify_preauth_csrf(
        request: Request,
        x_csrf_token: Optional[str] = Header(default=None, alias="X-CSRF-Token"),
    ) -> None:
        cookie_tok = request.cookies.get(PREAUTH_CSRF_COOKIE)
        if not cookie_tok or not x_csrf_token or not hmac.compare_digest(cookie_tok, x_csrf_token):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token validation failed.")

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/")
    def serve_index() -> FileResponse:
        return FileResponse(str(STATIC_DIR / "index.html"))

    # --- Auth & Session Lifecycle ---

    @app.get("/api/auth/status")
    def auth_status(request: Request, response: Response) -> Dict[str, Any]:
        needs_setup = db.count_users() == 0
        sess = _extract_session(request)
        if sess:
            return {
                "authenticated": True,
                "needs_setup": needs_setup,
                "username": sess["username"],
                "role": sess["role"],
                "csrf_token": sess["csrf_token"],
            }

        preauth_token = request.cookies.get(PREAUTH_CSRF_COOKIE) or secrets.token_urlsafe(32)
        is_https = request.url.scheme == "https"
        response.set_cookie(
            key=PREAUTH_CSRF_COOKIE,
            value=preauth_token,
            max_age=3600,
            httponly=True,
            secure=is_https,
            samesite="strict",
            path="/",
        )
        return {
            "authenticated": False,
            "needs_setup": needs_setup,
            "csrf_token": preauth_token,
        }

    @app.post("/api/auth/setup")
    def auth_setup(
        creds: AuthCredentials,
        request: Request,
        response: Response,
        _csrf: None = Depends(verify_preauth_csrf),
    ) -> Dict[str, Any]:
        if db.count_users() > 0:
            raise HTTPException(status_code=400, detail="Workspace advisor account already initialized. Please sign in.")
        pw_err = validate_password_strength(creds.password)
        if pw_err:
            raise HTTPException(status_code=400, detail=pw_err)

        pw_hash = hash_password(creds.password)
        user_id = db.create_user(creds.username, pw_hash, role="advisor")
        raw_sid, csrf_tok = generate_session_tokens()
        db.create_session(hash_session_id(raw_sid), user_id, csrf_tok, SESSION_TTL_SECONDS)
        _set_session_cookie(response, request, raw_sid)
        response.delete_cookie(key=PREAUTH_CSRF_COOKIE, path="/")
        return {"authenticated": True, "username": creds.username, "csrf_token": csrf_tok}

    @app.post("/api/auth/login")
    def auth_login(
        creds: AuthCredentials,
        request: Request,
        response: Response,
        _csrf: None = Depends(verify_preauth_csrf),
    ) -> Dict[str, Any]:
        user = db.get_user_by_username(creds.username)
        if not user or not user["is_active"] or not verify_password(creds.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid username or password.")

        raw_sid, csrf_tok = generate_session_tokens()
        db.create_session(hash_session_id(raw_sid), int(user["id"]), csrf_tok, SESSION_TTL_SECONDS)
        _set_session_cookie(response, request, raw_sid)
        response.delete_cookie(key=PREAUTH_CSRF_COOKIE, path="/")
        return {"authenticated": True, "username": user["username"], "csrf_token": csrf_tok}

    @app.post("/api/auth/logout")
    def auth_logout(
        response: Response,
        sess: Dict[str, Any] = Depends(require_session),
    ) -> Dict[str, Any]:
        db.invalidate_all_user_sessions(int(sess["user_id"]))
        _clear_session_cookies(response)
        return {"authenticated": False}

    # --- Two-Stage Funnel, Screener & Live Sync ---

    @app.post("/api/screener")
    def run_screener(
        payload: ScreenerRequest,
        _sess: Dict[str, Any] = Depends(require_session),
    ) -> Dict[str, Any]:
        companies, fund_df, price_mat, stage1_rows = market_cache.load()
        if price_mat.empty:
            raise HTTPException(status_code=503, detail="Market price database is empty.")

        as_of = str(price_mat.index[-1])
        custom_w = payload.weights.model_dump() if payload.weights else None
        s1_lookup = {r["ticker"]: r for r in stage1_rows}
        qtr_signals = market_cache.get_quarterly_signals()

        scored = score_universe_point_in_time(
            companies=companies,
            fundamentals_df=fund_df,
            price_matrix=price_mat,
            as_of_date=as_of,
            preset=payload.preset,
            custom_weights=custom_w,
            stage1_lookup=s1_lookup,
            quarterly_signals=qtr_signals,
        )

        sectors = sorted({c["sector"] for c in companies})
        filtered = [
            s
            for s in scored
            if (payload.sector == "ALL" or s["sector"] == payload.sector)
            and s["composite_score"] >= payload.min_score
        ]

        filtered_stage1 = [
            r
            for r in stage1_rows
            if (payload.sector == "ALL" or r["sector"] == payload.sector)
        ]

        rating_counts = {"Strong Buy": 0, "Buy": 0, "Hold": 0, "Avoid": 0}
        for s in scored:
            rating_counts[s["rating"]] = rating_counts.get(s["rating"], 0) + 1

        bm_latest = float(price_mat[BENCHMARK_TICKER].dropna().iloc[-1]) if BENCHMARK_TICKER in price_mat.columns else 0.0
        unscored_remaining = sum(1 for r in stage1_rows if not r.get("deep_scored"))

        return {
            "as_of_date": as_of,
            "benchmark_nifty50": round(bm_latest, 2),
            "preset_weights": PRESET_WEIGHTS,
            "sectors": sectors,
            "rating_counts": rating_counts,
            "total_stage1_scanned": len(stage1_rows) if stage1_rows else len(companies),
            "total_deep_scored": len(scored),
            "unscored_funnel_remaining": unscored_remaining,
            "total_universe": len(scored),
            "stocks": filtered,
            "stage1_funnel": filtered_stage1,
        }

    @app.get("/api/company/{ticker}")
    def get_company_detail(
        ticker: str,
        preset: str = "qglp_compounder",
        _sess: Dict[str, Any] = Depends(require_session),
    ) -> Dict[str, Any]:
        validated = TickerSyncRequest(ticker=ticker).ticker
        companies, fund_df, price_mat, stage1_rows = market_cache.load()
        comp = db.get_company(validated)
        if not comp:
            raise HTTPException(status_code=404, detail="Company not found in universe.")

        as_of = str(price_mat.index[-1])
        s1_lookup = {r["ticker"]: r for r in stage1_rows}
        qtr_signals = market_cache.get_quarterly_signals()
        scored = score_universe_point_in_time(
            companies=companies,
            fundamentals_df=fund_df,
            price_matrix=price_mat,
            as_of_date=as_of,
            preset=preset if preset in PRESET_WEIGHTS else "qglp_compounder",
            stage1_lookup=s1_lookup,
            quarterly_signals=qtr_signals,
        )
        scorecard = next((s for s in scored if s["ticker"] == validated), None)
        fundamentals = db.get_company_fundamentals(validated)
        prices = db.get_company_prices(validated, limit_days=1260)
        stride = max(1, len(prices) // 160)
        sampled_prices = [
            prices[i]
            for i in sorted(set(list(range(0, len(prices), stride)) + ([len(prices) - 1] if prices else [])))
        ]

        return {
            "company": comp,
            "scorecard": scorecard,
            "fundamentals": fundamentals,
            "price_history": sampled_prices,
        }

    @app.post("/api/sync/ticker")
    def sync_live_ticker(
        payload: TickerSyncRequest,
        sess: Dict[str, Any] = Depends(require_session),
    ) -> Dict[str, Any]:
        if sess.get("role") != "advisor":
            raise HTTPException(status_code=403, detail="Advisor role required.")
        try:
            summary = sync_single_live_ticker(db, payload.ticker)
        except Exception:
            raise HTTPException(
                status_code=422,
                detail=f"Live sync unavailable for {payload.ticker}. Verify NSE symbol or network connectivity.",
            )
        market_cache.invalidate()
        return {"status": "ok", "sync": summary}

    @app.post("/api/funnel/prices")
    def refresh_prices_fast(
        sess: Dict[str, Any] = Depends(require_session),
    ) -> Dict[str, Any]:
        if sess.get("role") != "advisor":
            raise HTTPException(status_code=403, detail="Advisor role required.")
        try:
            summary = refresh_live_prices_only(db)
        except Exception:
            raise HTTPException(status_code=502, detail="Unable to refresh live NSE prices.")
        market_cache.invalidate()
        return {"status": "ok", **summary}

    @app.post("/api/funnel/refresh")
    def refresh_nifty200_funnel(
        payload: FunnelRefreshRequest,
        sess: Dict[str, Any] = Depends(require_session),
    ) -> Dict[str, Any]:
        if sess.get("role") != "advisor":
            raise HTTPException(status_code=403, detail="Advisor role required.")
        try:
            s1 = run_stage1_bulk_funnel(db, shortlist_top_n=payload.shortlist_top_n)
            s2 = run_stage2_deep_fundamentals(db, s1["shortlisted"])
        except Exception:
            raise HTTPException(status_code=502, detail="Unable to complete live Nifty 200 funnel refresh.")
        market_cache.invalidate()
        return {
            "status": "ok",
            "stage1_scanned": s1["total_scanned"],
            "stage2_deep_scored": s2["companies_deep_scored"],
            "annual_rows_saved": s2["annual_rows_saved"],
        }

    @app.post("/api/funnel/expand")
    def expand_stage2_deep_scoring(
        payload: FunnelExpandRequest,
        sess: Dict[str, Any] = Depends(require_session),
    ) -> Dict[str, Any]:
        if sess.get("role") != "advisor":
            raise HTTPException(status_code=403, detail="Advisor role required.")
        next_batch = db.get_next_unscored_funnel_tickers(limit=payload.batch_size)
        if not next_batch:
            return {"status": "ok", "companies_deep_scored": 0, "annual_rows_saved": 0}
        s2 = run_stage2_deep_fundamentals(db, next_batch)
        market_cache.invalidate()
        return {"status": "ok", **s2}

    @app.post("/api/import/csv")
    async def upload_fundamentals_csv(
        file: UploadFile = File(...),
        sess: Dict[str, Any] = Depends(require_session),
    ) -> Dict[str, Any]:
        if sess.get("role") != "advisor":
            raise HTTPException(status_code=403, detail="Advisor role required.")

        orig_name = file.filename or "upload.csv"
        if not orig_name.lower().endswith(".csv"):
            raise HTTPException(status_code=400, detail="Only .csv files are permitted.")

        raw = await file.read(MAX_CSV_BYTES + 1)
        if len(raw) > MAX_CSV_BYTES:
            raise HTTPException(status_code=413, detail="CSV exceeds maximum allowed size of 2 MB.")
        if b"\x00" in raw or raw.lstrip().startswith((b"<!DOCTYPE", b"<html", b"<?xml")):
            raise HTTPException(status_code=400, detail="File content failed CSV inspection.")

        unique_name = f"{uuid.uuid4().hex}.csv"
        dest_path = safe_sandbox_path(UPLOAD_DIR, unique_name)
        dest_path.write_bytes(raw)
        try:
            os.chmod(dest_path, 0o600)
        except OSError:
            pass

        try:
            summary = import_fundamentals_csv(db, raw)
        except ValueError as exc:
            dest_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=str(exc))

        market_cache.invalidate()
        return {"status": "ok", "imported": summary}

    # --- Point-in-Time Backtester & Wealth Planner ---

    @app.post("/api/backtest")
    def execute_backtest(
        payload: BacktestRequest,
        _sess: Dict[str, Any] = Depends(require_session),
    ) -> Dict[str, Any]:
        companies, fund_df, price_mat, _s1 = market_cache.load()
        custom_w = payload.weights.model_dump() if payload.weights else None
        try:
            return run_point_in_time_backtest(
                companies=companies,
                fundamentals_df=fund_df,
                price_matrix=price_mat,
                preset=payload.preset,
                custom_weights=custom_w,
                lookback_years=payload.lookback_years,
                top_n=payload.top_n,
                rebalance=payload.rebalance,
                weighting=payload.weighting,
                initial_capital=payload.initial_capital,
                cost_bps=payload.cost_bps,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/planner")
    def generate_plan(
        payload: PlannerRequest,
        sess: Dict[str, Any] = Depends(require_session),
    ) -> Dict[str, Any]:
        companies, fund_df, price_mat, _s1 = market_cache.load()
        qtr_signals = market_cache.get_quarterly_signals()
        as_of = str(price_mat.index[-1])
        ranked = score_universe_point_in_time(
            companies=companies,
            fundamentals_df=fund_df,
            price_matrix=price_mat,
            as_of_date=as_of,
            preset=payload.preset,
            quarterly_signals=qtr_signals,
        )
        plan = build_investment_plan(
            ranked_stocks=ranked,
            lump_sum_inr=payload.lump_sum_inr,
            monthly_sip_inr=payload.monthly_sip_inr,
            horizon_years=payload.horizon_years,
            target_corpus_inr=payload.target_corpus_inr,
            risk_profile=payload.risk_profile,
            max_stocks=payload.max_stocks,
        )
        if payload.save_plan:
            plan_id = db.save_user_plan(int(sess["user_id"]), payload.plan_name, plan)
            plan["saved_plan_id"] = plan_id
        plan["saved_plans"] = db.list_user_plans(int(sess["user_id"]))
        return plan

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    # Strictly bind to localhost (127.0.0.1) — never 0.0.0.0
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=False)
