"""Indian NSE stock universe, calibrated multi-year dataset seeder, live yfinance sync, and CSV importer.

Conventions:
- Monetary fundamentals stored in Indian Rupees Crores (`₹ Cr`, 1 Crore = 10,000,000 INR).
- Indian Fiscal Year ends March 31 (`FY2026` -> `2026-03-31`).
- Point-in-Time Reporting Lag: Annual results become visible to the backtester 60 days after
  fiscal year-end (`YYYY-05-30`), matching SEBI LODR 60-day audited annual filing rules.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import logging
import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from app.database import Database

logger = logging.getLogger("arthaquant.universe")

BENCHMARK_TICKER = "^NSEI"

# Curated 30 NSE Stocks across 8 core sectors + realistic multi-year operating profiles:
# Tuple: (ticker, name, sector, cap_tier, is_financial, base_rev_cr, rev_cagr, base_opm, opm_trend,
#         base_roce, base_roe, de_ratio, cfo_conv, shares_cr, start_price, drift_annual, vol_annual, quality_regime)
NSE_SEED_SPECS: List[Tuple[Any, ...]] = [
    # IT Services
    ("TCS.NS", "Tata Consultancy Services", "IT Services", "Large Cap", False, 164177, 0.095, 25.2, -0.15, 52.0, 46.5, 0.08, 96.0, 361.8, 2680.0, 0.115, 0.21, "compounder"),
    ("INFY.NS", "Infosys Ltd", "IT Services", "Large Cap", False, 100472, 0.110, 21.8, -0.20, 37.5, 31.2, 0.10, 93.0, 415.0, 1120.0, 0.125, 0.23, "compounder"),
    ("HCLTECH.NS", "HCL Technologies", "IT Services", "Large Cap", False, 75379, 0.108, 19.2, 0.10, 27.8, 23.4, 0.08, 95.0, 271.4, 840.0, 0.165, 0.24, "compounder"),
    ("WIPRO.NS", "Wipro Ltd", "IT Services", "Large Cap", False, 61943, 0.055, 16.5, -0.35, 16.8, 15.1, 0.22, 88.0, 522.0, 360.0, 0.065, 0.25, "stagnant"),
    # Banking & Financials
    ("ICICIBANK.NS", "ICICI Bank Ltd", "Banking & Financials", "Large Cap", True, 98086, 0.175, 28.5, 0.65, 16.5, 17.8, 5.80, 92.0, 704.0, 460.0, 0.215, 0.22, "compounder"),
    ("HDFCBANK.NS", "HDFC Bank Ltd", "Banking & Financials", "Large Cap", True, 128552, 0.165, 29.0, -0.30, 15.2, 16.4, 6.20, 90.0, 761.0, 1280.0, 0.085, 0.20, "steady"),
    ("SBIN.NS", "State Bank of India", "Banking & Financials", "Large Cap", True, 165000, 0.145, 20.0, 0.55, 13.8, 17.2, 10.50, 89.0, 892.5, 280.0, 0.245, 0.27, "rerating"),
    ("BAJFINANCE.NS", "Bajaj Finance Ltd", "Banking & Financials", "Large Cap", True, 26683, 0.245, 34.0, 0.25, 18.5, 22.4, 3.85, 86.0, 61.9, 4400.0, 0.135, 0.28, "compounder"),
    # Consumer, Retail & FMCG
    ("ITC.NS", "ITC Ltd", "Consumer & FMCG", "Large Cap", False, 49272, 0.092, 35.8, 0.35, 36.5, 28.5, 0.01, 94.0, 1248.0, 185.0, 0.185, 0.19, "rerating"),
    ("HINDUNILVR.NS", "Hindustan Unilever", "Consumer & FMCG", "Large Cap", False, 47028, 0.072, 23.6, -0.10, 26.5, 20.4, 0.03, 97.0, 235.0, 2150.0, 0.045, 0.18, "expensive_slow"),
    ("TITAN.NS", "Titan Company Ltd", "Consumer & FMCG", "Large Cap", False, 21644, 0.225, 11.6, 0.15, 29.5, 28.0, 0.55, 82.0, 88.8, 1280.0, 0.195, 0.24, "compounder"),
    ("TRENT.NS", "Trent Ltd", "Consumer & FMCG", "Large Cap", False, 3486, 0.380, 14.8, 0.65, 26.8, 25.4, 0.42, 86.0, 35.5, 690.0, 0.360, 0.31, "compounder"),
    ("PIDILITIND.NS", "Pidilite Industries", "Consumer & FMCG", "Large Cap", False, 7293, 0.135, 21.4, 0.20, 29.2, 23.5, 0.05, 93.0, 50.9, 1560.0, 0.130, 0.21, "compounder"),
    ("ASIANPAINT.NS", "Asian Paints Ltd", "Consumer & FMCG", "Large Cap", False, 21712, 0.082, 19.2, -0.55, 27.0, 23.0, 0.12, 89.0, 95.9, 2220.0, 0.035, 0.22, "expensive_slow"),
    # Auto, Defence & Industrials
    ("M&M.NS", "Mahindra & Mahindra", "Auto & Industrials", "Large Cap", False, 74277, 0.168, 14.8, 0.45, 19.8, 18.4, 0.85, 90.0, 124.3, 640.0, 0.275, 0.26, "rerating"),
    ("MARUTI.NS", "Maruti Suzuki India", "Auto & Industrials", "Large Cap", False, 70372, 0.165, 11.2, 0.45, 20.5, 16.8, 0.02, 95.0, 31.4, 7050.0, 0.135, 0.22, "compounder"),
    ("TATAMOTORS.NS", "Tata Motors Ltd", "Auto & Industrials", "Large Cap", False, 249795, 0.148, 12.2, 0.90, 18.2, 22.5, 1.15, 88.0, 368.0, 165.0, 0.285, 0.33, "rerating"),
    ("LT.NS", "Larsen & Toubro", "Auto & Industrials", "Large Cap", False, 135979, 0.145, 11.8, 0.15, 16.4, 15.2, 1.10, 84.0, 137.5, 1080.0, 0.225, 0.23, "compounder"),
    ("HAL.NS", "Hindustan Aeronautics", "Auto & Industrials", "Large Cap", False, 22755, 0.125, 27.5, 0.65, 31.5, 26.8, 0.01, 102.0, 66.9, 430.0, 0.380, 0.30, "rerating"),
    ("BEL.NS", "Bharat Electronics", "Auto & Industrials", "Large Cap", False, 14108, 0.155, 23.4, 0.45, 33.0, 25.8, 0.01, 96.0, 731.0, 38.0, 0.350, 0.29, "rerating"),
    # Pharma & Healthcare
    ("SUNPHARMA.NS", "Sun Pharmaceutical", "Pharma & Healthcare", "Large Cap", False, 33498, 0.128, 26.4, 0.30, 21.5, 17.8, 0.06, 91.0, 239.9, 520.0, 0.225, 0.20, "compounder"),
    ("DRREDDY.NS", "Dr. Reddy's Laboratories", "Pharma & Healthcare", "Large Cap", False, 19048, 0.125, 26.8, 0.25, 24.5, 20.2, 0.09, 89.0, 83.4, 960.0, 0.115, 0.21, "compounder"),
    ("APOLLOHOSP.NS", "Apollo Hospitals", "Pharma & Healthcare", "Large Cap", False, 10560, 0.178, 13.5, 0.25, 18.6, 15.8, 0.62, 85.0, 14.4, 2300.0, 0.205, 0.25, "compounder"),
    # Energy & Utilities
    ("RELIANCE.NS", "Reliance Industries", "Energy & Utilities", "Large Cap", False, 466924, 0.155, 16.8, 0.20, 11.8, 9.8, 0.42, 88.0, 1353.0, 990.0, 0.095, 0.22, "steady"),
    ("NTPC.NS", "NTPC Ltd", "Energy & Utilities", "Large Cap", False, 115546, 0.115, 24.5, 0.10, 11.9, 13.6, 1.42, 94.0, 969.7, 135.0, 0.245, 0.23, "rerating"),
    ("COALINDIA.NS", "Coal India Ltd", "Energy & Utilities", "Large Cap", False, 90026, 0.118, 31.5, 0.85, 48.0, 42.5, 0.09, 95.0, 616.3, 125.0, 0.235, 0.26, "rerating"),
    # Metals, Cement & Telecom + Traps (for realistic avoidance testing)
    ("ULTRACEMCO.NS", "UltraTech Cement", "Materials & Infra", "Large Cap", False, 44726, 0.145, 18.8, -0.10, 16.8, 13.8, 0.22, 91.0, 28.9, 4850.0, 0.165, 0.22, "compounder"),
    ("TATASTEEL.NS", "Tata Steel Ltd", "Materials & Infra", "Large Cap", False, 156294, 0.075, 13.2, -0.45, 11.4, 9.2, 0.88, 79.0, 1248.0, 55.0, 0.175, 0.31, "cyclical"),
    ("BHARTIARTL.NS", "Bharti Airtel Ltd", "Telecom & Digital", "Large Cap", False, 100616, 0.148, 51.5, 0.85, 16.8, 16.2, 1.95, 96.0, 570.0, 480.0, 0.235, 0.21, "rerating"),
    ("IDEA.NS", "Vodafone Idea Ltd", "Telecom & Digital", "Mid Cap", False, 41952, 0.015, 38.0, -0.40, -3.5, -35.0, 6.50, 52.0, 6960.0, 9.5, -0.025, 0.46, "trap"),
    ("ZEEL.NS", "Zee Entertainment", "Telecom & Digital", "Mid Cap", False, 7729, 0.025, 13.2, -1.10, 7.2, 4.8, 0.18, 48.0, 96.1, 205.0, -0.095, 0.41, "trap"),
]


def _trading_days(start: dt.date, end: dt.date) -> List[dt.date]:
    days: List[dt.date] = []
    cur = start
    while cur <= end:
        if cur.weekday() < 5:
            days.append(cur)
        cur += dt.timedelta(days=1)
    return days


def seed_calibrated_nse_universe(db: Database, force: bool = False) -> Dict[str, int]:
    """Populate SQLite with calibrated 6-year NSE fundamentals and daily price histories if empty."""
    if db.count_companies() >= 20 and not force:
        return {"companies": db.count_companies(), "seeded": 0}

    rng = np.random.default_rng(20261113)
    start_date = dt.date(2020, 11, 2)
    end_date = dt.date(2026, 11, 12)
    dates = _trading_days(start_date, end_date)
    n_days = len(dates)

    # Generate Nifty 50 (^NSEI) benchmark trajectory (~12,000 in Nov 2020 -> ~24,500+ by late 2026)
    mkt_daily_mu = 0.132 / 252.0
    mkt_daily_sigma = 0.155 / math.sqrt(252.0)
    mkt_shocks = rng.normal(loc=mkt_daily_mu, scale=mkt_daily_sigma, size=n_days)
    # Add realistic regime waves (2021 bull, 2022 consolidation, 2023-24 midcap/PSU rally, 2025 breather, 2026 recovery)
    t_idx = np.arange(n_days, dtype=float)
    regime_wave = 0.00022 * np.sin(2.0 * math.pi * t_idx / 380.0)
    mkt_returns = mkt_shocks + regime_wave
    nifty_prices = 11900.0 * np.exp(np.cumsum(mkt_returns))

    benchmark_rows = [
        (BENCHMARK_TICKER, dates[i].isoformat(), round(float(nifty_prices[i]), 2), 250_000_000.0)
        for i in range(n_days)
    ]
    db.upsert_prices(benchmark_rows)

    fiscal_years = [2021, 2022, 2023, 2024, 2025, 2026]
    total_fund_rows: List[Tuple[Any, ...]] = []

    for idx, spec in enumerate(NSE_SEED_SPECS):
        (
            ticker,
            name,
            sector,
            cap_tier,
            is_financial,
            base_rev,
            rev_cagr,
            base_opm,
            opm_trend,
            base_roce,
            base_roe,
            de_ratio,
            cfo_conv,
            shares_cr,
            start_price,
            drift_annual,
            vol_annual,
            regime,
        ) = spec

        db.upsert_company(
            ticker=ticker,
            name=name,
            sector=sector,
            cap_tier=cap_tier,
            is_financial=is_financial,
            data_source="calibrated_nse",
        )

        # Build FY2021..FY2026 annual financial statements with 60-day reporting lag
        local_rng = np.random.default_rng(1000 + idx * 37)
        for y_offset, fy in enumerate(fiscal_years):
            growth_noise = float(local_rng.normal(0.0, 0.022))
            cum_growth = ((1.0 + rev_cagr) ** y_offset) * (1.0 + growth_noise)
            rev_cr = max(250.0, base_rev * cum_growth)

            opm = max(4.0, min(62.0, base_opm + opm_trend * y_offset + float(local_rng.normal(0.0, 0.6))))
            ebitda_cr = rev_cr * (opm / 100.0)
            dep_ratio = 0.08 if is_financial else 0.16
            ebit_cr = ebitda_cr * (1.0 - dep_ratio)

            if regime == "trap" and ticker == "IDEA.NS":
                net_profit_cr = -abs(rev_cr * (0.42 - 0.03 * y_offset))
                roce = base_roce + 0.4 * y_offset
                roe = base_roe + 1.5 * y_offset
            else:
                interest_drag = 0.03 * de_ratio if not is_financial else 0.12
                tax_factor = 0.74
                net_profit_cr = max(rev_cr * 0.015, ebit_cr * max(0.25, 1.0 - interest_drag) * tax_factor)
                roce = max(2.0, base_roce + opm_trend * 0.7 * y_offset + float(local_rng.normal(0.0, 0.8)))
                roe = max(2.0, base_roe + opm_trend * 0.65 * y_offset + float(local_rng.normal(0.0, 0.8)))

            cfo_ratio = max(35.0, min(125.0, cfo_conv + float(local_rng.normal(0.0, 3.5))))
            cfo_cr = ebitda_cr * (cfo_ratio / 100.0)
            capex_cr = rev_cr * (0.015 if is_financial else 0.055)
            fcf_cr = cfo_cr - capex_cr

            total_equity_cr = max(500.0, abs(net_profit_cr) / max(0.05, abs(roe) / 100.0))
            de_cur = max(0.0, de_ratio * (0.96**y_offset if regime in {"compounder", "rerating"} else 1.03**y_offset))
            total_debt_cr = total_equity_cr * de_cur
            total_assets_cr = total_equity_cr + total_debt_cr + rev_cr * 0.28
            current_assets_cr = rev_cr * 0.34
            current_liabilities_cr = rev_cr * (0.21 if regime != "trap" else 0.42)

            period_end = f"{fy}-03-31"
            reported_date = f"{fy}-05-30"  # 60-day SEBI LODR post-FY reporting lag

            total_fund_rows.append(
                (
                    ticker,
                    fy,
                    period_end,
                    reported_date,
                    round(rev_cr, 2),
                    round(ebitda_cr, 2),
                    round(ebit_cr, 2),
                    round(net_profit_cr, 2),
                    round(cfo_cr, 2),
                    round(fcf_cr, 2),
                    round(total_assets_cr, 2),
                    round(total_equity_cr, 2),
                    round(total_debt_cr, 2),
                    round(current_assets_cr, 2),
                    round(current_liabilities_cr, 2),
                    round(shares_cr, 2),
                    round(roce, 2),
                    round(roe, 2),
                    round(opm, 2),
                    round(de_cur, 3),
                    round(cfo_ratio, 2),
                )
            )

        # Generate daily prices correlated with Nifty 50 + fundamental alpha drift
        beta = 0.82 if regime == "compounder" else (1.18 if regime in {"cyclical", "trap"} else 0.98)
        idio_sigma = max(0.10, math.sqrt(max(0.01, vol_annual**2 - (beta * 0.155) ** 2))) / math.sqrt(252.0)
        alpha_daily = (drift_annual - beta * 0.132) / 252.0
        idio_shocks = local_rng.normal(loc=alpha_daily, scale=idio_sigma, size=n_days)
        stock_rets = beta * mkt_returns + idio_shocks
        prices = start_price * np.exp(np.cumsum(stock_rets))
        volumes = local_rng.integers(low=450_000, high=12_000_000, size=n_days)

        price_rows = [
            (ticker, dates[i].isoformat(), round(max(1.5, float(prices[i])), 2), float(volumes[i]))
            for i in range(n_days)
        ]
        db.upsert_prices(price_rows)

    db.upsert_fundamentals(total_fund_rows)
    return {"companies": len(NSE_SEED_SPECS), "seeded": len(NSE_SEED_SPECS)}


def _safe_series_val(df: pd.DataFrame, candidates: List[str], col: Any, default: float = 0.0) -> float:
    if df is None or df.empty:
        return default
    for label in candidates:
        if label in df.index:
            val = df.loc[label, col]
            if pd.notna(val) and not math.isnan(float(val)):
                return float(val)
    return default


def sync_ticker_from_yfinance(db: Database, ticker: str) -> Dict[str, Any]:
    """Fetch live NSE/BSE prices and annual financials via yfinance and upsert into SQLite."""
    import yfinance as yf

    tk = yf.Ticker(ticker)
    hist = tk.history(period="5y", interval="1d", auto_adjust=True)
    if hist is None or hist.empty or "Close" not in hist.columns:
        raise ValueError(f"No market price history returned for {ticker}.")

    info: Dict[str, Any] = {}
    try:
        info = tk.info or {}
    except Exception:
        info = {}

    existing = db.get_company(ticker)
    name = str(info.get("longName") or info.get("shortName") or (existing["name"] if existing else ticker))
    sector = str(info.get("sector") or (existing["sector"] if existing else "Diversified"))
    is_fin = "financial" in sector.lower() or "bank" in name.lower()
    mcap = float(info.get("marketCap") or 0.0)
    cap_tier = "Large Cap" if mcap >= 200_000_000_000 else ("Mid Cap" if mcap >= 50_000_000_000 else "Small/Mid Cap")

    db.upsert_company(
        ticker=ticker,
        name=name[:80],
        sector=sector[:50],
        cap_tier=cap_tier,
        is_financial=is_fin,
        data_source="yfinance_live",
    )

    price_rows: List[Tuple[str, str, float, float]] = []
    for idx_ts, row in hist.iterrows():
        close_val = float(row["Close"])
        if close_val > 0 and not math.isnan(close_val):
            d_str = pd.Timestamp(idx_ts).date().isoformat()
            vol_val = float(row["Volume"]) if "Volume" in row and pd.notna(row["Volume"]) else 0.0
            price_rows.append((ticker, d_str, round(close_val, 2), vol_val))
    db.upsert_prices(price_rows)

    # Attempt financial statement extraction (convert INR -> ₹ Crores by dividing by 1e7)
    inc = getattr(tk, "financials", pd.DataFrame())
    bal = getattr(tk, "balance_sheet", pd.DataFrame())
    cf = getattr(tk, "cashflow", pd.DataFrame())

    fund_rows: List[Tuple[Any, ...]] = []
    shares_cr = float(info.get("sharesOutstanding") or 100_000_000) / 1e7

    if inc is not None and not inc.empty:
        for col in sorted(list(inc.columns)):
            dt_col = pd.Timestamp(col).date()
            fy = dt_col.year
            period_end = dt_col.isoformat()
            reported_date = (dt_col + dt.timedelta(days=60)).isoformat()

            rev = _safe_series_val(inc, ["Total Revenue", "Operating Revenue"], col) / 1e7
            if rev <= 0:
                continue
            ebitda = _safe_series_val(inc, ["EBITDA", "Normalized EBITDA"], col) / 1e7
            ebit = _safe_series_val(inc, ["EBIT", "Operating Income"], col) / 1e7
            if ebitda <= 0 and ebit > 0:
                ebitda = ebit * 1.15
            net_inc = _safe_series_val(inc, ["Net Income", "Net Income Common Stockholders"], col) / 1e7

            cfo = _safe_series_val(cf, ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities"], col) / 1e7
            fcf = _safe_series_val(cf, ["Free Cash Flow"], col) / 1e7
            if fcf == 0.0 and cfo != 0.0:
                capex = abs(_safe_series_val(cf, ["Capital Expenditure"], col)) / 1e7
                fcf = cfo - capex

            tot_assets = _safe_series_val(bal, ["Total Assets"], col, default=rev * 1.4) / 1e7
            tot_eq = _safe_series_val(bal, ["Stockholders Equity", "Total Equity Gross Minority Interest"], col, default=rev * 0.6) / 1e7
            tot_debt = _safe_series_val(bal, ["Total Debt", "Long Term Debt"], col, default=0.0) / 1e7
            cur_assets = _safe_series_val(bal, ["Current Assets"], col, default=rev * 0.3) / 1e7
            cur_liab = _safe_series_val(bal, ["Current Liabilities"], col, default=rev * 0.2) / 1e7

            cap_employed = max(1.0, tot_assets - cur_liab)
            roce_pct = (ebit / cap_employed) * 100.0 if cap_employed > 0 else 0.0
            roe_pct = (net_inc / max(1.0, tot_eq)) * 100.0 if tot_eq > 0 else 0.0
            op_margin_pct = (ebitda / rev) * 100.0
            de_val = tot_debt / max(1.0, tot_eq) if tot_eq > 0 else 5.0
            cfo_ebitda = (cfo / max(1.0, ebitda)) * 100.0 if ebitda > 0 else 0.0

            fund_rows.append(
                (
                    ticker,
                    fy,
                    period_end,
                    reported_date,
                    round(rev, 2),
                    round(ebitda, 2),
                    round(ebit, 2),
                    round(net_inc, 2),
                    round(cfo, 2),
                    round(fcf, 2),
                    round(tot_assets, 2),
                    round(tot_eq, 2),
                    round(tot_debt, 2),
                    round(cur_assets, 2),
                    round(cur_liab, 2),
                    round(max(0.1, shares_cr), 2),
                    round(roce_pct, 2),
                    round(roe_pct, 2),
                    round(op_margin_pct, 2),
                    round(de_val, 3),
                    round(cfo_ebitda, 2),
                )
            )

    if fund_rows:
        db.upsert_fundamentals(fund_rows)

    # Also refresh Nifty 50 benchmark when syncing live
    try:
        bm_hist = yf.Ticker(BENCHMARK_TICKER).history(period="5y", interval="1d", auto_adjust=True)
        if bm_hist is not None and not bm_hist.empty:
            bm_rows = [
                (BENCHMARK_TICKER, pd.Timestamp(ts).date().isoformat(), round(float(r["Close"]), 2), 0.0)
                for ts, r in bm_hist.iterrows()
                if pd.notna(r["Close"]) and float(r["Close"]) > 0
            ]
            db.upsert_prices(bm_rows)
    except Exception as exc:
        logger.debug("Benchmark live refresh skipped: %s", exc)

    return {
        "ticker": ticker,
        "name": name,
        "price_days_synced": len(price_rows),
        "fundamental_years_synced": len(fund_rows),
    }


def import_fundamentals_csv(db: Database, raw_bytes: bytes) -> Dict[str, int]:
    """Validate and import custom Indian company fundamentals from a UTF-8 CSV file."""
    text = raw_bytes.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    required = {"ticker", "name", "sector", "fiscal_year", "revenue_cr", "ebitda_cr", "net_profit_cr", "roce_pct", "roe_pct", "debt_to_equity"}
    if not reader.fieldnames or not required.issubset({h.strip().lower() for h in reader.fieldnames}):
        missing = sorted(list(required - ({h.strip().lower() for h in (reader.fieldnames or [])})))
        raise ValueError(f"CSV missing required columns: {', '.join(missing)}")

    fund_rows: List[Tuple[Any, ...]] = []
    companies_seen = set()
    for raw_row in reader:
        row = {k.strip().lower(): (v or "").strip() for k, v in raw_row.items() if k}
        tk = row["ticker"].upper()
        if not tk.endswith((".NS", ".BO")):
            tk = f"{tk}.NS"
        fy = int(row["fiscal_year"])
        if fy < 2010 or fy > 2035:
            raise ValueError(f"Fiscal year out of valid range: {fy}")

        name = row["name"][:80] or tk
        sector = row["sector"][:50] or "Diversified"
        is_fin = "bank" in sector.lower() or "financial" in sector.lower()
        if tk not in companies_seen:
            db.upsert_company(tk, name, sector, "Custom CSV", is_fin, "csv_import")
            companies_seen.add(tk)

        rev = float(row["revenue_cr"])
        ebitda = float(row["ebitda_cr"])
        ebit = float(row.get("ebit_cr") or ebitda * 0.85)
        pat = float(row["net_profit_cr"])
        cfo = float(row.get("cfo_cr") or ebitda * 0.88)
        fcf = float(row.get("fcf_cr") or cfo * 0.72)
        roce = float(row["roce_pct"])
        roe = float(row["roe_pct"])
        de = float(row["debt_to_equity"])
        shares = float(row.get("shares_cr") or 100.0)
        tot_eq = float(row.get("total_equity_cr") or max(100.0, abs(pat) / max(0.05, abs(roe) / 100.0)))
        tot_debt = tot_eq * de
        tot_assets = tot_eq + tot_debt + rev * 0.25
        opm = (ebitda / max(1.0, rev)) * 100.0
        cfo_ebitda = (cfo / max(1.0, ebitda)) * 100.0

        fund_rows.append(
            (
                tk,
                fy,
                f"{fy}-03-31",
                f"{fy}-05-30",
                round(rev, 2),
                round(ebitda, 2),
                round(ebit, 2),
                round(pat, 2),
                round(cfo, 2),
                round(fcf, 2),
                round(tot_assets, 2),
                round(tot_eq, 2),
                round(tot_debt, 2),
                round(rev * 0.32, 2),
                round(rev * 0.20, 2),
                round(shares, 2),
                round(roce, 2),
                round(roe, 2),
                round(opm, 2),
                round(de, 3),
                round(cfo_ebitda, 2),
            )
        )

    if not fund_rows:
        raise ValueError("CSV contained no valid fundamental rows.")
    db.upsert_fundamentals(fund_rows)
    return {"companies_imported": len(companies_seen), "rows_imported": len(fund_rows)}
