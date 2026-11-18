#!/bin/sh
set -eu

rm -rf dist
mkdir -p dist/static
cp static/index.html dist/index.html
cp -R static/* dist/static/
if [ -f static/sw.js ]; then
  cp static/sw.js dist/sw.js
fi

mkdir -p netlify/functions/data

# Compute exact baseline composite_score & rating per preset for all 707 tickers
SCORES_TMP="/tmp/aq_baseline_scores_$$.json"
rm -f "$SCORES_TMP"

if command -v node >/dev/null 2>&1; then
  SCORES_OUT="$SCORES_TMP" node --input-type=module - <<'EOF'
import fs from "node:fs";

const rawSnap = JSON.parse(fs.readFileSync("static/data/market_snapshot.json", "utf-8"));
globalThis.window = {
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => rawSnap,
  }),
};

const { getSnapshot, scoreUniversePointInTime, PRESET_WEIGHTS } = await import("./static/standalone_engine.js");
const snapshot = await getSnapshot();
const dates = snapshot.price_dates || [];
const asOf = dates[dates.length - 1] || snapshot.as_of_date || "";

const out = {};
for (const preset of Object.keys(PRESET_WEIGHTS)) {
  const scored = scoreUniversePointInTime(snapshot, asOf, preset, null, true);
  for (const row of scored) {
    if (!out[row.ticker]) out[row.ticker] = {};
    out[row.ticker][preset] = {
      score: row.composite_score,
      rating: row.rating,
    };
  }
}
fs.writeFileSync(process.env.SCORES_OUT, JSON.stringify(out), "utf-8");
EOF
elif [ -x ".venv/bin/python" ]; then
  SCORES_OUT="$SCORES_TMP" .venv/bin/python - <<'EOF'
import json
import os
import pathlib
import pandas as pd
from app.factors import PRESET_WEIGHTS, score_universe_point_in_time

snap = json.loads(pathlib.Path("static/data/market_snapshot.json").read_text(encoding="utf-8"))
dates = snap.get("price_dates") or []
as_of = dates[-1] if dates else (snap.get("as_of_date") or "")
companies = snap.get("companies") or []
fund_df = pd.DataFrame(snap.get("fundamentals") or [])
prices_dict = {tk: arr for tk, arr in (snap.get("prices") or {}).items() if len(arr) == len(dates)}
price_mat = pd.DataFrame(prices_dict, index=dates).sort_index().ffill() if dates else pd.DataFrame()
stage1 = {r["ticker"]: r for r in (snap.get("stage1_funnel") or []) if isinstance(r, dict) and r.get("ticker")}
qtr_signals = snap.get("quarterly_signals") or {}
street_signals = snap.get("street_signals") or {}

out = {}
for preset in PRESET_WEIGHTS:
    scored = score_universe_point_in_time(
        companies,
        fund_df,
        price_mat,
        as_of_date=as_of,
        preset=preset,
        stage1_lookup=stage1,
        quarterly_signals=qtr_signals,
        street_signals=street_signals,
    )
    for row in scored:
        out.setdefault(row["ticker"], {})[preset] = {
            "score": row["composite_score"],
            "rating": row["rating"],
        }

pathlib.Path(os.environ["SCORES_OUT"]).write_text(json.dumps(out), encoding="utf-8")
EOF
fi

SCORES_IN="$SCORES_TMP" python3 - <<'EOF'
import json
import os
import pathlib

snap_path = pathlib.Path("static/data/market_snapshot.json")
out_path = pathlib.Path("netlify/functions/data/stock_ai_context.json")
scores_path = pathlib.Path(os.environ.get("SCORES_IN", ""))

with snap_path.open("r", encoding="utf-8") as fh:
    snap = json.load(fh)

precomputed_scores = {}
if scores_path.is_file():
    with scores_path.open("r", encoding="utf-8") as sfh:
        precomputed_scores = json.load(sfh)

as_of_date = snap.get("as_of_date") or ""
dates = snap.get("price_dates") or []
if dates:
    as_of_date = dates[-1]

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

def _latest_px(sym):
    series = prices_map.get(sym) or []
    for px in reversed(series):
        if px is not None:
            return _r(px, 2)
    return None

benchmarks = {}
for bm_sym in ("^NSEI", "^GSPC", "^NDX"):
    bm_px = _latest_px(bm_sym)
    if bm_px is not None and bm_px > 0:
        benchmarks[bm_sym] = bm_px

stocks = {}
for comp in snap.get("companies", []):
    ticker = comp.get("ticker")
    if not ticker:
        continue
    s1 = stage1_by_ticker.get(ticker) or {}
    last_price = s1.get("last_price")
    if last_price is None:
        last_price = _latest_px(ticker)

    raw_tag = str(comp.get("index_tag") or s1.get("index_tag") or "").strip().upper()
    if comp.get("market") == "US" or raw_tag in ("NASDAQ100", "SP500"):
        market_code = "US"
        index_tag = "SP500" if raw_tag == "SP500" else "NASDAQ100"
        currency = "USD"
    else:
        market_code = "IN"
        index_tag = "NIFTY200"
        currency = "INR"

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

    tk_presets = precomputed_scores.get(ticker) or {}
    default_ps = tk_presets.get("qglp_compounder") or {}
    fallback_score = _r(s1.get("stage1_score"), 1)
    if fallback_score is None:
        fallback_score = 50.0
    comp_score = _r(default_ps.get("score"), 1)
    if comp_score is None:
        comp_score = fallback_score
    comp_rating = str(default_ps.get("rating") or ("Buy" if comp_score >= 68 else "Hold" if comp_score >= 48 else "Avoid"))

    stocks[ticker] = {
        "name": comp.get("name") or ticker,
        "sector": comp.get("sector") or s1.get("sector") or "",
        "industry": comp.get("industry") or s1.get("industry") or comp.get("sector") or "",
        "market": market_code,
        "index_tag": index_tag,
        "currency": currency,
        "is_financial": bool(comp.get("is_financial")),
        "business_summary": comp.get("business_summary") or "",
        "last_price": _r(last_price, 2),
        "composite_score": comp_score,
        "rating": comp_rating,
        "preset_scores": tk_presets,
        "latest_fundamentals": compact_fy,
        "quarterly_signal": compact_qtr,
        "street_signal": compact_street,
    }

payload = {
    "as_of_date": as_of_date,
    "stock_count": len(stocks),
    "benchmarks": benchmarks,
    "stocks": stocks,
}
out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
size_kb = out_path.stat().st_size / 1024.0
print(f"Generated {out_path} ({len(stocks)} stocks, {size_kb:.1f} KB, as_of={as_of_date})")
EOF
rm -f "$SCORES_TMP"

echo "Built Netlify publish directory at dist/"
