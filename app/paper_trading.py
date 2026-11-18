"""Paper Trading & Buy-on-Dip Limit Order Domain Engine for ArthaQuant.

Security & Financial Guarantees:
- Zero-IDOR multi-tenancy: every portfolio, order, deposit, cancel, basket, and refresh
  query strictly filters on `user_id = ?`.
- Strictly parameterized SQLite queries inside `BEGIN IMMEDIATE` atomic transactions.
- Ticker allowlist verified against `companies` table (`400` on unknown/disallowed symbols).
- Penny-exact cash reservation (`reserved_cash`) for `OPEN` `LIMIT BUY` (Buy-on-Dip) orders,
  preventing overspending (`cash_balance - reserved_cash`) and refunding excess reservation
  automatically when filled below `limit_price`.
- Injectable `quote_fetcher` with graceful offline fallback to DB prices for deterministic tests.
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import logging
import math
import os
import threading
import time
import urllib.parse
import uuid
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

import httpx

from app.database import Database
from app.factors import PRESET_WEIGHTS, resolve_market_and_index_tag, score_universe_point_in_time
from app.schemas import (
    TICKER_RE,
    PaperDeployBasketRequest,
    PaperOrderRequest,
    PaperPortfolioCreateRequest,
)

logger = logging.getLogger("arthaquant.paper")

FX_USD_INR_SYMBOL = "USDINR=X"
USD_INR_FX = 93.44
LIVE_QUOTE_STALE_SECONDS = 300
BENCHMARK_SYMBOLS: Tuple[str, ...] = ("^NSEI", "^GSPC", "^NDX", FX_USD_INR_SYMBOL)
ALLOWED_MARKET_SCOPES: Tuple[str, ...] = ("ALL", "IN", "US")
UNQUOTED_AGE_SENTINEL_SECONDS = 999999
ATTRIBUTION_RATINGS: Tuple[str, ...] = ("Strong Buy", "Buy", "Hold")
BROWSER_UA = "Mozilla/5.0"

QuoteFetcher = Callable[[List[str]], Dict[str, Dict[str, Any]]]


class PaperTradingError(Exception):
    """Base domain error for Paper Trading operations."""


class PaperNotFoundError(PaperTradingError):
    """Raised when a portfolio or order does not exist for the authenticated user (404)."""


class PaperValidationError(PaperTradingError):
    """Raised when an order, ticker, or balance constraint fails validation (400)."""


def _utc_now_dt() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _utc_now_iso(now_utc: Optional[dt.datetime] = None) -> str:
    ts = now_utc if now_utc is not None else _utc_now_dt()
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=dt.timezone.utc)
    else:
        ts = ts.astimezone(dt.timezone.utc)
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def _utc_today_str(now_utc: Optional[dt.datetime] = None) -> str:
    ts = now_utc if now_utc is not None else _utc_now_dt()
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=dt.timezone.utc)
    else:
        ts = ts.astimezone(dt.timezone.utc)
    return ts.strftime("%Y-%m-%d")


def is_indian_ticker(ticker: str) -> bool:
    """Return True if `ticker` is NSE/BSE Indian equity or `^NSEI` benchmark."""
    tk = (ticker or "").strip().upper()
    return tk == "^NSEI" or tk.endswith(".NS") or tk.endswith(".BO")


def normalize_market_scope(market_scope: Optional[str]) -> str:
    """Validate and normalize `market_scope` into `'ALL' | 'IN' | 'US'`."""
    if market_scope is None:
        return "ALL"
    if not isinstance(market_scope, str):
        raise PaperValidationError("market_scope must be 'ALL', 'IN', or 'US'.")
    cleaned = market_scope.strip().upper()
    if not cleaned:
        return "ALL"
    if cleaned not in ALLOWED_MARKET_SCOPES:
        raise PaperValidationError("market_scope must be 'ALL', 'IN', or 'US'.")
    return cleaned


def matches_market_scope(ticker: str, market_scope: str) -> bool:
    """Return True if `ticker` belongs to `market_scope` (`'ALL' | 'IN' | 'US'`)."""
    if market_scope == "IN":
        return is_indian_ticker(ticker)
    if market_scope == "US":
        return not is_indian_ticker(ticker)
    return True


def benchmarks_for_scope(market_scope: str) -> Tuple[str, ...]:
    """Return benchmark index & FX symbols to refresh for `market_scope`."""
    if market_scope == "IN":
        return ("^NSEI", FX_USD_INR_SYMBOL)
    if market_scope == "US":
        return ("^GSPC", "^NDX", FX_USD_INR_SYMBOL)
    return BENCHMARK_SYMBOLS


def compute_market_session_status(now_utc: Optional[dt.datetime] = None) -> Dict[str, Any]:
    """Compute UTC-based NSE & US market session windows and recommended refresh scope."""
    ts = now_utc if now_utc is not None else _utc_now_dt()
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=dt.timezone.utc)
    else:
        ts = ts.astimezone(dt.timezone.utc)

    is_weekday = 1 <= ts.isoweekday() <= 5
    utc_minutes = ts.hour * 60 + ts.minute
    in_market_open = bool(is_weekday and (3 * 60 + 45) <= utc_minutes <= (10 * 60 + 15))
    us_market_open = bool(is_weekday and (13 * 60 + 30) <= utc_minutes <= (21 * 60 + 15))
    recommended_scope = "IN" if in_market_open else ("US" if us_market_open else "NONE")
    return {
        "in_market_open": in_market_open,
        "us_market_open": us_market_open,
        "recommended_scope": recommended_scope,
    }


def _parse_iso_utc(raw_ts: Optional[str]) -> Optional[dt.datetime]:
    if not raw_ts or not isinstance(raw_ts, str):
        return None
    cleaned = raw_ts.strip()
    if not cleaned:
        return None
    try:
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1] + "+00:00"
        parsed = dt.datetime.fromisoformat(cleaned)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    except ValueError:
        return None


def compute_quotes_meta(
    live_quotes: Dict[str, Dict[str, Any]],
    active_tickers: Optional[Iterable[str]] = None,
    benchmark_ticker: Optional[str] = None,
    has_active_portfolio: bool = False,
    now_utc: Optional[dt.datetime] = None,
) -> Dict[str, Any]:
    """Build `quotes_meta` payload with session status, latest timestamp, and scoped staleness age."""
    ts_now = now_utc if now_utc is not None else _utc_now_dt()
    if ts_now.tzinfo is None:
        ts_now = ts_now.replace(tzinfo=dt.timezone.utc)
    else:
        ts_now = ts_now.astimezone(dt.timezone.utc)

    session = compute_market_session_status(ts_now)
    rec_scope = session["recommended_scope"]
    held_and_order_tks = sorted({str(t).strip().upper() for t in (active_tickers or []) if t and str(t).strip()})

    latest_dt: Optional[dt.datetime] = None
    latest_str: Optional[str] = None
    candidate_for_latest = list(held_and_order_tks)
    if benchmark_ticker:
        candidate_for_latest.append(str(benchmark_ticker).strip().upper())

    if candidate_for_latest:
        for tk in candidate_for_latest:
            q = live_quotes.get(tk)
            u_str = str(q.get("updated_at") or "") if isinstance(q, dict) else ""
            u_dt = _parse_iso_utc(u_str)
            if u_dt is not None and (latest_dt is None or u_dt > latest_dt):
                latest_dt = u_dt
                latest_str = u_str

    if latest_str is None:
        for q in live_quotes.values():
            u_str = str(q.get("updated_at") or "") if isinstance(q, dict) else ""
            u_dt = _parse_iso_utc(u_str)
            if u_dt is not None and (latest_dt is None or u_dt > latest_dt):
                latest_dt = u_dt
                latest_str = u_str

    relevant_age: Optional[int]
    if rec_scope == "NONE" or not has_active_portfolio:
        relevant_age = None
    else:
        scoped_tks = [tk for tk in held_and_order_tks if matches_market_scope(tk, rec_scope)]
        if not scoped_tks:
            scope_bm = "^NSEI" if rec_scope == "IN" else "^GSPC"
            scoped_tks = [scope_bm]

        oldest_dt: Optional[dt.datetime] = None
        missing_quote = False
        for tk in scoped_tks:
            q = live_quotes.get(tk)
            u_str = str(q.get("updated_at") or "") if isinstance(q, dict) else ""
            u_dt = _parse_iso_utc(u_str)
            if u_dt is None:
                missing_quote = True
                break
            if oldest_dt is None or u_dt < oldest_dt:
                oldest_dt = u_dt

        if missing_quote or oldest_dt is None:
            relevant_age = UNQUOTED_AGE_SENTINEL_SECONDS
        else:
            relevant_age = max(0, int(round((ts_now - oldest_dt).total_seconds())))

    return {
        "in_market_open": session["in_market_open"],
        "us_market_open": session["us_market_open"],
        "recommended_scope": rec_scope,
        "latest_quote_updated_at": latest_str,
        "relevant_quote_age_seconds": relevant_age,
    }


def resolve_usd_inr_rate(live_quotes: Optional[Dict[str, Dict[str, Any]]] = None) -> float:
    """Read live `USDINR=X` rate from `paper_live_quotes`, falling back to `USD_INR_FX`."""
    if live_quotes:
        fx_row = live_quotes.get(FX_USD_INR_SYMBOL)
        if isinstance(fx_row, dict):
            try:
                px = float(fx_row.get("close_price") or 0.0)
                if px > 0 and not math.isnan(px):
                    return round(px, 4)
            except (TypeError, ValueError):
                pass
    return USD_INR_FX


def _is_quote_missing_or_stale(
    live_quotes: Dict[str, Dict[str, Any]],
    symbol: str,
    now_utc: dt.datetime,
    max_age_seconds: int = LIVE_QUOTE_STALE_SECONDS,
) -> bool:
    row = live_quotes.get(symbol)
    if not isinstance(row, dict) or float(row.get("close_price") or 0.0) <= 0:
        return True
    u_dt = _parse_iso_utc(str(row.get("updated_at") or ""))
    if u_dt is None:
        return True
    ts_now = now_utc.replace(tzinfo=dt.timezone.utc) if now_utc.tzinfo is None else now_utc.astimezone(dt.timezone.utc)
    return (ts_now - u_dt).total_seconds() > max_age_seconds


def compute_fx_rate(
    native_currency: str,
    portfolio_currency: str,
    usd_inr_rate: Optional[float] = None,
) -> float:
    """Compute conversion multiplier from stock's native currency into portfolio currency."""
    src = (native_currency or "INR").upper()
    dst = (portfolio_currency or "INR").upper()
    if src == dst:
        return 1.0
    eff_rate = (
        float(usd_inr_rate)
        if (usd_inr_rate is not None and float(usd_inr_rate) > 0 and not math.isnan(float(usd_inr_rate)))
        else USD_INR_FX
    )
    if src == "USD" and dst == "INR":
        return eff_rate
    if src == "INR" and dst == "USD":
        return 1.0 / eff_rate
    return 1.0


def compute_buy_cost(
    shares: int,
    price_native: float,
    fx_rate: float,
    fee_bps: float,
) -> Tuple[float, float, float]:
    """Return `(gross_amount, fee_amount, net_debit)` in portfolio currency."""
    gross = round(float(shares) * float(price_native) * float(fx_rate), 2)
    fee = round(gross * (float(fee_bps) / 10000.0), 2)
    total = round(gross + fee, 2)
    return gross, fee, total


def compute_sell_proceeds(
    shares: int,
    price_native: float,
    fx_rate: float,
    fee_bps: float,
) -> Tuple[float, float, float]:
    """Return `(gross_amount, fee_amount, net_credit)` in portfolio currency."""
    gross = round(float(shares) * float(price_native) * float(fx_rate), 2)
    fee = round(gross * (float(fee_bps) / 10000.0), 2)
    net = max(0.0, round(gross - fee, 2))
    return gross, fee, net


def _fetch_single_yahoo_ohlc(client: httpx.Client, symbol: str) -> Optional[Dict[str, Any]]:
    encoded = urllib.parse.quote(symbol, safe="")
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?range=5d&interval=1d"
    try:
        resp = client.get(url)
        if resp.status_code != 200:
            return None
        payload = resp.json()
        results = ((payload or {}).get("chart") or {}).get("result") or []
        if not results:
            return None
        res0 = results[0]
        meta = res0.get("meta") or {}
        gmt_offset = int(meta.get("gmtoffset") or 0)
        tz = dt.timezone(dt.timedelta(seconds=gmt_offset))

        timestamps = res0.get("timestamp") or []
        quotes = (((res0.get("indicators") or {}).get("quote")) or [{}])[0]
        closes = quotes.get("close") or []
        lows = quotes.get("low") or []
        highs = quotes.get("high") or []

        for idx in range(len(timestamps) - 1, -1, -1):
            if idx >= len(closes) or closes[idx] is None:
                continue
            c_val = float(closes[idx])
            if c_val <= 0 or math.isnan(c_val):
                continue
            lo_raw = lows[idx] if idx < len(lows) else None
            hi_raw = highs[idx] if idx < len(highs) else None
            lo_val = float(lo_raw) if lo_raw is not None and float(lo_raw) > 0 and not math.isnan(float(lo_raw)) else c_val
            hi_val = float(hi_raw) if hi_raw is not None and float(hi_raw) > 0 and not math.isnan(float(hi_raw)) else c_val
            lo_val = min(lo_val, c_val)
            hi_val = max(hi_val, c_val)
            t_date = dt.datetime.fromtimestamp(int(timestamps[idx]), tz=tz).date().isoformat()
            return {
                "ticker": symbol,
                "close_price": round(c_val, 2),
                "day_low": round(lo_val, 2),
                "day_high": round(hi_val, 2),
                "trade_date": t_date,
            }
    except Exception as exc:
        logger.debug("Yahoo quote fetch skipped for %s: %s", symbol, type(exc).__name__)
    return None


def fetch_yahoo_chart_quotes(tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    """Fetch latest daily close/low/high from Yahoo Finance `v8/finance/chart` concurrently."""
    unique_syms = sorted({t.strip() for t in tickers if t and t.strip()})
    if not unique_syms:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    try:
        with httpx.Client(headers={"User-Agent": BROWSER_UA}, follow_redirects=True, timeout=6.0) as client:
            max_workers = min(8, len(unique_syms))
            with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
                future_map = {pool.submit(_fetch_single_yahoo_ohlc, client, sym): sym for sym in unique_syms}
                for fut in concurrent.futures.as_completed(future_map):
                    sym = future_map[fut]
                    res = fut.result()
                    if res and res.get("close_price", 0) > 0:
                        out[sym] = res
    except Exception as exc:
        logger.warning("Batch Yahoo live quote refresh unavailable: %s", type(exc).__name__)
    return out


class PaperTradingService:
    """Modular, multi-strategy Paper Trading & Buy-on-Dip engine backed by SQLite."""

    def __init__(
        self,
        db: Database,
        market_cache: Any,
        quote_fetcher: Optional[QuoteFetcher] = None,
        now_utc_fn: Optional[Callable[[], dt.datetime]] = None,
    ) -> None:
        self.db = db
        self.market_cache = market_cache
        self.quote_fetcher: Optional[QuoteFetcher] = quote_fetcher
        self.now_utc_fn: Optional[Callable[[], dt.datetime]] = now_utc_fn
        self._score_lock = threading.Lock()
        self._cached_companies_ref: Optional[object] = None
        self._scores_by_preset: Dict[str, Dict[str, Dict[str, Any]]] = {}

    def _now_utc(self) -> dt.datetime:
        return self.now_utc_fn() if self.now_utc_fn is not None else _utc_now_dt()

    # --- Market Context, Allowlist & Scoring Lookups ---

    def _resolve_tradable_company(self, raw_ticker: str) -> Dict[str, Any]:
        cleaned = (raw_ticker or "").strip().upper()
        if not cleaned or not TICKER_RE.match(cleaned):
            raise PaperValidationError("Invalid or disallowed ticker symbol.")

        comp = self.db.get_company(cleaned)
        resolved = cleaned
        if not comp and not cleaned.endswith((".NS", ".BO")):
            candidate_ns = f"{cleaned}.NS"
            if TICKER_RE.match(candidate_ns):
                comp = self.db.get_company(candidate_ns)
                if comp:
                    resolved = candidate_ns
        if not comp:
            raise PaperValidationError(f"Ticker '{cleaned}' is not in the ArthaQuant universe allowlist.")

        mkt, idx_tag, mkt_label, ccy = resolve_market_and_index_tag(comp)
        return {
            **comp,
            "ticker": resolved,
            "market": mkt,
            "index_tag": idx_tag,
            "market_label": mkt_label,
            "currency": ccy,
        }

    def _get_company_metadata_map(self) -> Dict[str, Dict[str, Any]]:
        companies, _, _, _ = self.market_cache.load()
        out: Dict[str, Dict[str, Any]] = {}
        for comp in companies:
            mkt, idx_tag, mkt_label, ccy = resolve_market_and_index_tag(comp)
            out[comp["ticker"]] = {
                **comp,
                "market": mkt,
                "index_tag": idx_tag,
                "market_label": mkt_label,
                "currency": ccy,
            }
        return out

    def _get_scored_lookup(self, preset: str) -> Dict[str, Dict[str, Any]]:
        eff_preset = preset if preset in PRESET_WEIGHTS else "qglp_compounder"
        companies, fund_df, price_mat, stage1_rows = self.market_cache.load()

        with self._score_lock:
            if companies is not self._cached_companies_ref:
                self._cached_companies_ref = companies
                self._scores_by_preset.clear()
            if eff_preset in self._scores_by_preset:
                return self._scores_by_preset[eff_preset]

        if price_mat.empty:
            return {}

        as_of = str(price_mat.index[-1])
        s1_lookup = {r["ticker"]: r for r in stage1_rows}
        qtr_signals = self.market_cache.get_quarterly_signals()
        street_signals = self.market_cache.get_street_signals()
        scored_list = score_universe_point_in_time(
            companies=companies,
            fundamentals_df=fund_df,
            price_matrix=price_mat,
            as_of_date=as_of,
            preset=eff_preset,
            stage1_lookup=s1_lookup,
            quarterly_signals=qtr_signals,
            street_signals=street_signals,
        )
        by_tk = {s["ticker"]: s for s in scored_list}
        with self._score_lock:
            if companies is self._cached_companies_ref:
                self._scores_by_preset[eff_preset] = by_tk
        return by_tk

    def _get_score_and_rating(self, ticker: str, preset: str) -> Tuple[float, str]:
        by_tk = self._get_scored_lookup(preset)
        sc = by_tk.get(ticker)
        if sc:
            return round(float(sc["composite_score"]), 1), str(sc["rating"])

        _, _, _, stage1_rows = self.market_cache.load()
        s1 = next((r for r in stage1_rows if r["ticker"] == ticker), None)
        if s1:
            s_val = round(float(s1.get("stage1_score") or 50.0), 1)
            rating = "Buy" if s_val >= 75.0 else ("Hold" if s_val >= 45.0 else "Avoid")
            return s_val, rating
        return 50.0, "Hold"

    def _get_baseline_price(self, ticker: str) -> Tuple[float, str]:
        """Return `(close_price, trade_date)` from historical DB/cache (ignoring `paper_live_quotes`)."""
        _, _, price_mat, stage1_rows = self.market_cache.load()
        if not price_mat.empty and ticker in price_mat.columns:
            series = price_mat[ticker].dropna()
            if not series.empty:
                return round(float(series.iloc[-1]), 2), str(series.index[-1])

        row = self.db.get_latest_price_row(ticker)
        if row and float(row["close_price"]) > 0:
            return round(float(row["close_price"]), 2), str(row["trade_date"])

        s1 = next((r for r in stage1_rows if r["ticker"] == ticker), None)
        if s1 and float(s1.get("last_price") or 0.0) > 0:
            return round(float(s1["last_price"]), 2), _utc_today_str()

        if ticker == FX_USD_INR_SYMBOL:
            return USD_INR_FX, _utc_today_str()

        return 0.0, _utc_today_str()

    def _get_quote_snapshot(
        self,
        ticker: str,
        live_quotes: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        quotes_map = live_quotes if live_quotes is not None else self.db.get_paper_live_quotes()
        live = quotes_map.get(ticker)
        if live and float(live.get("close_price") or 0.0) > 0:
            c_px = round(float(live["close_price"]), 2)
            lo_px = round(float(live.get("day_low") or c_px), 2)
            hi_px = round(float(live.get("day_high") or c_px), 2)
            return {
                "ticker": ticker,
                "close_price": c_px,
                "day_low": lo_px,
                "day_high": hi_px,
                "trade_date": str(live.get("trade_date") or _utc_today_str()),
            }

        base_px, base_date = self._get_baseline_price(ticker)
        return {
            "ticker": ticker,
            "close_price": base_px,
            "day_low": base_px,
            "day_high": base_px,
            "trade_date": base_date,
        }

    def _default_snap_date(self, live_quotes: Dict[str, Dict[str, Any]]) -> str:
        if live_quotes:
            dates = [str(q.get("trade_date") or "") for q in live_quotes.values() if q.get("trade_date")]
            if dates:
                return max(dates)
        _, _, price_mat, _ = self.market_cache.load()
        if not price_mat.empty:
            return str(price_mat.index[-1])
        return _utc_today_str()

    # --- Atomic In-Transaction Persistence Helpers ---

    def _record_nav_snapshot_in_tx(
        self,
        conn: Any,
        portfolio_row: Dict[str, Any],
        live_quotes: Dict[str, Dict[str, Any]],
        snap_date_override: Optional[str] = None,
    ) -> Dict[str, Any]:
        pf_id = str(portfolio_row["id"])
        pf_ccy = str(portfolio_row["currency"])
        bm_tk = str(portfolio_row["benchmark_ticker"] or ("^NSEI" if pf_ccy == "INR" else "^GSPC"))

        pos_rows = conn.execute(
            "SELECT ticker, shares, native_currency FROM paper_positions WHERE portfolio_id = ? AND shares > 0",
            (pf_id,),
        ).fetchall()

        usd_inr_rate = resolve_usd_inr_rate(live_quotes)
        holdings_val = 0.0
        for p in pos_rows:
            q = self._get_quote_snapshot(str(p["ticker"]), live_quotes)
            fx = compute_fx_rate(str(p["native_currency"]), pf_ccy, usd_inr_rate=usd_inr_rate)
            holdings_val += round(int(p["shares"]) * float(q["close_price"]) * fx, 2)
        holdings_val = round(holdings_val, 2)

        cash_bal = round(float(portfolio_row["cash_balance"]), 2)
        tot_dep = round(float(portfolio_row["total_deposited"]), 2)
        tot_nav = round(cash_bal + holdings_val, 2)
        ret_pct = round(((tot_nav - tot_dep) / tot_dep) * 100.0, 2) if tot_dep > 0 else 0.0

        bm_quote = self._get_quote_snapshot(bm_tk, live_quotes)
        bm_close = round(float(bm_quote["close_price"] or 0.0), 2)
        snap_date = snap_date_override or self._default_snap_date(live_quotes)

        first_nav = conn.execute(
            """
            SELECT snap_date, benchmark_close
            FROM paper_nav_history
            WHERE portfolio_id = ?
            ORDER BY snap_date ASC
            LIMIT 1
            """,
            (pf_id,),
        ).fetchone()

        bm_ret_pct = 0.0
        if first_nav and str(first_nav["snap_date"]) < snap_date and float(first_nav["benchmark_close"]) > 0 and bm_close > 0:
            base_bm = float(first_nav["benchmark_close"])
            bm_ret_pct = round(((bm_close - base_bm) / base_bm) * 100.0, 2)
        elif first_nav and str(first_nav["snap_date"]) == snap_date and bm_close > 0:
            base_db_bm, _ = self._get_baseline_price(bm_tk)
            if base_db_bm > 0 and abs(bm_close - base_db_bm) > 1e-6:
                bm_ret_pct = round(((bm_close - base_db_bm) / base_db_bm) * 100.0, 2)

        conn.execute(
            """
            INSERT INTO paper_nav_history (
                portfolio_id, snap_date, cash_balance, holdings_value, total_nav,
                total_deposited, return_pct, benchmark_close, benchmark_return_pct
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(portfolio_id, snap_date) DO UPDATE SET
                cash_balance = excluded.cash_balance,
                holdings_value = excluded.holdings_value,
                total_nav = excluded.total_nav,
                total_deposited = excluded.total_deposited,
                return_pct = excluded.return_pct,
                benchmark_close = excluded.benchmark_close,
                benchmark_return_pct = excluded.benchmark_return_pct
            """,
            (pf_id, snap_date, cash_bal, holdings_val, tot_nav, tot_dep, ret_pct, bm_close, bm_ret_pct),
        )
        return {
            "snap_date": snap_date,
            "cash_balance": cash_bal,
            "holdings_value": holdings_val,
            "total_nav": tot_nav,
            "total_deposited": tot_dep,
            "return_pct": ret_pct,
            "benchmark_close": bm_close,
            "benchmark_return_pct": bm_ret_pct,
        }

    def _execute_buy_fill_in_tx(
        self,
        conn: Any,
        portfolio: Dict[str, Any],
        user_id: str,
        ticker: str,
        native_currency: str,
        shares: int,
        exec_price_native: float,
        order_type: str,
        limit_price: Optional[float],
        score_val: float,
        rating_val: str,
        note: str,
        now_iso: str,
        existing_order_id: Optional[str] = None,
        released_reservation: float = 0.0,
        usd_inr_rate: Optional[float] = None,
    ) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
        pf_id = str(portfolio["id"])
        pf_ccy = str(portfolio["currency"])
        fee_bps = float(portfolio["fee_bps"])
        fx = compute_fx_rate(native_currency, pf_ccy, usd_inr_rate=usd_inr_rate)
        gross, fee, net_debit = compute_buy_cost(shares, exec_price_native, fx, fee_bps)

        cur_cash = round(float(portfolio["cash_balance"]), 2)
        cur_res = max(0.0, round(float(portfolio["reserved_cash"]) - float(released_reservation), 2))
        avail_cash = round(cur_cash - cur_res, 2)
        if avail_cash + 1e-9 < net_debit:
            raise PaperValidationError(
                f"Insufficient available cash for {ticker}: required {net_debit:.2f} {pf_ccy}, available {avail_cash:.2f} {pf_ccy}."
            )

        new_cash = max(0.0, round(cur_cash - net_debit, 2))
        conn.execute(
            "UPDATE paper_portfolios SET cash_balance = ?, reserved_cash = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            (new_cash, cur_res, now_iso, pf_id, user_id),
        )
        updated_pf = {**portfolio, "cash_balance": new_cash, "reserved_cash": cur_res, "updated_at": now_iso}

        pos_row = conn.execute(
            "SELECT shares, avg_cost, entry_score, entry_rating FROM paper_positions WHERE portfolio_id = ? AND ticker = ?",
            (pf_id, ticker),
        ).fetchone()
        if pos_row and int(pos_row["shares"]) > 0:
            old_sh = int(pos_row["shares"])
            old_avg = float(pos_row["avg_cost"])
            new_sh = old_sh + shares
            new_avg = round(((old_sh * old_avg) + (shares * exec_price_native)) / new_sh, 4)
            keep_score = float(pos_row["entry_score"])
            keep_rating = str(pos_row["entry_rating"])
            conn.execute(
                """
                UPDATE paper_positions
                SET shares = ?, avg_cost = ?, updated_at = ?
                WHERE portfolio_id = ? AND ticker = ?
                """,
                (new_sh, new_avg, now_iso, pf_id, ticker),
            )
        else:
            conn.execute(
                """
                INSERT INTO paper_positions (
                    portfolio_id, ticker, shares, avg_cost, native_currency,
                    entry_score, entry_rating, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(portfolio_id, ticker) DO UPDATE SET
                    shares = excluded.shares,
                    avg_cost = excluded.avg_cost,
                    native_currency = excluded.native_currency,
                    entry_score = excluded.entry_score,
                    entry_rating = excluded.entry_rating,
                    updated_at = excluded.updated_at
                """,
                (pf_id, ticker, shares, round(exec_price_native, 4), native_currency, score_val, rating_val, now_iso),
            )

        if existing_order_id:
            ord_id = existing_order_id
            conn.execute(
                """
                UPDATE paper_orders
                SET status = 'FILLED', reserved_amount = 0, filled_at = ?, filled_price = ?
                WHERE id = ? AND user_id = ?
                """,
                (now_iso, round(exec_price_native, 2), ord_id, user_id),
            )
        else:
            ord_id = f"ord_{uuid.uuid4().hex[:14]}"
            conn.execute(
                """
                INSERT INTO paper_orders (
                    id, portfolio_id, user_id, ticker, side, order_type, shares,
                    limit_price, reserved_amount, status, score_at_order, rating_at_order,
                    note, created_at, filled_at, filled_price
                ) VALUES (?, ?, ?, ?, 'BUY', ?, ?, ?, 0, 'FILLED', ?, ?, ?, ?, ?, ?)
                """,
                (
                    ord_id,
                    pf_id,
                    user_id,
                    ticker,
                    order_type,
                    shares,
                    round(limit_price, 2) if limit_price is not None else None,
                    score_val,
                    rating_val,
                    note,
                    now_iso,
                    now_iso,
                    round(exec_price_native, 2),
                ),
            )

        trd_id = f"trd_{uuid.uuid4().hex[:14]}"
        conn.execute(
            """
            INSERT INTO paper_trades (
                id, portfolio_id, order_id, ticker, side, shares,
                exec_price_native, fx_rate, gross_amount, fee_amount, net_amount,
                realized_pnl, score_at_trade, rating_at_trade, executed_at
            ) VALUES (?, ?, ?, ?, 'BUY', ?, ?, ?, ?, ?, ?, 0.0, ?, ?, ?)
            """,
            (
                trd_id,
                pf_id,
                ord_id,
                ticker,
                shares,
                round(exec_price_native, 2),
                round(fx, 6),
                gross,
                fee,
                net_debit,
                score_val,
                rating_val,
                now_iso,
            ),
        )

        order_dict = {
            "id": ord_id,
            "portfolio_id": pf_id,
            "ticker": ticker,
            "side": "BUY",
            "order_type": order_type,
            "shares": shares,
            "limit_price": round(limit_price, 2) if limit_price is not None else None,
            "reserved_amount": 0.0,
            "status": "FILLED",
            "score_at_order": score_val,
            "rating_at_order": rating_val,
            "note": note,
            "created_at": now_iso,
            "filled_at": now_iso,
            "filled_price": round(exec_price_native, 2),
        }
        trade_dict = {
            "id": trd_id,
            "portfolio_id": pf_id,
            "order_id": ord_id,
            "ticker": ticker,
            "side": "BUY",
            "order_type": order_type,
            "shares": shares,
            "exec_price_native": round(exec_price_native, 2),
            "native_currency": native_currency,
            "fx_rate": round(fx, 6),
            "gross_amount": gross,
            "fee_amount": fee,
            "net_amount": net_debit,
            "realized_pnl": 0.0,
            "score_at_trade": score_val,
            "rating_at_trade": rating_val,
            "executed_at": now_iso,
        }
        return updated_pf, order_dict, trade_dict

    def _execute_sell_fill_in_tx(
        self,
        conn: Any,
        portfolio: Dict[str, Any],
        user_id: str,
        ticker: str,
        native_currency: str,
        shares: int,
        exec_price_native: float,
        order_type: str,
        limit_price: Optional[float],
        score_val: float,
        rating_val: str,
        note: str,
        now_iso: str,
        existing_order_id: Optional[str] = None,
        usd_inr_rate: Optional[float] = None,
    ) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
        pf_id = str(portfolio["id"])
        pf_ccy = str(portfolio["currency"])
        fee_bps = float(portfolio["fee_bps"])
        fx = compute_fx_rate(native_currency, pf_ccy, usd_inr_rate=usd_inr_rate)

        pos_row = conn.execute(
            "SELECT shares, avg_cost FROM paper_positions WHERE portfolio_id = ? AND ticker = ?",
            (pf_id, ticker),
        ).fetchone()
        owned_sh = int(pos_row["shares"]) if pos_row else 0
        if existing_order_id:
            sellable_sh = owned_sh
        else:
            enc_row = conn.execute(
                """
                SELECT COALESCE(SUM(shares), 0) AS locked
                FROM paper_orders
                WHERE portfolio_id = ? AND ticker = ? AND side = 'SELL' AND status = 'OPEN'
                """,
                (pf_id, ticker),
            ).fetchone()
            locked_sh = int(enc_row["locked"]) if enc_row else 0
            sellable_sh = owned_sh - locked_sh

        if shares > sellable_sh:
            raise PaperValidationError(
                f"Insufficient unencumbered shares to sell for {ticker}: requested {shares}, sellable {max(0, sellable_sh)}."
            )

        avg_cost = float(pos_row["avg_cost"])
        gross, fee, net_credit = compute_sell_proceeds(shares, exec_price_native, fx, fee_bps)
        cost_basis = round(shares * avg_cost * fx, 2)
        realized_pnl = round(net_credit - cost_basis, 2)

        new_cash = round(float(portfolio["cash_balance"]) + net_credit, 2)
        conn.execute(
            "UPDATE paper_portfolios SET cash_balance = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            (new_cash, now_iso, pf_id, user_id),
        )
        updated_pf = {**portfolio, "cash_balance": new_cash, "updated_at": now_iso}

        rem_sh = owned_sh - shares
        if rem_sh <= 0:
            conn.execute(
                "DELETE FROM paper_positions WHERE portfolio_id = ? AND ticker = ?",
                (pf_id, ticker),
            )
        else:
            conn.execute(
                "UPDATE paper_positions SET shares = ?, updated_at = ? WHERE portfolio_id = ? AND ticker = ?",
                (rem_sh, now_iso, pf_id, ticker),
            )

        if existing_order_id:
            ord_id = existing_order_id
            conn.execute(
                """
                UPDATE paper_orders
                SET status = 'FILLED', filled_at = ?, filled_price = ?
                WHERE id = ? AND user_id = ?
                """,
                (now_iso, round(exec_price_native, 2), ord_id, user_id),
            )
        else:
            ord_id = f"ord_{uuid.uuid4().hex[:14]}"
            conn.execute(
                """
                INSERT INTO paper_orders (
                    id, portfolio_id, user_id, ticker, side, order_type, shares,
                    limit_price, reserved_amount, status, score_at_order, rating_at_order,
                    note, created_at, filled_at, filled_price
                ) VALUES (?, ?, ?, ?, 'SELL', ?, ?, ?, 0, 'FILLED', ?, ?, ?, ?, ?, ?)
                """,
                (
                    ord_id,
                    pf_id,
                    user_id,
                    ticker,
                    order_type,
                    shares,
                    round(limit_price, 2) if limit_price is not None else None,
                    score_val,
                    rating_val,
                    note,
                    now_iso,
                    now_iso,
                    round(exec_price_native, 2),
                ),
            )

        trd_id = f"trd_{uuid.uuid4().hex[:14]}"
        conn.execute(
            """
            INSERT INTO paper_trades (
                id, portfolio_id, order_id, ticker, side, shares,
                exec_price_native, fx_rate, gross_amount, fee_amount, net_amount,
                realized_pnl, score_at_trade, rating_at_trade, executed_at
            ) VALUES (?, ?, ?, ?, 'SELL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                trd_id,
                pf_id,
                ord_id,
                ticker,
                shares,
                round(exec_price_native, 2),
                round(fx, 6),
                gross,
                fee,
                net_credit,
                realized_pnl,
                score_val,
                rating_at_trade := rating_val,
                now_iso,
            ),
        )

        order_dict = {
            "id": ord_id,
            "portfolio_id": pf_id,
            "ticker": ticker,
            "side": "SELL",
            "order_type": order_type,
            "shares": shares,
            "limit_price": round(limit_price, 2) if limit_price is not None else None,
            "reserved_amount": 0.0,
            "status": "FILLED",
            "score_at_order": score_val,
            "rating_at_order": rating_at_trade,
            "note": note,
            "created_at": now_iso,
            "filled_at": now_iso,
            "filled_price": round(exec_price_native, 2),
        }
        trade_dict = {
            "id": trd_id,
            "portfolio_id": pf_id,
            "order_id": ord_id,
            "ticker": ticker,
            "side": "SELL",
            "order_type": order_type,
            "shares": shares,
            "exec_price_native": round(exec_price_native, 2),
            "native_currency": native_currency,
            "fx_rate": round(fx, 6),
            "gross_amount": gross,
            "fee_amount": fee,
            "net_amount": net_credit,
            "realized_pnl": realized_pnl,
            "score_at_trade": score_val,
            "rating_at_trade": rating_at_trade,
            "executed_at": now_iso,
        }
        return updated_pf, order_dict, trade_dict

    def _queue_open_limit_buy_in_tx(
        self,
        conn: Any,
        portfolio: Dict[str, Any],
        user_id: str,
        ticker: str,
        native_currency: str,
        shares: int,
        limit_price: float,
        score_val: float,
        rating_val: str,
        note: str,
        now_iso: str,
        usd_inr_rate: Optional[float] = None,
    ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        pf_id = str(portfolio["id"])
        pf_ccy = str(portfolio["currency"])
        fee_bps = float(portfolio["fee_bps"])
        fx = compute_fx_rate(native_currency, pf_ccy, usd_inr_rate=usd_inr_rate)
        _, _, reserved_amt = compute_buy_cost(shares, limit_price, fx, fee_bps)

        cur_cash = round(float(portfolio["cash_balance"]), 2)
        cur_res = round(float(portfolio["reserved_cash"]), 2)
        avail_cash = round(cur_cash - cur_res, 2)
        if avail_cash + 1e-9 < reserved_amt:
            raise PaperValidationError(
                f"Insufficient available cash to reserve LIMIT BUY on {ticker}: required {reserved_amt:.2f} {pf_ccy}, available {avail_cash:.2f} {pf_ccy}."
            )

        new_res = round(cur_res + reserved_amt, 2)
        conn.execute(
            "UPDATE paper_portfolios SET reserved_cash = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            (new_res, now_iso, pf_id, user_id),
        )
        updated_pf = {**portfolio, "reserved_cash": new_res, "updated_at": now_iso}

        ord_id = f"ord_{uuid.uuid4().hex[:14]}"
        conn.execute(
            """
            INSERT INTO paper_orders (
                id, portfolio_id, user_id, ticker, side, order_type, shares,
                limit_price, reserved_amount, status, score_at_order, rating_at_order,
                note, created_at, filled_at, filled_price
            ) VALUES (?, ?, ?, ?, 'BUY', 'LIMIT', ?, ?, ?, 'OPEN', ?, ?, ?, ?, NULL, NULL)
            """,
            (
                ord_id,
                pf_id,
                user_id,
                ticker,
                shares,
                round(limit_price, 2),
                reserved_amt,
                score_val,
                rating_val,
                note,
                now_iso,
            ),
        )
        order_dict = {
            "id": ord_id,
            "portfolio_id": pf_id,
            "ticker": ticker,
            "side": "BUY",
            "order_type": "LIMIT",
            "shares": shares,
            "limit_price": round(limit_price, 2),
            "reserved_amount": reserved_amt,
            "status": "OPEN",
            "score_at_order": score_val,
            "rating_at_order": rating_val,
            "note": note,
            "created_at": now_iso,
            "filled_at": None,
            "filled_price": None,
        }
        return updated_pf, order_dict

    # --- Public Read & Overview Builder ---

    def get_overview(
        self,
        user_id: str,
        username: str,
        portfolio_id: Optional[str] = None,
        now_utc: Optional[dt.datetime] = None,
    ) -> Dict[str, Any]:
        clean_pf_id = (portfolio_id or "").strip() or None
        live_quotes = self.db.get_paper_live_quotes()
        usd_inr_rate = resolve_usd_inr_rate(live_quotes)
        fx_usd_inr_out = round(usd_inr_rate, 2)
        comp_meta = self._get_company_metadata_map()
        eff_now_utc = now_utc if now_utc is not None else self._now_utc()
        active_tracked_tks: List[str] = []
        active_bm_tk: Optional[str] = None

        with self.db.connect() as conn:
            if clean_pf_id:
                owned_check = conn.execute(
                    "SELECT id FROM paper_portfolios WHERE id = ? AND user_id = ?",
                    (clean_pf_id, user_id),
                ).fetchone()
                if not owned_check:
                    raise PaperNotFoundError("Paper portfolio not found.")

            pf_rows = conn.execute(
                """
                SELECT id, user_id, name, currency, strategy_preset, benchmark_ticker,
                       cash_balance, reserved_cash, total_deposited, fee_bps, created_at, updated_at
                FROM paper_portfolios
                WHERE user_id = ?
                ORDER BY created_at ASC, id ASC
                """,
                (user_id,),
            ).fetchall()

            portfolios_summary: List[Dict[str, Any]] = []
            active_detail: Optional[Dict[str, Any]] = None
            target_id = clean_pf_id or (str(pf_rows[0]["id"]) if pf_rows else None)

            for r in pf_rows:
                pf = dict(r)
                pf_id = str(pf["id"])
                pf_ccy = str(pf["currency"])
                preset = str(pf["strategy_preset"] or "qglp_compounder")
                bm_tk = str(pf["benchmark_ticker"] or ("^NSEI" if pf_ccy == "INR" else "^GSPC"))

                pos_rows = conn.execute(
                    """
                    SELECT portfolio_id, ticker, shares, avg_cost, native_currency,
                           entry_score, entry_rating, updated_at
                    FROM paper_positions
                    WHERE portfolio_id = ? AND shares > 0
                    ORDER BY ticker ASC
                    """,
                    (pf_id,),
                ).fetchall()

                open_ord_rows = conn.execute(
                    """
                    SELECT id, portfolio_id, ticker, side, order_type, shares, limit_price,
                           reserved_amount, status, score_at_order, rating_at_order, note, created_at
                    FROM paper_orders
                    WHERE portfolio_id = ? AND user_id = ? AND status = 'OPEN'
                    ORDER BY created_at DESC, id DESC
                    """,
                    (pf_id, user_id),
                ).fetchall()

                nav_rows = conn.execute(
                    """
                    SELECT snap_date, cash_balance, holdings_value, total_nav,
                           total_deposited, return_pct, benchmark_close, benchmark_return_pct
                    FROM paper_nav_history
                    WHERE portfolio_id = ?
                    ORDER BY snap_date ASC
                    """,
                    (pf_id,),
                ).fetchall()

                # Compute live holdings value
                holdings_val = 0.0
                for p in pos_rows:
                    q = self._get_quote_snapshot(str(p["ticker"]), live_quotes)
                    fx = compute_fx_rate(str(p["native_currency"]), pf_ccy, usd_inr_rate=usd_inr_rate)
                    holdings_val += round(int(p["shares"]) * float(q["close_price"]) * fx, 2)
                holdings_val = round(holdings_val, 2)

                cash_bal = round(float(pf["cash_balance"]), 2)
                res_cash = round(float(pf["reserved_cash"]), 2)
                avail_cash = max(0.0, round(cash_bal - res_cash, 2))
                tot_dep = round(float(pf["total_deposited"]), 2)
                tot_nav = round(cash_bal + holdings_val, 2)
                net_ret_amt = round(tot_nav - tot_dep, 2)
                ret_pct = round((net_ret_amt / tot_dep) * 100.0, 2) if tot_dep > 0 else 0.0

                bm_ret_pct = float(nav_rows[-1]["benchmark_return_pct"]) if nav_rows else 0.0
                if nav_rows and len(nav_rows) >= 1:
                    first_bm = float(nav_rows[0]["benchmark_close"])
                    cur_bm = float(self._get_quote_snapshot(bm_tk, live_quotes)["close_price"] or 0.0)
                    if first_bm > 0 and cur_bm > 0 and abs(cur_bm - first_bm) > 1e-6:
                        bm_ret_pct = round(((cur_bm - first_bm) / first_bm) * 100.0, 2)
                alpha_pct = round(ret_pct - bm_ret_pct, 2)

                summary_card = {
                    "id": pf_id,
                    "name": str(pf["name"]),
                    "currency": pf_ccy,
                    "strategy_preset": preset,
                    "benchmark_ticker": bm_tk,
                    "cash_balance": cash_bal,
                    "reserved_cash": res_cash,
                    "available_cash": avail_cash,
                    "holdings_value": holdings_val,
                    "total_nav": tot_nav,
                    "total_deposited": tot_dep,
                    "net_return_amount": net_ret_amt,
                    "total_return_amt": net_ret_amt,
                    "return_pct": ret_pct,
                    "benchmark_return_pct": bm_ret_pct,
                    "alpha_pct": alpha_pct,
                    "positions_count": len(pos_rows),
                    "open_orders_count": len(open_ord_rows),
                    "fee_bps": float(pf["fee_bps"]),
                    "created_at": str(pf["created_at"]),
                    "updated_at": str(pf["updated_at"]),
                }
                portfolios_summary.append(summary_card)

                if pf_id != target_id:
                    continue

                # Build full active_portfolio detail
                locked_sell_by_tk: Dict[str, int] = {}
                for o in open_ord_rows:
                    if str(o["side"]) == "SELL":
                        tk_s = str(o["ticker"])
                        locked_sell_by_tk[tk_s] = locked_sell_by_tk.get(tk_s, 0) + int(o["shares"])

                positions_out: List[Dict[str, Any]] = []
                for p in pos_rows:
                    tk = str(p["ticker"])
                    meta = comp_meta.get(tk) or {}
                    native_ccy = str(p["native_currency"] or meta.get("currency") or "INR")
                    fx = compute_fx_rate(native_ccy, pf_ccy, usd_inr_rate=usd_inr_rate)
                    q = self._get_quote_snapshot(tk, live_quotes)
                    live_px = round(float(q["close_price"]), 2)
                    sh = int(p["shares"])
                    sellable_sh = max(0, sh - locked_sell_by_tk.get(tk, 0))
                    avg_c = round(float(p["avg_cost"]), 2)

                    invested = round(sh * float(p["avg_cost"]) * fx, 2)
                    mkt_val = round(sh * live_px * fx, 2)
                    unrl_pnl = round(mkt_val - invested, 2)
                    unrl_pct = round((unrl_pnl / invested) * 100.0, 2) if invested > 0 else 0.0
                    wt_pct = round((mkt_val / tot_nav) * 100.0, 2) if tot_nav > 0 else 0.0

                    cur_score, cur_rating = self._get_score_and_rating(tk, preset)
                    ent_score = round(float(p["entry_score"]), 1)
                    ent_rating = str(p["entry_rating"])

                    positions_out.append(
                        {
                            "portfolio_id": pf_id,
                            "ticker": tk,
                            "name": str(meta.get("name") or tk),
                            "sector": str(meta.get("sector") or "Diversified"),
                            "market": str(meta.get("market") or ("IN" if native_ccy == "INR" else "US")),
                            "index_tag": str(meta.get("index_tag") or ("NIFTY200" if native_ccy == "INR" else "NASDAQ100")),
                            "market_label": str(meta.get("market_label") or ("NSE India" if native_ccy == "INR" else "US Equity")),
                            "native_currency": native_ccy,
                            "shares": sh,
                            "sellable_shares": sellable_sh,
                            "avg_cost": avg_c,
                            "live_price": live_px,
                            "current_price": live_px,
                            "fx_rate": round(fx, 6),
                            "cost_basis": invested,
                            "invested_value": invested,
                            "market_value": mkt_val,
                            "unrealized_pnl": unrl_pnl,
                            "unrealized_pnl_pct": unrl_pct,
                            "weight_pct": wt_pct,
                            "entry_score": ent_score,
                            "entry_rating": ent_rating,
                            "current_score": cur_score,
                            "current_rating": cur_rating,
                            "score_delta": round(cur_score - ent_score, 1),
                            "updated_at": str(p["updated_at"]),
                        }
                    )

                positions_out.sort(key=lambda item: item["market_value"], reverse=True)

                best_pick: Optional[Dict[str, Any]] = None
                if positions_out:
                    top_pos = max(positions_out, key=lambda item: item["unrealized_pnl_pct"])
                    best_pick = {
                        "ticker": top_pos["ticker"],
                        "name": top_pos["name"],
                        "unrealized_pnl": top_pos["unrealized_pnl"],
                        "unrealized_pnl_pct": top_pos["unrealized_pnl_pct"],
                    }

                open_orders_out: List[Dict[str, Any]] = []
                for o in open_ord_rows:
                    tk = str(o["ticker"])
                    meta = comp_meta.get(tk) or {}
                    native_ccy = str(meta.get("currency") or ("INR" if tk.endswith((".NS", ".BO")) else "USD"))
                    q = self._get_quote_snapshot(tk, live_quotes)
                    cur_px = round(float(q["close_price"]), 2)
                    lim_px = round(float(o["limit_price"]), 2) if o["limit_price"] is not None else None
                    dist_pct = (
                        round(((lim_px - cur_px) / cur_px) * 100.0, 2)
                        if (lim_px is not None and cur_px > 0)
                        else 0.0
                    )
                    open_orders_out.append(
                        {
                            "id": str(o["id"]),
                            "portfolio_id": pf_id,
                            "ticker": tk,
                            "name": str(meta.get("name") or tk),
                            "index_tag": str(meta.get("index_tag") or ("NIFTY200" if native_ccy == "INR" else "NASDAQ100")),
                            "native_currency": native_ccy,
                            "side": str(o["side"]),
                            "order_type": str(o["order_type"]),
                            "shares": int(o["shares"]),
                            "limit_price": lim_px,
                            "live_price": cur_px,
                            "current_price": cur_px,
                            "distance_pct": dist_pct,
                            "reserved_amount": round(float(o["reserved_amount"] or 0.0), 2),
                            "status": str(o["status"]),
                            "score_at_order": round(float(o["score_at_order"] or 0.0), 1) if o["score_at_order"] is not None else None,
                            "rating_at_order": str(o["rating_at_order"] or ""),
                            "note": str(o["note"] or ""),
                            "created_at": str(o["created_at"]),
                        }
                    )

                trade_rows = conn.execute(
                    """
                    SELECT t.id, t.portfolio_id, t.order_id, t.ticker, t.side, t.shares,
                           t.exec_price_native, t.fx_rate, t.gross_amount, t.fee_amount,
                           t.net_amount, t.realized_pnl, t.score_at_trade, t.rating_at_trade,
                           t.executed_at, COALESCE(o.order_type, 'MARKET') AS order_type
                    FROM paper_trades t
                    LEFT JOIN paper_orders o ON o.id = t.order_id
                    WHERE t.portfolio_id = ?
                    ORDER BY t.executed_at DESC, t.rowid DESC
                    LIMIT 100
                    """,
                    (pf_id,),
                ).fetchall()

                recent_trades_out: List[Dict[str, Any]] = []
                for tr in trade_rows:
                    tk = str(tr["ticker"])
                    meta = comp_meta.get(tk) or {}
                    native_ccy = str(meta.get("currency") or ("INR" if tk.endswith((".NS", ".BO")) else "USD"))
                    recent_trades_out.append(
                        {
                            "id": str(tr["id"]),
                            "portfolio_id": pf_id,
                            "order_id": str(tr["order_id"]) if tr["order_id"] else None,
                            "ticker": tk,
                            "name": str(meta.get("name") or tk),
                            "index_tag": str(meta.get("index_tag") or ("NIFTY200" if native_ccy == "INR" else "NASDAQ100")),
                            "native_currency": native_ccy,
                            "side": str(tr["side"]),
                            "order_type": str(tr["order_type"] or "MARKET"),
                            "shares": int(tr["shares"]),
                            "exec_price_native": round(float(tr["exec_price_native"]), 2),
                            "fx_rate": round(float(tr["fx_rate"]), 6),
                            "gross_amount": round(float(tr["gross_amount"]), 2),
                            "fee_amount": round(float(tr["fee_amount"]), 2),
                            "net_amount": round(float(tr["net_amount"]), 2),
                            "realized_pnl": round(float(tr["realized_pnl"]), 2),
                            "score_at_trade": round(float(tr["score_at_trade"]), 1) if tr["score_at_trade"] is not None else None,
                            "rating_at_trade": str(tr["rating_at_trade"] or ""),
                            "executed_at": str(tr["executed_at"]),
                        }
                    )

                nav_history_out: List[Dict[str, Any]] = []
                for nr in nav_rows:
                    r_pct = round(float(nr["return_pct"]), 2)
                    b_pct = round(float(nr["benchmark_return_pct"]), 2)
                    nav_history_out.append(
                        {
                            "snap_date": str(nr["snap_date"]),
                            "cash_balance": round(float(nr["cash_balance"]), 2),
                            "holdings_value": round(float(nr["holdings_value"]), 2),
                            "total_nav": round(float(nr["total_nav"]), 2),
                            "total_deposited": round(float(nr["total_deposited"]), 2),
                            "return_pct": r_pct,
                            "benchmark_close": round(float(nr["benchmark_close"]), 2),
                            "benchmark_return_pct": b_pct,
                            "portfolio_indexed": round(100.0 * (1.0 + r_pct / 100.0), 2),
                            "benchmark_indexed": round(100.0 * (1.0 + b_pct / 100.0), 2),
                        }
                    )

                # Group open positions by entry_rating for attribution scorecard
                bucket_map: Dict[str, Dict[str, Any]] = {
                    rt: {"rating": rt, "count": 0, "invested": 0.0, "current_value": 0.0}
                    for rt in ATTRIBUTION_RATINGS
                }
                for pos in positions_out:
                    rt = pos["entry_rating"]
                    if rt not in bucket_map:
                        bucket_map[rt] = {"rating": rt, "count": 0, "invested": 0.0, "current_value": 0.0}
                    bucket_map[rt]["count"] += 1
                    bucket_map[rt]["invested"] = round(bucket_map[rt]["invested"] + pos["invested_value"], 2)
                    bucket_map[rt]["current_value"] = round(bucket_map[rt]["current_value"] + pos["market_value"], 2)

                attribution_out: List[Dict[str, Any]] = []
                for rt, b in bucket_map.items():
                    inv = b["invested"]
                    cur_v = b["current_value"]
                    pnl = round(cur_v - inv, 2)
                    r_p = round((pnl / inv) * 100.0, 2) if inv > 0 else 0.0
                    attribution_out.append(
                        {
                            "rating": rt,
                            "count": b["count"],
                            "invested": inv,
                            "current_value": cur_v,
                            "pnl_amount": pnl,
                            "unrealized_pnl": pnl,
                            "return_pct": r_p,
                        }
                    )

                active_tracked_tks = [p["ticker"] for p in positions_out] + [o["ticker"] for o in open_orders_out]
                active_bm_tk = bm_tk

                active_detail = {
                    **summary_card,
                    "best_pick": best_pick,
                    "positions": positions_out,
                    "open_orders": open_orders_out,
                    "recent_trades": recent_trades_out,
                    "nav_history": nav_history_out,
                    "attribution_by_rating": attribution_out,
                }

        quotes_meta = compute_quotes_meta(
            live_quotes=live_quotes,
            active_tickers=active_tracked_tks,
            benchmark_ticker=active_bm_tk,
            has_active_portfolio=active_detail is not None,
            now_utc=eff_now_utc,
        )
        if active_detail is not None:
            active_detail["quotes_meta"] = quotes_meta
            active_detail["fx_usd_inr"] = fx_usd_inr_out

        return {
            "authenticated": True,
            "user": {
                "id": user_id,
                "username": username,
                "email": username,
                "email_or_username": username,
            },
            "portfolios": portfolios_summary,
            "active_portfolio": active_detail,
            "quotes_meta": quotes_meta,
            "fx_usd_inr": fx_usd_inr_out,
        }

    def _normalize_and_upsert_symbols(
        self,
        symbols: List[str],
        fetched_raw: Dict[str, Dict[str, Any]],
        existing_live: Dict[str, Dict[str, Any]],
        now_iso: str,
        today_str: str,
    ) -> int:
        normalized: List[Dict[str, Any]] = []
        for sym in symbols:
            raw_q = fetched_raw.get(sym)
            if isinstance(raw_q, dict):
                c_raw = raw_q.get("close_price") if raw_q.get("close_price") is not None else raw_q.get("close")
                if c_raw is not None and float(c_raw) > 0:
                    c_px = round(float(c_raw), 2)
                    lo_raw = raw_q.get("day_low") if raw_q.get("day_low") is not None else raw_q.get("low")
                    hi_raw = raw_q.get("day_high") if raw_q.get("day_high") is not None else raw_q.get("high")
                    lo_px = round(float(lo_raw), 2) if lo_raw is not None and float(lo_raw) > 0 else c_px
                    hi_px = round(float(hi_raw), 2) if hi_raw is not None and float(hi_raw) > 0 else c_px
                    lo_px = min(lo_px, c_px)
                    hi_px = max(hi_px, c_px)
                    t_date = str(raw_q.get("trade_date") or raw_q.get("date") or today_str)
                    normalized.append(
                        {
                            "ticker": sym,
                            "close_price": c_px,
                            "day_low": lo_px,
                            "day_high": hi_px,
                            "trade_date": t_date,
                            "updated_at": now_iso,
                        }
                    )
                    continue
            if sym not in existing_live:
                base_px, base_date = self._get_baseline_price(sym)
                if base_px > 0:
                    normalized.append(
                        {
                            "ticker": sym,
                            "close_price": base_px,
                            "day_low": base_px,
                            "day_high": base_px,
                            "trade_date": base_date,
                            "updated_at": now_iso,
                        }
                    )
        return self.db.upsert_paper_live_quotes(normalized)

    def get_live_ticker_quote(
        self,
        raw_ticker: str,
        quote_fetcher: Optional[QuoteFetcher] = None,
    ) -> Dict[str, Any]:
        """Validate `raw_ticker` against universe allowlist and return fresh quote + live `USDINR=X` FX."""
        comp = self._resolve_tradable_company(raw_ticker)
        ticker = str(comp["ticker"])
        native_ccy = str(comp["currency"] or "INR")
        eff_now = self._now_utc()
        now_iso = _utc_now_iso(eff_now)
        today_str = _utc_today_str(eff_now)

        live_quotes = self.db.get_paper_live_quotes()
        need_tk = _is_quote_missing_or_stale(live_quotes, ticker, eff_now, LIVE_QUOTE_STALE_SECONDS)
        need_fx = _is_quote_missing_or_stale(live_quotes, FX_USD_INR_SYMBOL, eff_now, LIVE_QUOTE_STALE_SECONDS)

        if need_tk or need_fx:
            to_fetch = sorted({ticker, FX_USD_INR_SYMBOL})
            explicit_fetcher = quote_fetcher or self.quote_fetcher
            active_fetcher = (
                explicit_fetcher
                if explicit_fetcher is not None
                else (fetch_yahoo_chart_quotes if "PYTEST_CURRENT_TEST" not in os.environ else None)
            )
            fetched_raw: Dict[str, Dict[str, Any]] = {}
            if active_fetcher is not None:
                try:
                    fetched_raw = active_fetcher(to_fetch) or {}
                except Exception as exc:
                    logger.warning("Live quote_fetcher raised %s for %s; using fallback.", type(exc).__name__, ticker)
                    fetched_raw = {}
            self._normalize_and_upsert_symbols(to_fetch, fetched_raw, live_quotes, now_iso, today_str)
            live_quotes = self.db.get_paper_live_quotes()

        q_snap = self._get_quote_snapshot(ticker, live_quotes)
        close_px = round(float(q_snap["close_price"]), 2)
        if close_px <= 0:
            raise PaperValidationError(f"No valid market price available for {ticker}.")

        live_row = live_quotes.get(ticker) or {}
        updated_at = str(live_row.get("updated_at") or now_iso)
        usd_inr_rate = resolve_usd_inr_rate(live_quotes)

        return {
            "ticker": ticker,
            "name": str(comp.get("name") or ticker),
            "close_price": close_px,
            "live_price": close_px,
            "current_price": close_px,
            "day_low": round(float(q_snap["day_low"]), 2),
            "day_high": round(float(q_snap["day_high"]), 2),
            "trade_date": str(q_snap["trade_date"]),
            "updated_at": updated_at,
            "native_currency": native_ccy,
            "fx_usd_inr": round(usd_inr_rate, 2),
        }

    # --- Public Mutation Methods ---

    def create_portfolio(
        self,
        user_id: str,
        username: str,
        payload: PaperPortfolioCreateRequest,
    ) -> Dict[str, Any]:
        pf_id = f"pf_{uuid.uuid4().hex[:12]}"
        now_iso = _utc_now_iso()
        ccy = payload.currency
        bm_tk = payload.benchmark_ticker or ("^NSEI" if ccy == "INR" else "^GSPC")
        init_cash = round(float(payload.initial_cash), 2)
        fee_bps = round(float(payload.fee_bps), 2)
        live_quotes = self.db.get_paper_live_quotes()

        with self.db.atomic_transaction() as conn:
            conn.execute(
                """
                INSERT INTO paper_portfolios (
                    id, user_id, name, currency, strategy_preset, benchmark_ticker,
                    cash_balance, reserved_cash, total_deposited, fee_bps, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0.0, ?, ?, ?, ?)
                """,
                (
                    pf_id,
                    user_id,
                    payload.name,
                    ccy,
                    payload.strategy_preset,
                    bm_tk,
                    init_cash,
                    init_cash,
                    fee_bps,
                    now_iso,
                    now_iso,
                ),
            )
            pf_row = {
                "id": pf_id,
                "user_id": user_id,
                "name": payload.name,
                "currency": ccy,
                "strategy_preset": payload.strategy_preset,
                "benchmark_ticker": bm_tk,
                "cash_balance": init_cash,
                "reserved_cash": 0.0,
                "total_deposited": init_cash,
                "fee_bps": fee_bps,
                "created_at": now_iso,
                "updated_at": now_iso,
            }
            self._record_nav_snapshot_in_tx(conn, pf_row, live_quotes)

        overview = self.get_overview(user_id=user_id, username=username, portfolio_id=pf_id)
        return {
            **overview,
            "status": "ok",
            "created_portfolio_id": pf_id,
            "portfolio": overview["active_portfolio"],
        }

    def deposit_cash(
        self,
        user_id: str,
        username: str,
        portfolio_id: str,
        amount: float,
    ) -> Dict[str, Any]:
        clean_amt = round(float(amount), 2)
        if clean_amt <= 0:
            raise PaperValidationError("Deposit amount must be positive.")

        now_iso = _utc_now_iso()
        live_quotes = self.db.get_paper_live_quotes()

        with self.db.atomic_transaction() as conn:
            row = conn.execute(
                "SELECT * FROM paper_portfolios WHERE id = ? AND user_id = ?",
                (portfolio_id, user_id),
            ).fetchone()
            if not row:
                raise PaperNotFoundError("Paper portfolio not found.")
            pf = dict(row)
            new_cash = round(float(pf["cash_balance"]) + clean_amt, 2)
            new_dep = round(float(pf["total_deposited"]) + clean_amt, 2)
            conn.execute(
                """
                UPDATE paper_portfolios
                SET cash_balance = ?, total_deposited = ?, updated_at = ?
                WHERE id = ? AND user_id = ?
                """,
                (new_cash, new_dep, now_iso, portfolio_id, user_id),
            )
            pf["cash_balance"] = new_cash
            pf["total_deposited"] = new_dep
            pf["updated_at"] = now_iso
            self._record_nav_snapshot_in_tx(conn, pf, live_quotes)

        overview = self.get_overview(user_id=user_id, username=username, portfolio_id=portfolio_id)
        return {
            **overview,
            "status": "ok",
            "deposited_amount": clean_amt,
            "portfolio": overview["active_portfolio"],
        }

    def place_order(
        self,
        user_id: str,
        username: str,
        payload: PaperOrderRequest,
        quote_fetcher: Optional[QuoteFetcher] = None,
    ) -> Dict[str, Any]:
        comp = self._resolve_tradable_company(payload.ticker)
        ticker = comp["ticker"]
        native_ccy = comp["currency"]

        if payload.order_type == "LIMIT" and (payload.limit_price is None or payload.limit_price <= 0):
            raise PaperValidationError("A positive limit_price is required for LIMIT orders.")

        eff_now = self._now_utc()
        now_iso = _utc_now_iso(eff_now)
        today_str = _utc_today_str(eff_now)

        # Verify portfolio ownership upfront (prevents IDOR probes from triggering quote fetches)
        with self.db.connect() as conn:
            pf_pre = conn.execute(
                "SELECT id, currency FROM paper_portfolios WHERE id = ? AND user_id = ?",
                (payload.portfolio_id, user_id),
            ).fetchone()
            if not pf_pre:
                raise PaperNotFoundError("Paper portfolio not found.")
            pre_pf_ccy = str(pf_pre["currency"])

        live_quotes = self.db.get_paper_live_quotes()
        if payload.order_type == "MARKET":
            is_cross_ccy = native_ccy.upper() != pre_pf_ccy.upper()
            need_tk = _is_quote_missing_or_stale(live_quotes, ticker, eff_now, LIVE_QUOTE_STALE_SECONDS)
            need_fx = is_cross_ccy and _is_quote_missing_or_stale(
                live_quotes, FX_USD_INR_SYMBOL, eff_now, LIVE_QUOTE_STALE_SECONDS
            )
            explicit_fetcher = quote_fetcher or self.quote_fetcher
            active_mkt_fetcher = (
                explicit_fetcher
                if explicit_fetcher is not None
                else (fetch_yahoo_chart_quotes if "PYTEST_CURRENT_TEST" not in os.environ else None)
            )
            if (need_tk or need_fx) and active_mkt_fetcher is not None:
                to_fetch = sorted({ticker, FX_USD_INR_SYMBOL})
                fetched_raw: Dict[str, Dict[str, Any]] = {}
                try:
                    fetched_raw = active_mkt_fetcher(to_fetch) or {}
                except Exception as exc:
                    logger.warning("Market-order live quote refresh raised %s; using cached/DB price.", type(exc).__name__)
                    fetched_raw = {}
                if fetched_raw:
                    self._normalize_and_upsert_symbols(to_fetch, fetched_raw, live_quotes, now_iso, today_str)
                    live_quotes = self.db.get_paper_live_quotes()

        usd_inr_rate = resolve_usd_inr_rate(live_quotes)
        quote = self._get_quote_snapshot(ticker, live_quotes)
        cur_price = round(float(quote["close_price"]), 2)
        if cur_price <= 0:
            raise PaperValidationError(f"No valid market price available for {ticker}.")

        order_out: Dict[str, Any]
        trade_out: Optional[Dict[str, Any]] = None

        with self.db.atomic_transaction() as conn:
            pf_row = conn.execute(
                "SELECT * FROM paper_portfolios WHERE id = ? AND user_id = ?",
                (payload.portfolio_id, user_id),
            ).fetchone()
            if not pf_row:
                raise PaperNotFoundError("Paper portfolio not found.")
            pf = dict(pf_row)
            preset = str(pf.get("strategy_preset") or "qglp_compounder")
            score_val, rating_val = self._get_score_and_rating(ticker, preset)

            if payload.side == "BUY":
                if payload.order_type == "MARKET":
                    pf, order_out, trade_out = self._execute_buy_fill_in_tx(
                        conn=conn,
                        portfolio=pf,
                        user_id=user_id,
                        ticker=ticker,
                        native_currency=native_ccy,
                        shares=payload.shares,
                        exec_price_native=cur_price,
                        order_type="MARKET",
                        limit_price=None,
                        score_val=score_val,
                        rating_val=rating_val,
                        note=payload.note,
                        now_iso=now_iso,
                        usd_inr_rate=usd_inr_rate,
                    )
                else:
                    lim_px = round(float(payload.limit_price or 0.0), 2)
                    if lim_px >= cur_price:
                        # Marketable LIMIT BUY fills immediately at current_price
                        pf, order_out, trade_out = self._execute_buy_fill_in_tx(
                            conn=conn,
                            portfolio=pf,
                            user_id=user_id,
                            ticker=ticker,
                            native_currency=native_ccy,
                            shares=payload.shares,
                            exec_price_native=cur_price,
                            order_type="LIMIT",
                            limit_price=lim_px,
                            score_val=score_val,
                            rating_val=rating_val,
                            note=payload.note,
                            now_iso=now_iso,
                            usd_inr_rate=usd_inr_rate,
                        )
                    else:
                        pf, order_out = self._queue_open_limit_buy_in_tx(
                            conn=conn,
                            portfolio=pf,
                            user_id=user_id,
                            ticker=ticker,
                            native_currency=native_ccy,
                            shares=payload.shares,
                            limit_price=lim_px,
                            score_val=score_val,
                            rating_val=rating_val,
                            note=payload.note or f"Buy-on-Dip ({((lim_px - cur_price) / cur_price * 100.0):.1f}%)",
                            now_iso=now_iso,
                            usd_inr_rate=usd_inr_rate,
                        )
            else:
                # SELL side
                if payload.order_type == "MARKET":
                    pf, order_out, trade_out = self._execute_sell_fill_in_tx(
                        conn=conn,
                        portfolio=pf,
                        user_id=user_id,
                        ticker=ticker,
                        native_currency=native_ccy,
                        shares=payload.shares,
                        exec_price_native=cur_price,
                        order_type="MARKET",
                        limit_price=None,
                        score_val=score_val,
                        rating_val=rating_val,
                        note=payload.note,
                        now_iso=now_iso,
                        usd_inr_rate=usd_inr_rate,
                    )
                else:
                    lim_px = round(float(payload.limit_price or 0.0), 2)
                    if lim_px <= cur_price:
                        # Marketable LIMIT SELL fills immediately at current_price
                        pf, order_out, trade_out = self._execute_sell_fill_in_tx(
                            conn=conn,
                            portfolio=pf,
                            user_id=user_id,
                            ticker=ticker,
                            native_currency=native_ccy,
                            shares=payload.shares,
                            exec_price_native=cur_price,
                            order_type="LIMIT",
                            limit_price=lim_px,
                            score_val=score_val,
                            rating_val=rating_val,
                            note=payload.note,
                            now_iso=now_iso,
                            usd_inr_rate=usd_inr_rate,
                        )
                    else:
                        # Verify unencumbered shares and queue OPEN LIMIT SELL
                        pos_row = conn.execute(
                            "SELECT shares FROM paper_positions WHERE portfolio_id = ? AND ticker = ?",
                            (pf["id"], ticker),
                        ).fetchone()
                        owned_sh = int(pos_row["shares"]) if pos_row else 0
                        enc_row = conn.execute(
                            """
                            SELECT COALESCE(SUM(shares), 0) AS locked
                            FROM paper_orders
                            WHERE portfolio_id = ? AND ticker = ? AND side = 'SELL' AND status = 'OPEN'
                            """,
                            (pf["id"], ticker),
                        ).fetchone()
                        locked_sh = int(enc_row["locked"]) if enc_row else 0
                        if payload.shares > (owned_sh - locked_sh):
                            raise PaperValidationError(
                                f"Insufficient unencumbered shares to queue LIMIT SELL on {ticker}."
                            )
                        ord_id = f"ord_{uuid.uuid4().hex[:14]}"
                        conn.execute(
                            """
                            INSERT INTO paper_orders (
                                id, portfolio_id, user_id, ticker, side, order_type, shares,
                                limit_price, reserved_amount, status, score_at_order, rating_at_order,
                                note, created_at, filled_at, filled_price
                            ) VALUES (?, ?, ?, ?, 'SELL', 'LIMIT', ?, ?, 0, 'OPEN', ?, ?, ?, ?, NULL, NULL)
                            """,
                            (
                                ord_id,
                                pf["id"],
                                user_id,
                                ticker,
                                payload.shares,
                                lim_px,
                                score_val,
                                rating_val,
                                payload.note,
                                now_iso,
                            ),
                        )
                        order_out = {
                            "id": ord_id,
                            "portfolio_id": str(pf["id"]),
                            "ticker": ticker,
                            "side": "SELL",
                            "order_type": "LIMIT",
                            "shares": payload.shares,
                            "limit_price": lim_px,
                            "reserved_amount": 0.0,
                            "status": "OPEN",
                            "score_at_order": score_val,
                            "rating_at_order": rating_val,
                            "note": payload.note,
                            "created_at": now_iso,
                            "filled_at": None,
                            "filled_price": None,
                        }

            self._record_nav_snapshot_in_tx(conn, pf, live_quotes)

        overview = self.get_overview(user_id=user_id, username=username, portfolio_id=payload.portfolio_id)
        return {
            **overview,
            "status": "ok",
            "order": order_out,
            "trade": trade_out,
        }

    def cancel_order(
        self,
        user_id: str,
        username: str,
        order_id: str,
    ) -> Dict[str, Any]:
        now_iso = _utc_now_iso()
        pf_id: str
        cancelled_order: Dict[str, Any]

        with self.db.atomic_transaction() as conn:
            ord_row = conn.execute(
                "SELECT * FROM paper_orders WHERE id = ? AND user_id = ?",
                (order_id, user_id),
            ).fetchone()
            if not ord_row:
                raise PaperNotFoundError("Order not found.")
            ord_dict = dict(ord_row)
            if str(ord_dict["status"]) != "OPEN":
                raise PaperValidationError(f"Only OPEN orders can be cancelled (current status: {ord_dict['status']}).")

            pf_id = str(ord_dict["portfolio_id"])
            pf_row = conn.execute(
                "SELECT * FROM paper_portfolios WHERE id = ? AND user_id = ?",
                (pf_id, user_id),
            ).fetchone()
            if not pf_row:
                raise PaperNotFoundError("Paper portfolio not found.")
            pf = dict(pf_row)

            rel_amt = round(float(ord_dict.get("reserved_amount") or 0.0), 2)
            if str(ord_dict["side"]) == "BUY" and rel_amt > 0:
                new_res = max(0.0, round(float(pf["reserved_cash"]) - rel_amt, 2))
                conn.execute(
                    "UPDATE paper_portfolios SET reserved_cash = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                    (new_res, now_iso, pf_id, user_id),
                )

            conn.execute(
                "UPDATE paper_orders SET status = 'CANCELLED', reserved_amount = 0 WHERE id = ? AND user_id = ?",
                (order_id, user_id),
            )
            cancelled_order = {**ord_dict, "status": "CANCELLED", "reserved_amount": 0.0}

        overview = self.get_overview(user_id=user_id, username=username, portfolio_id=pf_id)
        return {
            **overview,
            "status": "ok",
            "cancelled_order_id": order_id,
            "order": cancelled_order,
        }

    def deploy_basket(
        self,
        user_id: str,
        username: str,
        payload: PaperDeployBasketRequest,
    ) -> Dict[str, Any]:
        actionable = [it for it in payload.items if it.market_shares > 0 or it.dip_shares > 0]
        if not actionable:
            raise PaperValidationError("Basket must contain at least one item with market_shares > 0 or dip_shares > 0.")

        # Pre-validate all tickers against universe allowlist before starting write transaction
        resolved_items: List[Tuple[Any, Dict[str, Any]]] = [
            (item, self._resolve_tradable_company(item.ticker)) for item in actionable
        ]

        live_quotes = self.db.get_paper_live_quotes()
        usd_inr_rate = resolve_usd_inr_rate(live_quotes)
        now_iso = _utc_now_iso()
        executed_trades: List[Dict[str, Any]] = []
        queued_orders: List[Dict[str, Any]] = []
        all_orders: List[Dict[str, Any]] = []

        with self.db.atomic_transaction() as conn:
            pf_row = conn.execute(
                "SELECT * FROM paper_portfolios WHERE id = ? AND user_id = ?",
                (payload.portfolio_id, user_id),
            ).fetchone()
            if not pf_row:
                raise PaperNotFoundError("Paper portfolio not found.")
            pf = dict(pf_row)
            preset = str(pf.get("strategy_preset") or "qglp_compounder")

            for item, comp in resolved_items:
                ticker = comp["ticker"]
                native_ccy = comp["currency"]
                quote = self._get_quote_snapshot(ticker, live_quotes)
                cur_price = round(float(quote["close_price"]), 2)
                if cur_price <= 0:
                    raise PaperValidationError(f"No valid market price available for {ticker}.")
                score_val, rating_val = self._get_score_and_rating(ticker, preset)

                if item.market_shares > 0:
                    pf, m_ord, m_trd = self._execute_buy_fill_in_tx(
                        conn=conn,
                        portfolio=pf,
                        user_id=user_id,
                        ticker=ticker,
                        native_currency=native_ccy,
                        shares=item.market_shares,
                        exec_price_native=cur_price,
                        order_type="MARKET",
                        limit_price=None,
                        score_val=score_val,
                        rating_val=rating_val,
                        note=item.note or "Planner Immediate Tranche",
                        now_iso=now_iso,
                        usd_inr_rate=usd_inr_rate,
                    )
                    all_orders.append(m_ord)
                    executed_trades.append(m_trd)

                if item.dip_shares > 0:
                    dip_pct = float(item.dip_pct if item.dip_pct is not None else 7.0)
                    limit_px = round(cur_price * (1.0 - dip_pct / 100.0), 2)
                    if limit_px <= 0:
                        raise PaperValidationError(f"Computed limit price for {ticker} must be positive.")
                    dip_note = item.note or f"Blueprint Buy-on-Dip (-{dip_pct:g}%)"
                    if limit_px >= cur_price:
                        pf, l_ord, l_trd = self._execute_buy_fill_in_tx(
                            conn=conn,
                            portfolio=pf,
                            user_id=user_id,
                            ticker=ticker,
                            native_currency=native_ccy,
                            shares=item.dip_shares,
                            exec_price_native=cur_price,
                            order_type="LIMIT",
                            limit_price=limit_px,
                            score_val=score_val,
                            rating_val=rating_val,
                            note=dip_note,
                            now_iso=now_iso,
                            usd_inr_rate=usd_inr_rate,
                        )
                        all_orders.append(l_ord)
                        executed_trades.append(l_trd)
                    else:
                        pf, l_ord = self._queue_open_limit_buy_in_tx(
                            conn=conn,
                            portfolio=pf,
                            user_id=user_id,
                            ticker=ticker,
                            native_currency=native_ccy,
                            shares=item.dip_shares,
                            limit_price=limit_px,
                            score_val=score_val,
                            rating_val=rating_val,
                            note=dip_note,
                            now_iso=now_iso,
                            usd_inr_rate=usd_inr_rate,
                        )
                        all_orders.append(l_ord)
                        queued_orders.append(l_ord)

            self._record_nav_snapshot_in_tx(conn, pf, live_quotes)

        overview = self.get_overview(user_id=user_id, username=username, portfolio_id=payload.portfolio_id)
        return {
            **overview,
            "status": "ok",
            "executed_trades": executed_trades,
            "queued_orders": queued_orders,
            "deployed": {
                "market_fills_count": len(executed_trades),
                "limit_orders_count": len(queued_orders),
                "orders": all_orders,
                "trades": executed_trades,
            },
        }

    def refresh_quotes_and_orders(
        self,
        user_id: str,
        username: str,
        portfolio_id: Optional[str] = None,
        market_scope: str = "ALL",
        quote_fetcher: Optional[QuoteFetcher] = None,
    ) -> Dict[str, Any]:
        clean_pf_id = (portfolio_id or "").strip() or None
        scope = normalize_market_scope(market_scope)
        eff_now = self._now_utc()
        now_iso = _utc_now_iso(eff_now)
        today_str = _utc_today_str(eff_now)

        with self.db.connect() as conn:
            if clean_pf_id:
                owned = conn.execute(
                    "SELECT id FROM paper_portfolios WHERE id = ? AND user_id = ?",
                    (clean_pf_id, user_id),
                ).fetchone()
                if not owned:
                    raise PaperNotFoundError("Paper portfolio not found.")

            user_pfs = conn.execute(
                "SELECT id, benchmark_ticker, currency FROM paper_portfolios WHERE user_id = ?",
                (user_id,),
            ).fetchall()
            pf_ids = [str(r["id"]) for r in user_pfs]

            if not pf_ids:
                overview_idle = self.get_overview(
                    user_id=user_id,
                    username=username,
                    portfolio_id=None,
                    now_utc=eff_now,
                )
                return {
                    **overview_idle,
                    "status": "ok",
                    "market_scope": scope,
                    "quotes_updated": 0,
                    "orders_filled": 0,
                    "portfolios_snapshotted": 0,
                    "filled_orders": [],
                    "as_of_date": today_str,
                    "skipped_idle": True,
                    "refresh_summary": {
                        "market_scope": scope,
                        "quotes_updated": 0,
                        "orders_filled": 0,
                        "portfolios_snapshotted": 0,
                        "filled_orders": [],
                        "as_of_date": today_str,
                        "skipped_idle": True,
                    },
                }

            tracked_tickers = set(benchmarks_for_scope(scope))
            for r in user_pfs:
                if r["benchmark_ticker"]:
                    bm_sym = str(r["benchmark_ticker"])
                    if matches_market_scope(bm_sym, scope):
                        tracked_tickers.add(bm_sym)

            placeholders = ",".join("?" for _ in pf_ids)
            pos_tks = conn.execute(
                f"SELECT DISTINCT ticker FROM paper_positions WHERE portfolio_id IN ({placeholders}) AND shares > 0",
                pf_ids,
            ).fetchall()
            ord_tks = conn.execute(
                "SELECT DISTINCT ticker FROM paper_orders WHERE user_id = ? AND status = 'OPEN'",
                (user_id,),
            ).fetchall()
            for row in pos_tks:
                tk_sym = str(row["ticker"])
                if matches_market_scope(tk_sym, scope):
                    tracked_tickers.add(tk_sym)
            for row in ord_tks:
                tk_sym = str(row["ticker"])
                if matches_market_scope(tk_sym, scope):
                    tracked_tickers.add(tk_sym)

        sorted_tickers = sorted(tracked_tickers)
        active_fetcher = quote_fetcher or self.quote_fetcher or fetch_yahoo_chart_quotes
        fetched_raw: Dict[str, Dict[str, Any]] = {}
        if sorted_tickers:
            try:
                fetched_raw = active_fetcher(sorted_tickers) or {}
            except Exception as exc:
                logger.warning("Custom/live quote_fetcher raised %s; using DB fallback.", type(exc).__name__)
                fetched_raw = {}

        existing_live = self.db.get_paper_live_quotes()
        normalized_to_upsert: List[Dict[str, Any]] = []

        for sym in sorted_tickers:
            raw_q = fetched_raw.get(sym)
            if isinstance(raw_q, dict):
                c_raw = raw_q.get("close_price") if raw_q.get("close_price") is not None else raw_q.get("close")
                if c_raw is not None and float(c_raw) > 0:
                    c_px = round(float(c_raw), 2)
                    lo_raw = raw_q.get("day_low") if raw_q.get("day_low") is not None else raw_q.get("low")
                    hi_raw = raw_q.get("day_high") if raw_q.get("day_high") is not None else raw_q.get("high")
                    lo_px = round(float(lo_raw), 2) if lo_raw is not None and float(lo_raw) > 0 else c_px
                    hi_px = round(float(hi_raw), 2) if hi_raw is not None and float(hi_raw) > 0 else c_px
                    lo_px = min(lo_px, c_px)
                    hi_px = max(hi_px, c_px)
                    t_date = str(raw_q.get("trade_date") or raw_q.get("date") or today_str)
                    normalized_to_upsert.append(
                        {
                            "ticker": sym,
                            "close_price": c_px,
                            "day_low": lo_px,
                            "day_high": hi_px,
                            "trade_date": t_date,
                            "updated_at": now_iso,
                        }
                    )
                    continue

            # Graceful offline fallback if neither Yahoo nor existing paper_live_quotes has `sym`
            if sym not in existing_live:
                base_px, base_date = self._get_baseline_price(sym)
                if base_px > 0:
                    normalized_to_upsert.append(
                        {
                            "ticker": sym,
                            "close_price": base_px,
                            "day_low": base_px,
                            "day_high": base_px,
                            "trade_date": base_date,
                            "updated_at": now_iso,
                        }
                    )

        quotes_updated = self.db.upsert_paper_live_quotes(normalized_to_upsert)
        live_quotes = self.db.get_paper_live_quotes()
        usd_inr_rate = resolve_usd_inr_rate(live_quotes)

        # Determine refresh snapshot date (prefer explicitly fetched trade_date, else today UTC)
        fetched_dates = [q["trade_date"] for q in normalized_to_upsert if q.get("ticker") in fetched_raw and q.get("trade_date")]
        refresh_snap_date = max(fetched_dates) if fetched_dates else today_str

        comp_meta = self._get_company_metadata_map()
        filled_orders: List[Dict[str, Any]] = []
        snapshotted_count = 0

        with self.db.atomic_transaction() as conn:
            open_orders = conn.execute(
                """
                SELECT *
                FROM paper_orders
                WHERE user_id = ? AND status = 'OPEN' AND order_type = 'LIMIT'
                ORDER BY created_at ASC, id ASC
                """,
                (user_id,),
            ).fetchall()

            for ord_row in open_orders:
                ord_d = dict(ord_row)
                tk = str(ord_d["ticker"])
                if not matches_market_scope(tk, scope):
                    continue
                lim_px = float(ord_d["limit_price"] or 0.0)
                if lim_px <= 0:
                    continue

                q = self._get_quote_snapshot(tk, live_quotes)
                c_px = float(q["close_price"])
                lo_px = float(q["day_low"])
                hi_px = float(q["day_high"])
                if c_px <= 0:
                    continue

                pf_row = conn.execute(
                    "SELECT * FROM paper_portfolios WHERE id = ? AND user_id = ?",
                    (ord_d["portfolio_id"], user_id),
                ).fetchone()
                if not pf_row:
                    continue
                pf = dict(pf_row)
                meta = comp_meta.get(tk) or {}
                native_ccy = str(meta.get("currency") or ("INR" if tk.endswith((".NS", ".BO")) else "USD"))
                preset = str(pf.get("strategy_preset") or "qglp_compounder")
                cur_score, cur_rating = self._get_score_and_rating(tk, preset)
                score_val = float(ord_d["score_at_order"]) if ord_d["score_at_order"] is not None else cur_score
                rating_val = str(ord_d["rating_at_order"] or cur_rating)

                side = str(ord_d["side"])
                if side == "BUY" and lo_px <= lim_px + 1e-9:
                    exec_px = round(min(c_px, lim_px), 2)
                    _, filled_ord, _ = self._execute_buy_fill_in_tx(
                        conn=conn,
                        portfolio=pf,
                        user_id=user_id,
                        ticker=tk,
                        native_currency=native_ccy,
                        shares=int(ord_d["shares"]),
                        exec_price_native=exec_px,
                        order_type="LIMIT",
                        limit_price=lim_px,
                        score_val=score_val,
                        rating_val=rating_val,
                        note=str(ord_d["note"] or ""),
                        now_iso=now_iso,
                        existing_order_id=str(ord_d["id"]),
                        released_reservation=float(ord_d["reserved_amount"] or 0.0),
                        usd_inr_rate=usd_inr_rate,
                    )
                    filled_orders.append(filled_ord)
                elif side == "SELL" and hi_px + 1e-9 >= lim_px:
                    exec_px = round(max(c_px, lim_px), 2)
                    try:
                        _, filled_ord, _ = self._execute_sell_fill_in_tx(
                            conn=conn,
                            portfolio=pf,
                            user_id=user_id,
                            ticker=tk,
                            native_currency=native_ccy,
                            shares=int(ord_d["shares"]),
                            exec_price_native=exec_px,
                            order_type="LIMIT",
                            limit_price=lim_px,
                            score_val=score_val,
                            rating_val=rating_val,
                            note=str(ord_d["note"] or ""),
                            now_iso=now_iso,
                            existing_order_id=str(ord_d["id"]),
                            usd_inr_rate=usd_inr_rate,
                        )
                        filled_orders.append(filled_ord)
                    except PaperValidationError:
                        logger.warning("Skipped OPEN SELL LIMIT %s due to insufficient shares.", ord_d["id"])

            # Refresh today's NAV history snapshot across all user portfolios
            all_user_pfs = conn.execute(
                "SELECT * FROM paper_portfolios WHERE user_id = ?",
                (user_id,),
            ).fetchall()
            for pf_r in all_user_pfs:
                self._record_nav_snapshot_in_tx(
                    conn=conn,
                    portfolio_row=dict(pf_r),
                    live_quotes=live_quotes,
                    snap_date_override=refresh_snap_date,
                )
                snapshotted_count += 1

        overview = self.get_overview(
            user_id=user_id,
            username=username,
            portfolio_id=clean_pf_id,
            now_utc=eff_now,
        )
        return {
            **overview,
            "status": "ok",
            "market_scope": scope,
            "quotes_updated": quotes_updated,
            "orders_filled": len(filled_orders),
            "portfolios_snapshotted": snapshotted_count,
            "filled_orders": filled_orders,
            "as_of_date": refresh_snap_date,
            "skipped_idle": False,
            "refresh_summary": {
                "market_scope": scope,
                "quotes_updated": quotes_updated,
                "orders_filled": len(filled_orders),
                "portfolios_snapshotted": snapshotted_count,
                "filled_orders": filled_orders,
                "as_of_date": refresh_snap_date,
                "skipped_idle": False,
            },
        }

    def run_global_daily_paper_refresh(
        self,
        market_scope: str = "ALL",
        quote_fetcher: Optional[QuoteFetcher] = None,
    ) -> Dict[str, Any]:
        """Run global scheduled market-close quote sync, limit-order fills, and NAV snapshots."""
        scope = normalize_market_scope(market_scope)
        eff_now = self._now_utc()
        now_iso = _utc_now_iso(eff_now)
        today_str = _utc_today_str(eff_now)

        with self.db.connect() as conn:
            cnt_row = conn.execute("SELECT COUNT(*) AS cnt FROM paper_portfolios").fetchone()
            total_portfolios = int(cnt_row["cnt"]) if cnt_row else 0
            if total_portfolios == 0:
                return {
                    "quotes_updated": 0,
                    "orders_filled": 0,
                    "portfolios_snapshotted": 0,
                    "market_scope": scope,
                    "as_of_date": today_str,
                    "skipped_idle": True,
                }

            pos_tks = conn.execute("SELECT DISTINCT ticker FROM paper_positions WHERE shares > 0").fetchall()
            ord_tks = conn.execute("SELECT DISTINCT ticker FROM paper_orders WHERE status = 'OPEN'").fetchall()
            bm_tks = conn.execute("SELECT DISTINCT benchmark_ticker FROM paper_portfolios").fetchall()

        tracked = set(benchmarks_for_scope(scope))
        for r in pos_tks:
            tk = str(r["ticker"] or "")
            if tk and matches_market_scope(tk, scope):
                tracked.add(tk)
        for r in ord_tks:
            tk = str(r["ticker"] or "")
            if tk and matches_market_scope(tk, scope):
                tracked.add(tk)
        for r in bm_tks:
            tk = str(r["benchmark_ticker"] or "")
            if tk and matches_market_scope(tk, scope):
                tracked.add(tk)

        sorted_tickers = sorted(tracked)
        active_fetcher = quote_fetcher or self.quote_fetcher or fetch_yahoo_chart_quotes
        fetched_raw: Dict[str, Dict[str, Any]] = {}
        if sorted_tickers:
            try:
                fetched_raw = active_fetcher(sorted_tickers) or {}
            except Exception as exc:
                logger.warning("Global refresh quote_fetcher raised %s; using DB fallback.", type(exc).__name__)
                fetched_raw = {}

        existing_live = self.db.get_paper_live_quotes()
        normalized_to_upsert: List[Dict[str, Any]] = []
        for sym in sorted_tickers:
            raw_q = fetched_raw.get(sym)
            if isinstance(raw_q, dict):
                c_raw = raw_q.get("close_price") if raw_q.get("close_price") is not None else raw_q.get("close")
                if c_raw is not None and float(c_raw) > 0:
                    c_px = round(float(c_raw), 2)
                    lo_raw = raw_q.get("day_low") if raw_q.get("day_low") is not None else raw_q.get("low")
                    hi_raw = raw_q.get("day_high") if raw_q.get("day_high") is not None else raw_q.get("high")
                    lo_px = round(float(lo_raw), 2) if lo_raw is not None and float(lo_raw) > 0 else c_px
                    hi_px = round(float(hi_raw), 2) if hi_raw is not None and float(hi_raw) > 0 else c_px
                    lo_px = min(lo_px, c_px)
                    hi_px = max(hi_px, c_px)
                    t_date = str(raw_q.get("trade_date") or raw_q.get("date") or today_str)
                    normalized_to_upsert.append(
                        {
                            "ticker": sym,
                            "close_price": c_px,
                            "day_low": lo_px,
                            "day_high": hi_px,
                            "trade_date": t_date,
                            "updated_at": now_iso,
                        }
                    )
                    continue
            if sym not in existing_live:
                base_px, base_date = self._get_baseline_price(sym)
                if base_px > 0:
                    normalized_to_upsert.append(
                        {
                            "ticker": sym,
                            "close_price": base_px,
                            "day_low": base_px,
                            "day_high": base_px,
                            "trade_date": base_date,
                            "updated_at": now_iso,
                        }
                    )

        quotes_updated = self.db.upsert_paper_live_quotes(normalized_to_upsert)
        live_quotes = self.db.get_paper_live_quotes()
        usd_inr_rate = resolve_usd_inr_rate(live_quotes)
        fetched_dates = [q["trade_date"] for q in normalized_to_upsert if q.get("ticker") in fetched_raw and q.get("trade_date")]
        refresh_snap_date = max(fetched_dates) if fetched_dates else today_str

        comp_meta = self._get_company_metadata_map()
        filled_count = 0
        snapshotted_count = 0

        with self.db.atomic_transaction() as conn:
            open_orders = conn.execute(
                """
                SELECT *
                FROM paper_orders
                WHERE status = 'OPEN' AND order_type = 'LIMIT'
                ORDER BY created_at ASC, id ASC
                """
            ).fetchall()

            for ord_row in open_orders:
                ord_d = dict(ord_row)
                tk = str(ord_d["ticker"])
                if not matches_market_scope(tk, scope):
                    continue
                lim_px = float(ord_d["limit_price"] or 0.0)
                if lim_px <= 0:
                    continue

                q = self._get_quote_snapshot(tk, live_quotes)
                c_px = float(q["close_price"])
                lo_px = float(q["day_low"])
                hi_px = float(q["day_high"])
                if c_px <= 0:
                    continue

                uid = str(ord_d["user_id"])
                pf_row = conn.execute(
                    "SELECT * FROM paper_portfolios WHERE id = ? AND user_id = ?",
                    (ord_d["portfolio_id"], uid),
                ).fetchone()
                if not pf_row:
                    continue
                pf = dict(pf_row)
                meta = comp_meta.get(tk) or {}
                native_ccy = str(meta.get("currency") or ("INR" if tk.endswith((".NS", ".BO")) else "USD"))
                preset = str(pf.get("strategy_preset") or "qglp_compounder")
                cur_score, cur_rating = self._get_score_and_rating(tk, preset)
                score_val = float(ord_d["score_at_order"]) if ord_d["score_at_order"] is not None else cur_score
                rating_val = str(ord_d["rating_at_order"] or cur_rating)

                side = str(ord_d["side"])
                if side == "BUY" and lo_px <= lim_px + 1e-9:
                    exec_px = round(min(c_px, lim_px), 2)
                    self._execute_buy_fill_in_tx(
                        conn=conn,
                        portfolio=pf,
                        user_id=uid,
                        ticker=tk,
                        native_currency=native_ccy,
                        shares=int(ord_d["shares"]),
                        exec_price_native=exec_px,
                        order_type="LIMIT",
                        limit_price=lim_px,
                        score_val=score_val,
                        rating_val=rating_val,
                        note=str(ord_d["note"] or ""),
                        now_iso=now_iso,
                        existing_order_id=str(ord_d["id"]),
                        released_reservation=float(ord_d["reserved_amount"] or 0.0),
                        usd_inr_rate=usd_inr_rate,
                    )
                    filled_count += 1
                elif side == "SELL" and hi_px + 1e-9 >= lim_px:
                    exec_px = round(max(c_px, lim_px), 2)
                    try:
                        self._execute_sell_fill_in_tx(
                            conn=conn,
                            portfolio=pf,
                            user_id=uid,
                            ticker=tk,
                            native_currency=native_ccy,
                            shares=int(ord_d["shares"]),
                            exec_price_native=exec_px,
                            order_type="LIMIT",
                            limit_price=lim_px,
                            score_val=score_val,
                            rating_val=rating_val,
                            note=str(ord_d["note"] or ""),
                            now_iso=now_iso,
                            existing_order_id=str(ord_d["id"]),
                            usd_inr_rate=usd_inr_rate,
                        )
                        filled_count += 1
                    except PaperValidationError:
                        logger.warning("Skipped OPEN SELL LIMIT %s due to insufficient shares.", ord_d["id"])

            all_pfs = conn.execute("SELECT * FROM paper_portfolios").fetchall()
            for pf_r in all_pfs:
                self._record_nav_snapshot_in_tx(
                    conn=conn,
                    portfolio_row=dict(pf_r),
                    live_quotes=live_quotes,
                    snap_date_override=refresh_snap_date,
                )
                snapshotted_count += 1

        return {
            "quotes_updated": quotes_updated,
            "orders_filled": filled_count,
            "portfolios_snapshotted": snapshotted_count,
            "market_scope": scope,
            "as_of_date": refresh_snap_date,
            "skipped_idle": False,
        }
