"""Export sanitized public global (`IN` + `US` Nasdaq-100 & S&P 500) market data into `static/data/market_snapshot.json`.

Security guarantee:
- Reads ONLY public market tables (`companies`, `stage1_funnel`, `fundamentals_annual`,
  `company_quarterly_signals`, `company_street_signals`, `daily_prices`).
- NEVER reads or exports `users`, `sessions`, or `saved_plans`.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from app.database import DEFAULT_DB_PATH, Database


def export_public_snapshot(db_path: Path = DEFAULT_DB_PATH, out_path: Path | None = None) -> dict:
    if out_path is None:
        out_path = ROOT_DIR / "static" / "data" / "market_snapshot.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    db = Database(db_path=db_path)
    companies = [
        {
            "ticker": c["ticker"],
            "name": c["name"],
            "sector": c["sector"],
            "industry": c.get("industry", ""),
            "business_summary": c.get("business_summary", ""),
            "cap_tier": c["cap_tier"],
            "is_financial": bool(c["is_financial"]),
            "promoter_pct": round(float(c.get("promoter_pct") or 0.0), 2),
            "inst_pct": round(float(c.get("inst_pct") or 0.0), 2),
            "data_source": c.get("data_source", "real_nse_screener"),
            "market": c.get("market", "IN"),
            "currency": c.get("currency", "INR"),
            "index_tag": c.get("index_tag") or ("NIFTY200" if c.get("market", "IN") == "IN" else "NASDAQ100"),
        }
        for c in db.get_all_companies()
    ]

    stage1_funnel = [
        {
            "ticker": r["ticker"],
            "name": r["name"],
            "sector": r["sector"],
            "industry": r.get("industry", ""),
            "last_price": round(float(r["last_price"]), 2),
            "ret_6m_pct": round(float(r["ret_6m_pct"]), 1),
            "mom_12_1_pct": round(float(r["mom_12_1_pct"]), 1),
            "volatility_pct": round(float(r["volatility_pct"]), 1),
            "dist_52w_high_pct": round(float(r["dist_52w_high_pct"]), 1),
            "above_200dma": int(r["above_200dma"]),
            "avg_turnover_cr": round(float(r["avg_turnover_cr"]), 2),
            "stage1_score": round(float(r["stage1_score"]), 1),
            "stage1_rank": int(r["stage1_rank"]),
            "deep_scored": int(r["deep_scored"]),
            "market": r.get("market", "IN"),
            "currency": r.get("currency", "INR"),
            "index_tag": r.get("index_tag") or ("NIFTY200" if r.get("market", "IN") == "IN" else "NASDAQ100"),
        }
        for r in db.get_stage1_funnel()
    ]

    fundamentals = db.get_all_fundamentals()
    qtr_signals = db.get_all_quarterly_signals()
    raw_street = db.get_all_street_signals()
    street_signals = {
        tk: {
            "ticker": tk,
            "signals_as_of_date": str(s.get("signals_as_of_date") or ""),
            "analyst_count": int(s.get("analyst_count") or 0),
            "strong_buy_count": int(s.get("strong_buy_count") or 0),
            "buy_count": int(s.get("buy_count") or 0),
            "hold_count": int(s.get("hold_count") or 0),
            "sell_count": int(s.get("sell_count") or 0),
            "strong_sell_count": int(s.get("strong_sell_count") or 0),
            "consensus_buy_pct": round(float(s.get("consensus_buy_pct") or 0.0), 1),
            "recommendation_key": str(s.get("recommendation_key") or "none"),
            "target_mean_price": round(float(s.get("target_mean_price") or 0.0), 2),
            "target_high_price": round(float(s.get("target_high_price") or 0.0), 2),
            "target_low_price": round(float(s.get("target_low_price") or 0.0), 2),
            "forward_pe": round(float(s.get("forward_pe") or 0.0), 2),
            "fwd_eps_growth_fy1_pct": round(float(s.get("fwd_eps_growth_fy1_pct") or 0.0), 2),
            "fwd_eps_growth_fy2_pct": round(float(s.get("fwd_eps_growth_fy2_pct") or 0.0), 2),
            "eps_rev_up_30d": int(s.get("eps_rev_up_30d") or 0),
            "eps_rev_down_30d": int(s.get("eps_rev_down_30d") or 0),
            "eps_rev_up_90d": int(s.get("eps_rev_up_90d") or 0),
            "eps_rev_down_90d": int(s.get("eps_rev_down_90d") or 0),
            "rev_breadth_pct": round(float(s.get("rev_breadth_pct") or 0.0), 1),
            "inst_held_pct": round(float(s.get("inst_held_pct") or 0.0), 2),
            "recent_bank_actions": list(s.get("recent_bank_actions") or []),
            "top_holders": list(s.get("top_holders") or []),
        }
        for tk, s in raw_street.items()
    }
    raw_prices = db.get_all_prices()

    # Build compact aligned price matrix: dates[] + prices[ticker] -> list of floats/None
    all_dates = sorted({r["trade_date"] for r in raw_prices})
    date_idx = {d: i for i, d in enumerate(all_dates)}
    n_dates = len(all_dates)

    prices_by_tk: dict[str, list[float | None]] = {}
    for r in raw_prices:
        tk = r["ticker"]
        arr = prices_by_tk.get(tk)
        if arr is None:
            arr = [None] * n_dates
            prices_by_tk[tk] = arr
        arr[date_idx[r["trade_date"]]] = round(float(r["close_price"]), 2)

    # Forward-fill inside each ticker after its first valid trading session (matching pandas .ffill())
    for tk, arr in prices_by_tk.items():
        last_val = None
        for i, val in enumerate(arr):
            if val is not None:
                last_val = val
            elif last_val is not None:
                arr[i] = last_val

    payload = {
        "snapshot_version": "3.0.0",
        "as_of_date": all_dates[-1] if all_dates else "2026-11-16",
        "companies": companies,
        "stage1_funnel": stage1_funnel,
        "fundamentals": fundamentals,
        "quarterly_signals": qtr_signals,
        "street_signals": street_signals,
        "price_dates": all_dates,
        "prices": prices_by_tk,
    }

    encoded = json.dumps(payload, separators=(",", ":"))
    out_path.write_text(encoded, encoding="utf-8")
    return {
        "output": str(out_path),
        "size_kb": round(len(encoded) / 1024.0, 1),
        "companies": len(companies),
        "fundamentals": len(fundamentals),
        "street_signals": len(street_signals),
        "price_dates": len(all_dates),
    }


if __name__ == "__main__":
    summary = export_public_snapshot()
    print("Exported public snapshot:", summary)
