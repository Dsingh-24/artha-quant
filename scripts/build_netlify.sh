#!/bin/sh
set -eu

rm -rf dist
mkdir -p dist/static
cp static/index.html dist/index.html
cp -R static/* dist/static/

mkdir -p netlify/functions/data
python3 - <<'EOF'
import json
import pathlib

snap_path = pathlib.Path("static/data/market_snapshot.json")
out_path = pathlib.Path("netlify/functions/data/stock_ai_context.json")

with snap_path.open("r", encoding="utf-8") as fh:
    snap = json.load(fh)

as_of_date = snap.get("as_of_date") or ""
stage1_by_ticker = {
    row["ticker"]: row
    for row in snap.get("stage1_funnel", [])
    if isinstance(row, dict) and row.get("ticker")
}

fund_by_ticker = {}
for row in snap.get("fundamentals", []):
    if not isinstance(row, dict) or not row.get("ticker"):
        continue
    fund_by_ticker.setdefault(row["ticker"], []).append(row)

qtr_map = snap.get("quarterly_signals") or {}
street_map = snap.get("street_signals") or {}
prices_map = snap.get("prices") or {}

def _r(val, ndigits=2):
    if val is None:
        return None
    try:
        return round(float(val), ndigits)
    except (TypeError, ValueError):
        return None

stocks = {}
for comp in snap.get("companies", []):
    ticker = comp.get("ticker")
    if not ticker:
        continue
    s1 = stage1_by_ticker.get(ticker) or {}
    last_price = s1.get("last_price")
    if last_price is None:
        series = prices_map.get(ticker) or []
        for px in reversed(series):
            if px is not None:
                last_price = px
                break

    frows = sorted(
        fund_by_ticker.get(ticker, []),
        key=lambda r: int(r.get("fiscal_year") or 0),
    )[-5:]
    compact_fy = [
        {
            "fy": int(r.get("fiscal_year") or 0),
            "rev": _r(r.get("revenue_cr"), 1),
            "ebitda": _r(r.get("ebitda_cr"), 1),
            "pat": _r(r.get("net_profit_cr"), 1),
            "cfo": _r(r.get("cfo_cr"), 1),
            "fcf": _r(r.get("fcf_cr"), 1),
            "debt": _r(r.get("total_debt_cr"), 1),
            "equity": _r(r.get("total_equity_cr"), 1),
            "shares": _r(r.get("shares_cr"), 3),
            "roce_pct": _r(r.get("roce_pct"), 1),
            "roe_pct": _r(r.get("roe_pct"), 1),
            "opm_pct": _r(r.get("op_margin_pct"), 1),
            "de": _r(r.get("debt_to_equity"), 2),
            "cfo_ebitda_pct": _r(r.get("cfo_to_ebitda_pct"), 1),
        }
        for r in frows
    ]

    qraw = qtr_map.get(ticker) or {}
    compact_qtr = (
        {
            "latest_qtr_label": qraw.get("latest_qtr_label") or "",
            "ttm_rev": _r(qraw.get("ttm_rev_cr"), 1),
            "ttm_pat": _r(qraw.get("ttm_pat_cr"), 1),
            "qtr_rev_yoy_pct": _r(qraw.get("qtr_rev_yoy_pct"), 1),
            "qtr_pat_yoy_pct": _r(qraw.get("qtr_pat_yoy_pct"), 1),
            "qtr_opm_delta_pct": _r(qraw.get("qtr_opm_delta_pct"), 1),
            "gnpa_pct": _r(qraw.get("gnpa_pct"), 2),
            "nnpa_pct": _r(qraw.get("nnpa_pct"), 2),
        }
        if qraw
        else None
    )

    sraw = street_map.get(ticker) or {}
    compact_street = (
        {
            "analyst_count": int(sraw.get("analyst_count") or 0),
            "consensus_buy_pct": _r(sraw.get("consensus_buy_pct"), 1),
            "recommendation_key": sraw.get("recommendation_key") or "",
            "target_mean_price": _r(sraw.get("target_mean_price"), 2),
            "target_high_price": _r(sraw.get("target_high_price"), 2),
            "target_low_price": _r(sraw.get("target_low_price"), 2),
            "forward_pe": _r(sraw.get("forward_pe"), 1),
            "fwd_eps_growth_fy1_pct": _r(sraw.get("fwd_eps_growth_fy1_pct"), 1),
            "fwd_eps_growth_fy2_pct": _r(sraw.get("fwd_eps_growth_fy2_pct"), 1),
            "rev_breadth_pct": _r(sraw.get("rev_breadth_pct"), 1),
            "inst_held_pct": _r(sraw.get("inst_held_pct"), 1),
        }
        if sraw
        else None
    )

    stocks[ticker] = {
        "name": comp.get("name") or ticker,
        "sector": comp.get("sector") or s1.get("sector") or "",
        "industry": comp.get("industry") or s1.get("industry") or comp.get("sector") or "",
        "market": comp.get("market") or s1.get("market") or "IN",
        "index_tag": comp.get("index_tag") or s1.get("index_tag") or "",
        "currency": comp.get("currency") or s1.get("currency") or "INR",
        "is_financial": bool(comp.get("is_financial")),
        "business_summary": comp.get("business_summary") or "",
        "last_price": _r(last_price, 2),
        "latest_fundamentals": compact_fy,
        "quarterly_signal": compact_qtr,
        "street_signal": compact_street,
    }

payload = {
    "as_of_date": as_of_date,
    "stock_count": len(stocks),
    "stocks": stocks,
}
out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
size_kb = out_path.stat().st_size / 1024.0
print(f"Generated {out_path} ({len(stocks)} stocks, {size_kb:.1f} KB, as_of={as_of_date})")
EOF

echo "Built Netlify publish directory at dist/"
