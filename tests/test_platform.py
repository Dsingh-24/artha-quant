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
