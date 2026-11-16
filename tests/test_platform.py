"""End-to-end quantitative, functional, and security verification suite for ArthaQuant."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app


def _authenticated_client(tmp_path: Path, username: str = "advisor1") -> tuple[TestClient, str]:
    db_file = tmp_path / "test_artha.db"
    app = create_app(db_path=db_file)
    client = TestClient(app, base_url="https://127.0.0.1:8000")

    status_res = client.get("/api/auth/status")
    assert status_res.status_code == 200
    pre_csrf = status_res.json()["csrf_token"]

    if status_res.json()["needs_setup"]:
        setup_res = client.post(
            "/api/auth/setup",
            json={"username": username, "password": "StrongPassphrase!2026"},
            headers={"X-CSRF-Token": pre_csrf},
        )
        assert setup_res.status_code == 200
        return client, setup_res.json()["csrf_token"]

    login_res = client.post(
        "/api/auth/login",
        json={"username": username, "password": "StrongPassphrase!2026"},
        headers={"X-CSRF-Token": pre_csrf},
    )
    assert login_res.status_code == 200
    return client, login_res.json()["csrf_token"]


def test_security_headers_method_allowlist_and_csrf(tmp_path: Path) -> None:
    db_file = tmp_path / "sec.db"
    app = create_app(db_path=db_file)
    client = TestClient(app, base_url="https://127.0.0.1:8000")

    # 1. Verify strict security headers on root & API
    root_res = client.get("/")
    assert root_res.status_code == 200
    assert "default-src 'self'" in root_res.headers["Content-Security-Policy"]
    assert root_res.headers["X-Content-Type-Options"] == "nosniff"
    assert root_res.headers["X-Frame-Options"] == "DENY"

    # 2. Disallowed HTTP verbs rejected with 405
    del_res = client.delete("/api/screener")
    assert del_res.status_code == 405

    # 3. Unauthenticated access rejected with 401
    unauth = client.post("/api/screener", json={"preset": "artha_blend"})
    assert unauth.status_code == 401
    assert unauth.headers["Cache-Control"] == "no-store"

    # 4. Pre-auth setup without CSRF token rejected with 403
    client.get("/api/auth/status")
    no_csrf = client.post(
        "/api/auth/setup",
        json={"username": "advisor", "password": "StrongPassphrase!2026"},
    )
    assert no_csrf.status_code == 403


def test_screener_ratings_and_forensic_traps(tmp_path: Path) -> None:
    client, csrf = _authenticated_client(tmp_path)

    res = client.post(
        "/api/screener",
        json={"preset": "artha_blend", "sector": "ALL", "min_score": 0},
        headers={"X-CSRF-Token": csrf},
    )
    assert res.status_code == 200
    body = res.json()
    stocks = body["stocks"]
    assert len(stocks) >= 30

    by_ticker = {s["ticker"]: s for s in stocks}
    # Forensic guardrails must flag loss-making / weak-cash traps as Avoid
    assert by_ticker["IDEA.NS"]["rating"] == "Avoid"
    assert len(by_ticker["IDEA.NS"]["red_flags"]) >= 2
    assert by_ticker["ZEEL.NS"]["rating"] == "Avoid"

    # High-ROCE & growth Indian leaders should rank in Buy / Strong Buy territory
    assert by_ticker["HAL.NS"]["rating"] in {"Strong Buy", "Buy"}
    assert by_ticker["ICICIBANK.NS"]["rating"] in {"Strong Buy", "Buy"}
    assert by_ticker["BAJFINANCE.NS"]["rating"] in {"Strong Buy", "Buy"}
    assert by_ticker["TCS.NS"]["pillars"]["quality"] >= 90.0

    # Under Marcellus Coffee-Can preset, asset-light compounder TCS.NS upgrades to Buy/Strong Buy
    cc_res = client.post(
        "/api/screener",
        json={"preset": "coffee_can", "sector": "ALL", "min_score": 0},
        headers={"X-CSRF-Token": csrf},
    )
    cc_by_ticker = {s["ticker"]: s for s in cc_res.json()["stocks"]}
    assert cc_by_ticker["TCS.NS"]["rating"] in {"Strong Buy", "Buy"}

    # Company detail endpoint
    detail = client.get("/api/company/TCS.NS?preset=coffee_can")
    assert detail.status_code == 200
    assert detail.json()["scorecard"]["ticker"] == "TCS.NS"
    assert len(detail.json()["fundamentals"]) == 6


def test_point_in_time_reporting_lag_and_backtester(tmp_path: Path) -> None:
    client, csrf = _authenticated_client(tmp_path)
    app = client.app
    companies, fund_df, price_mat, _s1 = app.state.market_cache.load()

    from app.factors import score_universe_point_in_time

    # FY2026 ends 2026-03-31 with 60-day reporting lag -> reported_date == 2026-05-30
    april_scores = score_universe_point_in_time(companies, fund_df, price_mat, as_of_date="2026-04-15")
    june_scores = score_universe_point_in_time(companies, fund_df, price_mat, as_of_date="2026-06-10")

    assert april_scores[0]["metrics"]["latest_fy"] == 2025
    assert june_scores[0]["metrics"]["latest_fy"] == 2026

    # Run 5-year quarterly backtest
    bt_res = client.post(
        "/api/backtest",
        json={
            "preset": "artha_blend",
            "lookback_years": 5,
            "top_n": 10,
            "rebalance": "quarterly",
            "weighting": "inv_vol",
            "initial_capital": 1_000_000,
            "cost_bps": 25,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert bt_res.status_code == 200
    bt = bt_res.json()
    assert bt["summary"]["reporting_lag_days"] == 60
    assert bt["summary"]["final_portfolio_inr"] > 1_000_000
    assert len(bt["equity_curve"]) >= 50
    assert len(bt["latest_holdings"]) == 10


def test_planner_csv_upload_and_logout_invalidation(tmp_path: Path) -> None:
    client, csrf = _authenticated_client(tmp_path)

    # 1. Wealth Planner (both Moderate Multi-Asset and Direct ₹5L Long-Term Compounder blueprint)
    plan_5l = client.post(
        "/api/planner",
        json={
            "plan_name": "Deploy 5L Today",
            "lump_sum_inr": 500_000,
            "monthly_sip_inr": 0,
            "horizon_years": 7,
            "target_corpus_inr": 1_300_000,
            "risk_profile": "equity_direct",
            "preset": "qglp_compounder",
            "max_stocks": 8,
            "save_plan": False,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert plan_5l.status_code == 200
    p5 = plan_5l.json()
    assert len(p5["stock_basket"]) == 8
    assert p5["deployment_summary"]["sectors_covered"] >= 4
    assert len(p5["monitoring_rules"]) >= 3

    plan_res = client.post(
        "/api/planner",
        json={
            "plan_name": "Retirement 2036",
            "lump_sum_inr": 1_000_000,
            "monthly_sip_inr": 75_000,
            "horizon_years": 10,
            "target_corpus_inr": 25_000_000,
            "risk_profile": "moderate",
            "preset": "artha_blend",
            "max_stocks": 10,
            "save_plan": True,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert plan_res.status_code == 200
    plan = plan_res.json()
    assert len(plan["stock_basket"]) == 10
    assert len(plan["saved_plans"]) == 1
    assert all(max_sec <= 35.0 for max_sec in plan["sector_exposure_pct"].values())

    # 2. CSV Import validation: reject non-CSV extension & accept valid CSV
    bad_upload = client.post(
        "/api/import/csv",
        files={"file": ("payload.html", b"<html><script>1</script></html>", "text/html")},
        headers={"X-CSRF-Token": csrf},
    )
    assert bad_upload.status_code == 400

    valid_csv = (
        "ticker,name,sector,fiscal_year,revenue_cr,ebitda_cr,net_profit_cr,roce_pct,roe_pct,debt_to_equity\n"
        "DMART.NS,Avenue Supermarts,Consumer & FMCG,2025,50789,4105,2695,21.4,16.8,0.04\n"
        "DMART.NS,Avenue Supermarts,Consumer & FMCG,2026,58920,4810,3180,22.1,17.4,0.03\n"
    ).encode("utf-8")
    ok_upload = client.post(
        "/api/import/csv",
        files={"file": ("screener_export.csv", valid_csv, "text/csv")},
        headers={"X-CSRF-Token": csrf},
    )
    assert ok_upload.status_code == 200
    assert ok_upload.json()["imported"]["companies_imported"] == 1

    # 3. Logout invalidates active session server-side
    out_res = client.post("/api/auth/logout", json={}, headers={"X-CSRF-Token": csrf})
    assert out_res.status_code == 200
    after_logout = client.post("/api/screener", json={"preset": "artha_blend"}, headers={"X-CSRF-Token": csrf})
    assert after_logout.status_code == 401


def test_anti_cyclical_moat_quarterly_slowdown_and_shareholding_guardrails(tmp_path: Path) -> None:
    client, csrf = _authenticated_client(tmp_path)
    db = client.app.state.db

    # Inject a recent 2Q earnings contraction + institutional exit on TCS.NS and verify point-in-time isolation
    db.upsert_quarterly_signals(
        {
            "ticker": "TCS.NS",
            "latest_qtr_label": "Sep 2026",
            "signals_reported_date": "2026-06-01",
            "ttm_rev_cr": 250000.0,
            "ttm_pat_cr": 42000.0,
            "qtr_rev_yoy_pct": -7.5,
            "qtr_pat_yoy_pct": -21.0,
            "qtr_opm_delta_pct": -3.2,
            "promoter_chg_1y_pct": -3.8,
            "inst_chg_1y_pct": -1.5,
            "gnpa_pct": 0.0,
            "nnpa_pct": 0.0,
            "has_qtr_data": True,
            "has_sh_trend": True,
        }
    )
    client.app.state.market_cache.invalidate()

    res = client.post(
        "/api/screener",
        json={"preset": "qglp_compounder", "sector": "ALL", "min_score": 0},
        headers={"X-CSRF-Token": csrf},
    )
    assert res.status_code == 200
    by_tk = {s["ticker"]: s for s in res.json()["stocks"]}
    tcs = by_tk["TCS.NS"]
    assert any("Recent 2Q earnings slowdown" in f for f in tcs["red_flags"])
    assert any("4Q Promoter/Institutional exit" in f for f in tcs["red_flags"])
    assert tcs["metrics"]["moat_stability_score"] >= 80.0


def _authenticated_multimarket_client(tmp_path: Path) -> tuple[TestClient, str]:
    """Create an isolated TestClient backed by a clean copy of the multi-market database (or public snapshot in CI)."""
    import json
    import shutil

    from app.database import DEFAULT_DB_PATH, Database

    db_copy = tmp_path / "multimarket_artha.db"
    if DEFAULT_DB_PATH.exists():
        shutil.copy2(DEFAULT_DB_PATH, db_copy)
    else:
        snap_path = Path(__file__).resolve().parent.parent / "static" / "data" / "market_snapshot.json"
        assert snap_path.exists(), f"Expected either {DEFAULT_DB_PATH} or {snap_path}"
        snap = json.loads(snap_path.read_text(encoding="utf-8"))
        db = Database(db_path=db_copy)
        for c in snap["companies"]:
            db.upsert_company(
                ticker=c["ticker"],
                name=c["name"],
                sector=c["sector"],
                cap_tier=c["cap_tier"],
                is_financial=bool(c["is_financial"]),
                data_source=c.get("data_source", "real_nse_screener"),
                promoter_pct=float(c.get("promoter_pct") or 0.0),
                inst_pct=float(c.get("inst_pct") or 0.0),
                market=c.get("market", "IN"),
                currency=c.get("currency", "INR"),
            )
        db.upsert_stage1_funnel(snap["stage1_funnel"])
        db.upsert_fundamentals(
            (
                f["ticker"],
                int(f["fiscal_year"]),
                f["period_end"],
                f["reported_date"],
                float(f["revenue_cr"]),
                float(f["ebitda_cr"]),
                float(f["ebit_cr"]),
                float(f["net_profit_cr"]),
                float(f["cfo_cr"]),
                float(f["fcf_cr"]),
                float(f["total_assets_cr"]),
                float(f["total_equity_cr"]),
                float(f["total_debt_cr"]),
                float(f["current_assets_cr"]),
                float(f["current_liabilities_cr"]),
                float(f["shares_cr"]),
                float(f["roce_pct"]),
                float(f["roe_pct"]),
                float(f["op_margin_pct"]),
                float(f["debt_to_equity"]),
                float(f["cfo_to_ebitda_pct"]),
            )
            for f in snap["fundamentals"]
        )
        for q in snap.get("quarterly_signals", []):
            db.upsert_quarterly_signals(q)
        dates = snap["price_dates"]
        price_rows = [
            (tk, dates[idx], float(px), 0.0)
            for tk, series in snap["prices"].items()
            for idx, px in enumerate(series)
            if px is not None
        ]
        db.upsert_prices(price_rows)

    app = create_app(db_path=db_copy, seed_fallback_if_empty=False)
    with app.state.db.connect() as conn:
        conn.execute("DELETE FROM sessions;")
        conn.execute("DELETE FROM saved_plans;")
        conn.execute("DELETE FROM users;")

    client = TestClient(app, base_url="https://127.0.0.1:8000")
    status_res = client.get("/api/auth/status")
    assert status_res.status_code == 200
    pre_csrf = status_res.json()["csrf_token"]

    setup_res = client.post(
        "/api/auth/setup",
        json={"username": "qa_multimarket", "password": "StrongPassphrase!2026"},
        headers={"X-CSRF-Token": pre_csrf},
    )
    assert setup_res.status_code == 200
    return client, setup_res.json()["csrf_token"]


def test_multimarket_screener_score_breakdown_and_company_detail(tmp_path: Path) -> None:
    client, csrf = _authenticated_multimarket_client(tmp_path)

    # 1. market="ALL" screener returns combined NSE + Nasdaq-100 universe with dual benchmarks
    all_res = client.post(
        "/api/screener",
        json={"preset": "artha_blend", "sector": "ALL", "min_score": 0, "market": "ALL"},
        headers={"X-CSRF-Token": csrf},
    )
    assert all_res.status_code == 200
    all_body = all_res.json()
    assert all_body["market"] == "ALL"
    mc = all_body["market_counts"]
    assert mc["IN"] >= 190
    assert mc["US"] >= 90
    assert mc["ALL"] == mc["IN"] + mc["US"]
    assert all_body["benchmark_nifty50"] > 10_000
    assert all_body["benchmark_nasdaq100"] > 10_000
    assert len(all_body["stocks"]) == mc["ALL"]
    assert [all_body["stocks"][0]["rank"], all_body["stocks"][-1]["rank"]] == [1, mc["ALL"]]

    # Verify score_breakdown math and market_label across every single stock
    for st in all_body["stocks"]:
        assert st["market"] in {"IN", "US"}
        expected_label = "US Stock" if st["market"] == "US" else "Indian Stock"
        expected_ccy = "USD" if st["market"] == "US" else "INR"
        assert st["market_label"] == expected_label
        assert st["currency"] == expected_ccy

        sb = st["score_breakdown"]
        assert set(sb["contributions"].keys()) == {"quality", "value", "growth", "momentum"}
        contrib_sum = sum(sb["contributions"].values())
        assert abs(contrib_sum - sb["raw_composite"]) <= 0.25
        clamped_final = max(0.0, min(100.0, sb["raw_composite"] - sb["total_penalty"]))
        assert abs(clamped_final - sb["final_score"]) <= 0.25
        assert abs(st["composite_score"] - sb["final_score"]) <= 0.05
        assert isinstance(sb["rating_rule"], str) and len(sb["rating_rule"]) > 0

    by_tk = {s["ticker"]: s for s in all_body["stocks"]}
    for us_tk in ("MSFT", "NVDA", "AAPL", "COST", "META"):
        assert us_tk in by_tk
        assert by_tk[us_tk]["market"] == "US"
        assert by_tk[us_tk]["market_label"] == "US Stock"
        assert by_tk[us_tk]["market_cap_cr"] > 100_000  # > $100B in $M units
        assert 5.0 < by_tk[us_tk]["metrics"]["pe_ratio"] < 99.0

    for in_tk in ("MUTHOOTFIN.NS", "ICICIBANK.NS", "TCS.NS"):
        assert in_tk in by_tk
        assert by_tk[in_tk]["market"] == "IN"
        assert by_tk[in_tk]["market_label"] == "Indian Stock"
        assert by_tk[in_tk]["market_cap_cr"] > 50_000  # > ₹50,000 Cr

    # 2. market="IN" scopes strictly to Indian stocks and re-numbers rank 1..N_IN
    in_res = client.post(
        "/api/screener",
        json={"preset": "artha_blend", "sector": "ALL", "min_score": 0, "market": "IN"},
        headers={"X-CSRF-Token": csrf},
    )
    assert in_res.status_code == 200
    in_stocks = in_res.json()["stocks"]
    assert len(in_stocks) == mc["IN"]
    assert all(s["market"] == "IN" and s["market_label"] == "Indian Stock" for s in in_stocks)
    assert [s["rank"] for s in in_stocks] == list(range(1, len(in_stocks) + 1))

    # 3. market="US" scopes strictly to US Nasdaq-100 stocks and re-numbers rank 1..N_US
    us_res = client.post(
        "/api/screener",
        json={"preset": "artha_blend", "sector": "ALL", "min_score": 0, "market": "US"},
        headers={"X-CSRF-Token": csrf},
    )
    assert us_res.status_code == 200
    us_stocks = us_res.json()["stocks"]
    assert len(us_stocks) == mc["US"]
    assert all(s["market"] == "US" and s["market_label"] == "US Stock" for s in us_stocks)
    assert [s["rank"] for s in us_stocks] == list(range(1, len(us_stocks) + 1))

    # 4. /api/company/{ticker} for both US and Indian symbols (including custom weights)
    msft_res = client.get("/api/company/MSFT?preset=custom&w_q=50&w_v=20&w_g=20&w_m=10")
    assert msft_res.status_code == 200
    msft = msft_res.json()
    assert msft["scorecard"]["ticker"] == "MSFT"
    assert msft["scorecard"]["market"] == "US"
    assert msft["scorecard"]["market_label"] == "US Stock"
    assert msft["scorecard"]["score_breakdown"]["preset_used"] == "custom"
    assert msft["scorecard"]["score_breakdown"]["weights_pct"]["quality"] == 50.0
    assert len(msft["fundamentals"]) >= 5
    assert len(msft["price_history"]) >= 100

    muthoot_res = client.get("/api/company/MUTHOOTFIN.NS?preset=qglp_compounder")
    assert muthoot_res.status_code == 200
    muthoot = muthoot_res.json()
    assert muthoot["scorecard"]["ticker"] == "MUTHOOTFIN.NS"
    assert muthoot["scorecard"]["market"] == "IN"
    assert muthoot["scorecard"]["market_label"] == "Indian Stock"
    assert muthoot["scorecard"]["score_breakdown"]["preset_used"] == "qglp_compounder"


def test_multimarket_planner_and_backtester(tmp_path: Path) -> None:
    client, csrf = _authenticated_multimarket_client(tmp_path)

    # 1. Planner across market="IN", market="US", and market="ALL"
    pl_in = client.post(
        "/api/planner",
        json={
            "market": "IN",
            "lump_sum_inr": 500_000,
            "monthly_sip_inr": 0,
            "horizon_years": 7,
            "target_corpus_inr": 1_300_000,
            "risk_profile": "equity_direct",
            "preset": "qglp_compounder",
            "max_stocks": 8,
            "save_plan": False,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert pl_in.status_code == 200
    pl_in_body = pl_in.json()
    assert pl_in_body["market"] == "IN"
    assert pl_in_body["plan_currency"] == "INR"
    assert len(pl_in_body["stock_basket"]) == 8
    assert all(
        s["market"] == "IN" and s["market_label"] == "Indian Stock" and s["currency"] == "INR"
        for s in pl_in_body["stock_basket"]
    )

    pl_us = client.post(
        "/api/planner",
        json={
            "market": "US",
            "lump_sum_inr": 10_000,
            "monthly_sip_inr": 250,
            "horizon_years": 7,
            "target_corpus_inr": 26_000,
            "risk_profile": "equity_direct",
            "preset": "qglp_compounder",
            "max_stocks": 8,
            "save_plan": False,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert pl_us.status_code == 200
    pl_us_body = pl_us.json()
    assert pl_us_body["market"] == "US"
    assert pl_us_body["plan_currency"] == "USD"
    assert len(pl_us_body["stock_basket"]) == 8
    assert all(
        s["market"] == "US" and s["market_label"] == "US Stock" and s["currency"] == "USD" and s["est_shares"] >= 1
        for s in pl_us_body["stock_basket"]
    )

    pl_all = client.post(
        "/api/planner",
        json={
            "market": "ALL",
            "lump_sum_inr": 500_000,
            "monthly_sip_inr": 0,
            "horizon_years": 7,
            "target_corpus_inr": 1_300_000,
            "risk_profile": "equity_direct",
            "preset": "qglp_compounder",
            "max_stocks": 8,
            "save_plan": False,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert pl_all.status_code == 200
    pl_all_body = pl_all.json()
    assert pl_all_body["market"] == "ALL"
    assert pl_all_body["plan_currency"] == "INR"
    assert len(pl_all_body["stock_basket"]) == 8
    for item in pl_all_body["stock_basket"]:
        assert item["market"] in {"IN", "US"}
        assert item["market_label"] in {"Indian Stock", "US Stock"}

    # 2. Backtester across market="IN", market="US", and market="ALL"
    bt_in = client.post(
        "/api/backtest",
        json={
            "market": "IN",
            "preset": "artha_blend",
            "lookback_years": 5,
            "top_n": 10,
            "rebalance": "quarterly",
            "weighting": "inv_vol",
            "initial_capital": 500_000,
            "cost_bps": 25,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert bt_in.status_code == 200
    bt_in_body = bt_in.json()
    assert bt_in_body["summary"]["market"] == "IN"
    assert bt_in_body["summary"]["benchmark_name"] == "Nifty 50 (^NSEI)"
    assert bt_in_body["summary"]["currency"] == "INR"
    assert all(h["market"] == "IN" and h["market_label"] == "Indian Stock" for h in bt_in_body["latest_holdings"])

    bt_us = client.post(
        "/api/backtest",
        json={
            "market": "US",
            "preset": "artha_blend",
            "lookback_years": 5,
            "top_n": 10,
            "rebalance": "quarterly",
            "weighting": "inv_vol",
            "initial_capital": 10_000,
            "cost_bps": 25,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert bt_us.status_code == 200
    bt_us_body = bt_us.json()
    assert bt_us_body["summary"]["market"] == "US"
    assert bt_us_body["summary"]["benchmark_name"] == "Nasdaq 100 (^NDX)"
    assert bt_us_body["summary"]["currency"] == "USD"
    assert bt_us_body["summary"]["final_portfolio_inr"] > 10_000
    assert all(h["market"] == "US" and h["market_label"] == "US Stock" for h in bt_us_body["latest_holdings"])

    bt_all = client.post(
        "/api/backtest",
        json={
            "market": "ALL",
            "preset": "artha_blend",
            "lookback_years": 5,
            "top_n": 10,
            "rebalance": "quarterly",
            "weighting": "inv_vol",
            "initial_capital": 500_000,
            "cost_bps": 25,
        },
        headers={"X-CSRF-Token": csrf},
    )
    assert bt_all.status_code == 200
    bt_all_body = bt_all.json()
    assert bt_all_body["summary"]["market"] == "ALL"
    assert bt_all_body["summary"]["currency"] == "INR"
    assert len(bt_all_body["latest_holdings"]) == 10


def test_public_snapshot_and_static_frontend_security_invariants() -> None:
    import json
    import re

    root = Path(__file__).resolve().parent.parent
    snap_path = root / "static" / "data" / "market_snapshot.json"
    assert snap_path.exists()
    raw_snap = snap_path.read_text(encoding="utf-8")
    for sensitive in ('"users"', '"sessions"', '"saved_plans"', '"password_hash"', '"session_hash"', '"csrf_token"'):
        assert sensitive not in raw_snap

    snap = json.loads(raw_snap)
    in_s1 = [r for r in snap["stage1_funnel"] if r.get("market") == "IN" and r.get("deep_scored")]
    us_s1 = [r for r in snap["stage1_funnel"] if r.get("market") == "US" and r.get("deep_scored")]
    assert len(in_s1) >= 190
    assert len(us_s1) >= 90
    assert "^NSEI" in snap["prices"] and sum(1 for v in snap["prices"]["^NSEI"] if v is not None) >= 1000
    assert "^NDX" in snap["prices"] and sum(1 for v in snap["prices"]["^NDX"] if v is not None) >= 1000

    # Verify static HTML & JS security rules and 100% DOM ID alignment
    forbidden = [
        r"\binnerHTML\b",
        r"\bouterHTML\b",
        r"\binsertAdjacentHTML\b",
        r"document\.write",
        r"\blocalStorage\b",
        r"\bsessionStorage\b",
        r"(?<![.\w])alert\s*\(",
        r"(?<![.\w])confirm\s*\(",
        r"(?<![.\w])prompt\s*\(",
        r"(?<![.\w])eval\s*\(",
        r'style="',
        r"style='",
        r"\.style\.",
    ]
    for f in sorted((root / "static").rglob("*")):
        if f.suffix in {".html", ".js"}:
            for line_no, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("//") or stripped.startswith("/*") or stripped.startswith("*"):
                    continue
                code_part = re.sub(r"//.*$", "", line) if f.suffix == ".js" else line
                for pat in forbidden:
                    assert not re.search(pat, code_part), f"Forbidden pattern {pat} in {f.name}:{line_no}"

    html_ids = set(re.findall(r'id="([^"]+)"', (root / "static" / "index.html").read_text(encoding="utf-8")))
    js_ids = set(
        re.findall(r'getElementById\(\s*["\']([^"\']+)["\']\s*\)', (root / "static" / "app.js").read_text(encoding="utf-8"))
    )
    assert len(js_ids) >= 80
    assert js_ids - html_ids == set()
