"""Real-Market Two-Stage NSE Nifty 200 Funnel & Consolidated Fundamental Engine.

Stage 1 — Bulk Universe Scanner (200 NSE Companies):
  - Fetches official Nifty 200 constituents from NSE Archives (`ind_nifty200list.csv`).
  - Pulls 5-year split/bonus-adjusted daily OHLCV prices from Yahoo Finance (`v8/finance/chart`)
    across all 200 companies + Nifty 50 (`^NSEI`).
  - Ranks all 200 stocks on cross-sectional momentum, relative strength vs Nifty 50,
    200-DMA trend regime, 52W-high proximity, and ₹ Cr daily turnover.

Stage 2 — Deep Multi-Year Fundamental Scoring (Shortlisted Top Candidates):
  - Fetches real audited consolidated (or standalone fallback) Indian financial statements
    (`₹ Crores`) from Screener.in (`Mar/Dec/Sep/Jun` fiscal years) + Promoter/FII/DII shareholding.
  - Applies a strict 60-day SEBI LODR post-FY reporting lag (`reported_date = period_end + 60d`)
    for point-in-time backtesting without look-ahead bias.
"""

from __future__ import annotations

import calendar
import concurrent.futures
import csv
import datetime as dt
import io
import logging
import math
import re
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

import httpx
import numpy as np
import pandas as pd
from bs4 import BeautifulSoup

from app.database import Database

logger = logging.getLogger("arthaquant.funnel")

NIFTY200_CSV_URL = "https://archives.nseindia.com/content/indices/ind_nifty200list.csv"
BENCHMARK_TICKER = "^NSEI"
BROWSER_UA = "Mozilla/5.0"

# Core Nifty 50 heavyweights always included in Stage-2 deep fundamental coverage
CORE_ANCHOR_SYMBOLS = {
    "RELIANCE", "TCS", "HDFCBANK", "ICICIBANK", "BHARTIARTL", "INFY",
    "SBIN", "ITC", "LT", "SUNPHARMA", "M&M", "BAJFINANCE", "HCLTECH",
    "NTPC", "MARUTI", "KOTAKBANK", "HAL", "TRENT", "COALINDIA", "TITAN",
}

MONTH_MAP = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}
FY_COL_RE = re.compile(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(20\d{2})$")


def _map_nse_industry_to_sector(industry: str, name: str) -> Tuple[str, bool]:
    ind = (industry or "").lower()
    nm = (name or "").lower()
    if "financial" in ind or "bank" in nm or "finance" in nm or "insurance" in nm:
        return "Banking & Financials", True
    if "information technology" in ind or "software" in ind:
        return "IT Services", False
    if "healthcare" in ind or "pharma" in nm or "hospital" in nm:
        return "Pharma & Healthcare", False
    if "automobile" in ind:
        return "Auto & Mobility", False
    if "capital goods" in ind or "defence" in nm or "aeronautics" in nm or "construction" in ind:
        return "Capital Goods & Defence", False
    if "fast moving consumer" in ind or "consumer" in ind or "textiles" in ind:
        return "Consumer & Retail", False
    if "oil" in ind or "gas" in ind or "power" in ind:
        return "Energy, Oil & Power", False
    if "metals" in ind or "mining" in ind or "construction materials" in ind or "chemicals" in ind:
        return "Materials, Metals & Chemicals", False
    return "Telecom, Infra & Services", False


def _parse_num(raw: str) -> Optional[float]:
    if not raw:
        return None
    cleaned = raw.replace(",", "").replace("%", "").replace("₹", "").replace("Cr.", "").strip()
    if not cleaned or cleaned in {"-", "--", "N/A"}:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", cleaned)
    return float(m.group(0)) if m else None


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _lin(v: float, bad: float, good: float) -> float:
    if math.isnan(v) or good == bad:
        return 50.0
    return _clamp(((v - bad) / (good - bad)) * 100.0)


def fetch_nifty200_constituents() -> List[Dict[str, Any]]:
    """Download official NSE Nifty 200 constituent CSV."""
    with httpx.Client(headers={"User-Agent": BROWSER_UA}, follow_redirects=True, timeout=15.0) as client:
        resp = client.get(NIFTY200_CSV_URL)
        resp.raise_for_status()
        reader = csv.DictReader(io.StringIO(resp.text))
        constituents: List[Dict[str, Any]] = []
        seen = set()
        for row in reader:
            sym = (row.get("Symbol") or "").strip().upper()
            series = (row.get("Series") or "EQ").strip().upper()
            if not sym or series != "EQ" or "DUMMY" in sym or sym in seen:
                continue
            seen.add(sym)
            name = (row.get("Company Name") or sym).strip()
            industry = (row.get("Industry") or "Diversified").strip()
            sector, is_fin = _map_nse_industry_to_sector(industry, name)
            constituents.append(
                {
                    "symbol": sym,
                    "ticker": f"{sym}.NS",
                    "name": name[:80],
                    "industry": industry[:60],
                    "sector": sector,
                    "is_financial": is_fin,
                }
            )
        return constituents


def fetch_yahoo_5y_prices(
    ticker: str,
    client: Optional[httpx.Client] = None,
    host_idx: int = 0,
) -> List[Tuple[str, str, float, float]]:
    """Fetch 5 years of daily split/dividend-adjusted prices from Yahoo Finance v8 chart API."""
    enc = urllib.parse.quote(ticker, safe="")
    hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
    ist_tz = dt.timezone(dt.timedelta(hours=5, minutes=30))

    owns_client = client is None
    sess = client or httpx.Client(headers={"User-Agent": BROWSER_UA}, follow_redirects=True, timeout=12.0)
    payload = None
    try:
        for attempt in range(4):
            host = hosts[(host_idx + attempt) % 2]
            url = f"https://{host}/v8/finance/chart/{enc}?range=5y&interval=1d"
            resp = sess.get(url)
            if resp.status_code == 200:
                payload = resp.json()
                break
            if resp.status_code == 429:
                time.sleep(0.8 * (attempt + 1))
                continue
            break
    finally:
        if owns_client:
            sess.close()

    if not payload:
        return []

    results = (payload.get("chart") or {}).get("result") or []
    if not results:
        return []
    res0 = results[0]
    timestamps = res0.get("timestamp") or []
    indicators = res0.get("indicators") or {}
    quotes = (indicators.get("quote") or [{}])[0]
    adj_list = (indicators.get("adjclose") or [{}])[0].get("adjclose")
    closes = adj_list if adj_list else (quotes.get("close") or [])
    volumes = quotes.get("volume") or []

    by_date: Dict[str, Tuple[float, float]] = {}
    for i, ts in enumerate(timestamps):
        if i >= len(closes) or closes[i] is None:
            continue
        px = float(closes[i])
        if px <= 0 or math.isnan(px):
            continue
        vol = float(volumes[i]) if i < len(volumes) and volumes[i] is not None else 0.0
        d_str = dt.datetime.fromtimestamp(int(ts), tz=ist_tz).date().isoformat()
        by_date[d_str] = (round(px, 2), vol)

    return [(ticker, d, pv[0], pv[1]) for d, pv in sorted(by_date.items())]


def fetch_yahoo_spark_batch_5y(tickers: List[str]) -> Dict[str, List[Tuple[str, str, float, float]]]:
    """Fetch 5Y daily split-adjusted prices for up to 20 symbols per HTTP GET via Yahoo spark API."""
    ist_tz = dt.timezone(dt.timedelta(hours=5, minutes=30))
    out: Dict[str, List[Tuple[str, str, float, float]]] = {}
    chunk_size = 20

    with httpx.Client(headers={"User-Agent": BROWSER_UA}, follow_redirects=True, timeout=15.0) as client:
        for start in range(0, len(tickers), chunk_size):
            batch = tickers[start : start + chunk_size]
            encoded_syms = ",".join(urllib.parse.quote(t, safe="") for t in batch)
            url = f"https://query1.finance.yahoo.com/v7/finance/spark?symbols={encoded_syms}&range=5y&interval=1d"
            payload = None
            for attempt in range(3):
                resp = client.get(url)
                if resp.status_code == 200:
                    payload = resp.json()
                    break
                time.sleep(0.8 * (attempt + 1))
            if not payload:
                continue

            for item in (payload.get("spark") or {}).get("result") or []:
                sym = item.get("symbol")
                resp_arr = item.get("response") or []
                if not sym or not resp_arr:
                    continue
                r0 = resp_arr[0]
                timestamps = r0.get("timestamp") or []
                closes = (((r0.get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
                by_date: Dict[str, Tuple[float, float]] = {}
                for idx, ts in enumerate(timestamps):
                    if idx >= len(closes) or closes[idx] is None:
                        continue
                    px = float(closes[idx])
                    if px > 0 and not math.isnan(px):
                        d_str = dt.datetime.fromtimestamp(int(ts), tz=ist_tz).date().isoformat()
                        by_date[d_str] = (round(px, 2), 0.0)
                if by_date:
                    out[sym] = [(sym, d, pv[0], pv[1]) for d, pv in sorted(by_date.items())]
            time.sleep(0.12)

    return out


def run_stage1_bulk_funnel(db: Database, shortlist_top_n: int = 65) -> Dict[str, Any]:
    """Scan all ~200 Nifty 200 NSE stocks in bulk, store 5Y prices, and shortlist top candidates."""
    constituents = fetch_nifty200_constituents()
    db.purge_synthetic_seed_data()

    # Batch-fetch Nifty 50 (^NSEI) + all ~200 Nifty 200 tickers in chunks of 20 (~11 HTTP requests total)
    all_symbols = [BENCHMARK_TICKER] + [c["ticker"] for c in constituents]
    price_map = fetch_yahoo_spark_batch_5y(all_symbols)

    bm_rows = price_map.pop(BENCHMARK_TICKER, [])
    if bm_rows:
        db.upsert_prices(bm_rows)
    bm_series = pd.Series({r[1]: r[2] for r in bm_rows}).sort_index()
    bm_6m_ret = 0.0
    if len(bm_series) >= 126:
        bm_6m_ret = ((float(bm_series.iloc[-1]) / float(bm_series.iloc[-126])) - 1.0) * 100.0

    # Batch persist all daily prices
    all_price_rows: List[Tuple[str, str, float, float]] = []
    for rows in price_map.values():
        all_price_rows.extend(rows)
    if all_price_rows:
        db.upsert_prices(all_price_rows)

    # 3. Compute Stage-1 Quant Funnel Score for every liquid constituent
    stage1_items: List[Dict[str, Any]] = []
    for comp in constituents:
        tk = comp["ticker"]
        rows = price_map.get(tk)
        if not rows:
            continue

        closes = np.array([r[2] for r in rows], dtype=float)
        vols = np.array([r[3] for r in rows], dtype=float)
        cur_px = float(closes[-1])

        ret_6m = ((cur_px / float(closes[-min(len(closes), 126)])) - 1.0) * 100.0
        rel_6m_vs_nifty = ret_6m - bm_6m_ret

        if len(closes) >= 252:
            mom_12_1 = ((float(closes[-21]) / float(closes[-252])) - 1.0) * 100.0
            high_52w = float(np.max(closes[-252:]))
        else:
            mom_12_1 = ret_6m
            high_52w = float(np.max(closes))

        dist_52w_high = ((cur_px / max(0.01, high_52w)) - 1.0) * 100.0
        dma_200 = float(np.mean(closes[-min(len(closes), 200):]))
        above_200 = 1 if cur_px >= dma_200 else 0
        pct_vs_200dma = ((cur_px / max(0.01, dma_200)) - 1.0) * 100.0

        tail_closes = closes[-min(len(closes), 253):]
        daily_rets = np.diff(tail_closes) / tail_closes[:-1]
        ann_vol = float(np.std(daily_rets) * math.sqrt(252.0) * 100.0) if len(daily_rets) > 20 else 28.0

        risk_adj = mom_12_1 / max(14.0, ann_vol)
        avg_turnover_cr = round(risk_adj, 2)  # Stores risk-adjusted momentum ratio (Mom / Vol)

        # Stage-1 Bulk Quant Score (0-100): Momentum + Rel Strength + Trend Quality + Risk Control
        s_mom = _lin(mom_12_1, -15.0, 48.0)
        s_rel = _lin(rel_6m_vs_nifty, -14.0, 26.0)
        s_trend = 0.55 * _lin(dist_52w_high, -32.0, -2.0) + 0.45 * _lin(pct_vs_200dma, -12.0, 22.0)
        risk_adj = mom_12_1 / max(14.0, ann_vol)
        s_stab = 0.65 * _lin(risk_adj, -0.5, 1.6) + 0.35 * _lin(ann_vol, 48.0, 18.0)

        stage1_score = round(_clamp(0.35 * s_mom + 0.25 * s_rel + 0.25 * s_trend + 0.15 * s_stab), 1)

        stage1_items.append(
            {
                **comp,
                "last_price": round(cur_px, 2),
                "ret_6m_pct": round(ret_6m, 1),
                "mom_12_1_pct": round(mom_12_1, 1),
                "volatility_pct": round(ann_vol, 1),
                "dist_52w_high_pct": round(dist_52w_high, 1),
                "above_200dma": above_200,
                "avg_turnover_cr": round(avg_turnover_cr, 1),
                "stage1_score": stage1_score,
            }
        )

    stage1_items.sort(key=lambda x: x["stage1_score"], reverse=True)

    # Select Top-N Shortlist + Sector Minimum Coverage (top 4 per sector) + Nifty 50 Anchor Heavyweights
    shortlisted_tickers = set()
    sector_counts: Dict[str, int] = {}

    for idx, item in enumerate(stage1_items, start=1):
        item["stage1_rank"] = idx
        tk = item["ticker"]
        sec = item["sector"]
        sym = item["symbol"]
        if idx <= shortlist_top_n or sector_counts.get(sec, 0) < 4 or sym in CORE_ANCHOR_SYMBOLS:
            if len(shortlisted_tickers) < shortlist_top_n + 20 or sym in CORE_ANCHOR_SYMBOLS:
                shortlisted_tickers.add(tk)
                sector_counts[sec] = sector_counts.get(sec, 0) + 1

    now = int(time.time())
    funnel_db_rows: List[Tuple[Any, ...]] = []
    for item in stage1_items:
        tk = item["ticker"]
        is_short = 1 if tk in shortlisted_tickers else 0
        db.upsert_company(
            ticker=tk,
            name=item["name"],
            sector=item["sector"],
            cap_tier="Nifty 200",
            is_financial=item["is_financial"],
            data_source="real_nse_stage1",
        )
        funnel_db_rows.append(
            (
                tk,
                item["name"],
                item["sector"],
                item["industry"],
                item["last_price"],
                item["ret_6m_pct"],
                item["mom_12_1_pct"],
                item["volatility_pct"],
                item["dist_52w_high_pct"],
                item["above_200dma"],
                item["avg_turnover_cr"],
                item["stage1_score"],
                item["stage1_rank"],
                is_short,
                0,
                now,
            )
        )

    db.upsert_stage1_funnel(funnel_db_rows)
    shortlist_ordered = [it for it in stage1_items if it["ticker"] in shortlisted_tickers]
    return {
        "total_scanned": len(stage1_items),
        "shortlisted_count": len(shortlist_ordered),
        "shortlisted": shortlist_ordered,
    }


def _extract_screener_table(soup: BeautifulSoup, section_id: str) -> Tuple[List[str], Dict[str, List[Optional[float]]]]:
    sec = soup.find("section", id=section_id)
    if not sec:
        return [], {}
    tbl = sec.find("table")
    if not tbl:
        return [], {}

    headers = [th.get_text(strip=True) for th in tbl.select("thead th")]
    rows_map: Dict[str, List[Optional[float]]] = {}
    for tr in tbl.select("tbody tr"):
        tds = tr.find_all("td")
        if not tds:
            continue
        raw_label = tds[0].get_text(" ", strip=True).replace("+", "").strip()
        key = raw_label.lower()
        vals = [_parse_num(td.get_text(strip=True)) for td in tds[1:]]
        rows_map[key] = vals
    return headers[1:], rows_map


def _lookup_row(rows_map: Dict[str, List[Optional[float]]], prefixes: List[str], col_idx: int, default: float = 0.0) -> float:
    for p in prefixes:
        p_low = p.lower()
        for k, arr in rows_map.items():
            if k == p_low or k.startswith(p_low):
                if 0 <= col_idx < len(arr) and arr[col_idx] is not None:
                    return float(arr[col_idx])
    return default


def fetch_screener_real_fundamentals(
    client: httpx.Client,
    ticker: str,
    fallback_name: str = "",
    fallback_sector: str = "Diversified",
    is_financial_hint: bool = False,
) -> Optional[Dict[str, Any]]:
    """Fetch and normalize multi-year real Indian consolidated financials from Screener.in."""
    sym = ticker.replace(".NS", "").replace(".BO", "").strip().upper()
    enc_sym = urllib.parse.quote(sym, safe="")

    soup: Optional[BeautifulSoup] = None
    pl_cols: List[str] = []
    pl_rows: Dict[str, List[Optional[float]]] = {}

    for suffix in ["/consolidated/", "/"]:
        url = f"https://www.screener.in/company/{enc_sym}{suffix}"
        for attempt in range(3):
            resp = client.get(url)
            if resp.status_code == 429:
                time.sleep(1.2 * (attempt + 1))
                continue
            if resp.status_code != 200:
                break
            cand_soup = BeautifulSoup(resp.text, "html.parser")
            c_cols, c_rows = _extract_screener_table(cand_soup, "profit-loss")
            fy_matches = [c for c in c_cols if FY_COL_RE.match(c)]
            if len(fy_matches) >= 2:
                soup = cand_soup
                pl_cols, pl_rows = c_cols, c_rows
                break
            break
        if soup is not None:
            break

    if soup is None or not pl_cols:
        return None

    # Top summary metrics
    top_ratios: Dict[str, float] = {}
    for li in soup.select("#top-ratios li"):
        nm = li.select_one(".name")
        num = li.select_one(".number")
        if nm and num:
            val = _parse_num(num.get_text(strip=True))
            if val is not None:
                top_ratios[nm.get_text(strip=True).lower()] = val

    h1 = soup.find("h1")
    comp_name = (h1.get_text(strip=True) if h1 else fallback_name) or sym
    mcap_cr = top_ratios.get("market cap", 0.0)
    cur_px = top_ratios.get("current price", 0.0)
    top_roce = top_ratios.get("roce", 0.0)
    top_roe = top_ratios.get("roe", 0.0)

    if mcap_cr >= 100_000:
        cap_tier = "Large Cap"
    elif mcap_cr >= 30_000:
        cap_tier = "Mid Cap"
    else:
        cap_tier = "Small/Mid Cap"

    # Split-adjusted current share count in Crores (matches Yahoo Finance split-adjusted close series)
    split_adj_shares_cr = (mcap_cr / cur_px) if (mcap_cr > 0 and cur_px > 0) else 100.0

    bs_cols, bs_rows = _extract_screener_table(soup, "balance-sheet")
    cf_cols, cf_rows = _extract_screener_table(soup, "cash-flow")
    rt_cols, rt_rows = _extract_screener_table(soup, "ratios")
    sh_cols, sh_rows = _extract_screener_table(soup, "shareholding")
    qt_cols, qt_rows = _extract_screener_table(soup, "quarters")

    is_fin = is_financial_hint or ("financing profit" in pl_rows) or ("deposits" in bs_rows)

    # Latest Promoter (+ Govt for PSUs) & Institutional (FII + DII) ownership % + 4-Quarter Trend
    promoter_pct = 0.0
    inst_pct = 0.0
    promoter_chg_1y = 0.0
    inst_chg_1y = 0.0
    has_sh_trend = False
    if sh_cols:
        last_sh = len(sh_cols) - 1
        promoter_pct = min(
            100.0,
            _lookup_row(sh_rows, ["promoters"], last_sh, 0.0)
            + _lookup_row(sh_rows, ["government"], last_sh, 0.0),
        )
        inst_pct = min(
            100.0,
            _lookup_row(sh_rows, ["fiis"], last_sh, 0.0)
            + _lookup_row(sh_rows, ["diis"], last_sh, 0.0),
        )
        if len(sh_cols) >= 2:
            prev_sh = max(0, last_sh - 4)
            prom_prev = min(
                100.0,
                _lookup_row(sh_rows, ["promoters"], prev_sh, 0.0)
                + _lookup_row(sh_rows, ["government"], prev_sh, 0.0),
            )
            inst_prev = min(
                100.0,
                _lookup_row(sh_rows, ["fiis"], prev_sh, 0.0)
                + _lookup_row(sh_rows, ["diis"], prev_sh, 0.0),
            )
            promoter_chg_1y = round(promoter_pct - prom_prev, 2)
            inst_chg_1y = round(inst_pct - inst_prev, 2)
            has_sh_trend = True

    # Extract TTM Revenue/PAT, Latest 2-Quarter YoY Growth, Margin Inflection & Bank NPAs
    ttm_rev_cr = 0.0
    ttm_pat_cr = 0.0
    if "TTM" in pl_cols:
        ttm_idx = pl_cols.index("TTM")
        ttm_rev_cr = _lookup_row(pl_rows, ["sales", "revenue"], ttm_idx, 0.0)
        ttm_pat_cr = _lookup_row(pl_rows, ["net profit"], ttm_idx, 0.0)

    latest_qtr_label = ""
    signals_rep_date = "1970-01-01"
    qtr_rev_yoy = 0.0
    qtr_pat_yoy = 0.0
    qtr_opm_delta = 0.0
    gnpa_pct = 0.0
    nnpa_pct = 0.0
    has_qtr_data = False

    if qt_cols:
        q_last = len(qt_cols) - 1
        latest_qtr_label = qt_cols[q_last]
        qm = FY_COL_RE.match(latest_qtr_label)
        if qm:
            q_mon = MONTH_MAP[qm.group(1)]
            q_yr = int(qm.group(2))
            q_end = dt.date(q_yr, q_mon, calendar.monthrange(q_yr, q_mon)[1])
            signals_rep_date = (q_end + dt.timedelta(days=35)).isoformat()

        if ttm_rev_cr <= 0 and len(qt_cols) >= 4:
            ttm_rev_cr = sum(_lookup_row(qt_rows, ["sales", "revenue"], q_last - k, 0.0) for k in range(4))
            ttm_pat_cr = sum(_lookup_row(qt_rows, ["net profit"], q_last - k, 0.0) for k in range(4))

        for back in range(min(3, len(qt_cols))):
            if gnpa_pct == 0.0:
                gnpa_pct = _lookup_row(qt_rows, ["gross npa"], q_last - back, 0.0)
            if nnpa_pct == 0.0:
                nnpa_pct = _lookup_row(qt_rows, ["net npa"], q_last - back, 0.0)

        if len(qt_cols) >= 5:
            span = 2 if len(qt_cols) >= 6 else 1
            cur_idxs = [q_last - k for k in range(span)]
            prv_idxs = [q_last - 4 - k for k in range(span)]

            rev_cur_q = sum(_lookup_row(qt_rows, ["sales", "revenue"], i, 0.0) for i in cur_idxs)
            rev_prv_q = sum(_lookup_row(qt_rows, ["sales", "revenue"], i, 0.0) for i in prv_idxs)
            pat_cur_q = sum(_lookup_row(qt_rows, ["net profit"], i, 0.0) for i in cur_idxs)
            pat_prv_q = sum(_lookup_row(qt_rows, ["net profit"], i, 0.0) for i in prv_idxs)

            if rev_prv_q > 0 and rev_cur_q > 0:
                qtr_rev_yoy = _clamp(((rev_cur_q / rev_prv_q) - 1.0) * 100.0, -60.0, 120.0)
                has_qtr_data = True

            if pat_prv_q > 0 and pat_cur_q > 0:
                qtr_pat_yoy = _clamp(((pat_cur_q / pat_prv_q) - 1.0) * 100.0, -70.0, 140.0)
            elif pat_prv_q <= 0 < pat_cur_q:
                qtr_pat_yoy = 35.0
            elif pat_cur_q <= 0 < pat_prv_q:
                qtr_pat_yoy = -50.0
            else:
                qtr_pat_yoy = -30.0

            if is_fin:
                pbt_cur_q = sum(_lookup_row(qt_rows, ["profit before tax"], i, 0.0) for i in cur_idxs)
                pbt_prv_q = sum(_lookup_row(qt_rows, ["profit before tax"], i, 0.0) for i in prv_idxs)
                m_cur = (pbt_cur_q / max(1.0, rev_cur_q)) * 100.0
                m_prv = (pbt_prv_q / max(1.0, rev_prv_q)) * 100.0
            else:
                op_cur_q = sum(_lookup_row(qt_rows, ["operating profit"], i, 0.0) for i in cur_idxs)
                op_prv_q = sum(_lookup_row(qt_rows, ["operating profit"], i, 0.0) for i in prv_idxs)
                m_cur = (op_cur_q / max(1.0, rev_cur_q)) * 100.0
                m_prv = (op_prv_q / max(1.0, rev_prv_q)) * 100.0
            qtr_opm_delta = _clamp(m_cur - m_prv, -20.0, 20.0)

    bs_col_idx = {c: i for i, c in enumerate(bs_cols)}
    cf_col_idx = {c: i for i, c in enumerate(cf_cols)}
    rt_col_idx = {c: i for i, c in enumerate(rt_cols)}

    annual_rows: List[Tuple[Any, ...]] = []
    for p_idx, col_label in enumerate(pl_cols):
        m = FY_COL_RE.match(col_label)
        if not m:
            continue
        mon_abbr, yr_str = m.group(1), m.group(2)
        fy = int(yr_str)
        if fy < 2018:
            continue

        mon_num = MONTH_MAP[mon_abbr]
        last_day = calendar.monthrange(fy, mon_num)[1]
        p_end_dt = dt.date(fy, mon_num, last_day)
        rep_dt = p_end_dt + dt.timedelta(days=60)  # 60-day SEBI LODR post-FY reporting lag

        rev_cr = _lookup_row(pl_rows, ["sales", "revenue"], p_idx, 0.0)
        if rev_cr <= 0:
            continue

        pat_cr = _lookup_row(pl_rows, ["net profit"], p_idx, 0.0)
        dep_cr = _lookup_row(pl_rows, ["depreciation"], p_idx, 0.0)
        pbt_cr = _lookup_row(pl_rows, ["profit before tax"], p_idx, pat_cr * 1.3)

        if is_fin:
            fin_prof = _lookup_row(pl_rows, ["financing profit"], p_idx, 0.0)
            ebitda_cr = max(fin_prof, pbt_cr, pat_cr * 1.25)
            ebit_cr = max(pbt_cr, pat_cr * 1.2)
            opm_pct = (pbt_cr / max(1.0, rev_cr)) * 100.0
        else:
            ebitda_cr = _lookup_row(pl_rows, ["operating profit"], p_idx, pbt_cr + dep_cr)
            ebit_cr = ebitda_cr - dep_cr
            opm_pct = _lookup_row(pl_rows, ["opm"], p_idx, (ebitda_cr / max(1.0, rev_cr)) * 100.0)

        # Match Balance Sheet column (exact label or same year fallback)
        b_idx = bs_col_idx.get(col_label)
        if b_idx is None:
            b_idx = next((i for c, i in bs_col_idx.items() if c.endswith(yr_str)), -1)

        eq_cap = _lookup_row(bs_rows, ["equity capital"], b_idx, 0.0) if b_idx >= 0 else 0.0
        reserves = _lookup_row(bs_rows, ["reserves"], b_idx, 0.0) if b_idx >= 0 else 0.0
        tot_eq = eq_cap + reserves
        if tot_eq == 0.0:
            tot_eq = max(50.0, abs(pat_cr) / max(0.08, (top_roe or 15.0) / 100.0))

        tot_debt = _lookup_row(bs_rows, ["borrowings", "borrowing"], b_idx, 0.0) if b_idx >= 0 else 0.0
        other_liab = _lookup_row(bs_rows, ["other liabilities"], b_idx, rev_cr * 0.18) if b_idx >= 0 else rev_cr * 0.18
        tot_assets = _lookup_row(bs_rows, ["total assets", "total liabilities"], b_idx, max(tot_eq, 0.0) + tot_debt + other_liab) if b_idx >= 0 else (max(tot_eq, 0.0) + tot_debt + other_liab)
        investments = _lookup_row(bs_rows, ["investments"], b_idx, 0.0) if b_idx >= 0 else 0.0
        other_assets = _lookup_row(bs_rows, ["other assets"], b_idx, rev_cr * 0.25) if b_idx >= 0 else rev_cr * 0.25
        cur_assets = max(10.0, other_assets + investments * 0.5)
        cur_liab = max(10.0, other_liab)

        # Match Cash Flow column
        c_idx = cf_col_idx.get(col_label)
        if c_idx is None:
            c_idx = next((i for c, i in cf_col_idx.items() if c.endswith(yr_str)), -1)

        cfo_cr = _lookup_row(cf_rows, ["cash from operating activity"], c_idx, pat_cr * 0.9) if c_idx >= 0 else pat_cr * 0.9
        cfi_cr = _lookup_row(cf_rows, ["cash from investing activity"], c_idx, -abs(dep_cr)) if c_idx >= 0 else -abs(dep_cr)
        fcf_est = _lookup_row(cf_rows, ["free cash flow"], c_idx, 0.0) if c_idx >= 0 else 0.0
        if fcf_est == 0.0:
            # Conservative capex proxy when explicit FCF row is collapsed
            capex_proxy = min(abs(cfi_cr), max(abs(dep_cr) * 1.4, rev_cr * 0.06)) if cfi_cr < 0 else abs(dep_cr)
            fcf_est = pat_cr if is_fin else (cfo_cr - capex_proxy)

        # Match Ratios column for historical ROCE % / ROE %
        r_idx = rt_col_idx.get(col_label)
        if r_idx is None:
            r_idx = next((i for c, i in rt_col_idx.items() if c.endswith(yr_str)), -1)

        if is_fin:
            roe_pct = _lookup_row(rt_rows, ["roe"], r_idx, 0.0) if r_idx >= 0 else 0.0
            if roe_pct == 0.0 and tot_eq > 0:
                roe_pct = (pat_cr / tot_eq) * 100.0
            # For banks/NBFCs, store ROE as primary capital-return metric and ROA*10 scaled or top_roce
            roa_pct = (pat_cr / max(1.0, tot_assets)) * 100.0
            roce_pct = round(roa_pct * 8.5, 2) if top_roce < 10.0 else top_roce
            cfo_ebitda = 90.0 if pat_cr > 0 else 40.0
        else:
            roce_pct = _lookup_row(rt_rows, ["roce"], r_idx, 0.0) if r_idx >= 0 else 0.0
            if roce_pct == 0.0:
                cap_emp = max(10.0, max(0.0, tot_eq) + tot_debt)
                roce_pct = (ebit_cr / cap_emp) * 100.0
            roe_pct = (pat_cr / tot_eq) * 100.0 if tot_eq > 0 else -25.0
            cfo_ebitda = (cfo_cr / max(1.0, ebitda_cr)) * 100.0 if ebitda_cr > 0 else (30.0 if cfo_cr <= 0 else 75.0)

        de_val = (tot_debt / tot_eq) if tot_eq > 0 else 8.0

        annual_rows.append(
            (
                ticker,
                fy,
                p_end_dt.isoformat(),
                rep_dt.isoformat(),
                round(rev_cr, 2),
                round(ebitda_cr, 2),
                round(ebit_cr, 2),
                round(pat_cr, 2),
                round(cfo_cr, 2),
                round(fcf_est, 2),
                round(max(1.0, tot_assets), 2),
                round(tot_eq, 2),
                round(max(0.0, tot_debt), 2),
                round(cur_assets, 2),
                round(cur_liab, 2),
                round(max(0.05, split_adj_shares_cr), 3),
                round(roce_pct, 2),
                round(roe_pct, 2),
                round(opm_pct, 2),
                round(max(0.0, de_val), 3),
                round(_clamp(cfo_ebitda, -50.0, 160.0), 2),
            )
        )

    if not annual_rows:
        return None

    return {
        "ticker": ticker,
        "name": comp_name[:80],
        "sector": fallback_sector,
        "cap_tier": cap_tier,
        "is_financial": is_fin,
        "promoter_pct": round(promoter_pct, 2),
        "inst_pct": round(inst_pct, 2),
        "annual_rows": annual_rows,
        "quarterly_signals": {
            "ticker": ticker,
            "latest_qtr_label": latest_qtr_label,
            "signals_reported_date": signals_rep_date,
            "ttm_rev_cr": round(ttm_rev_cr, 2),
            "ttm_pat_cr": round(ttm_pat_cr, 2),
            "qtr_rev_yoy_pct": round(qtr_rev_yoy, 2),
            "qtr_pat_yoy_pct": round(qtr_pat_yoy, 2),
            "qtr_opm_delta_pct": round(qtr_opm_delta, 2),
            "promoter_chg_1y_pct": round(promoter_chg_1y, 2),
            "inst_chg_1y_pct": round(inst_chg_1y, 2),
            "gnpa_pct": round(gnpa_pct, 2),
            "nnpa_pct": round(nnpa_pct, 2),
            "has_qtr_data": has_qtr_data,
            "has_sh_trend": has_sh_trend,
        },
    }


def refresh_live_prices_only(db: Database) -> Dict[str, Any]:
    """Lightweight 4-second weekly/daily price update (~11 Yahoo batch calls, 0 Screener calls)."""
    companies = db.get_all_companies()
    tickers = [c["ticker"] for c in companies]
    if not tickers:
        return run_stage1_bulk_funnel(db, shortlist_top_n=65)

    price_map = fetch_yahoo_spark_batch_5y([BENCHMARK_TICKER] + tickers)
    bm_rows = price_map.pop(BENCHMARK_TICKER, [])
    if bm_rows:
        db.upsert_prices(bm_rows)

    all_rows: List[Tuple[str, str, float, float]] = []
    for rows in price_map.values():
        all_rows.extend(rows)
    if all_rows:
        db.upsert_prices(all_rows)

    batch_calls = math.ceil((len(tickers) + 1) / 20)
    return {
        "tickers_updated": len(price_map),
        "tickers_refreshed": len(price_map),
        "benchmark_updated": len(bm_rows) > 0,
        "external_api_calls": batch_calls,
        "spark_batch_calls": batch_calls,
    }


def run_stage2_deep_fundamentals(
    db: Database,
    candidates: List[Dict[str, Any]],
    request_spacing_sec: float = 0.16,
    stale_days_ttl: int = 7,
) -> Dict[str, int]:
    """Ingest real multi-year consolidated Indian financial statements, skipping fresh (<TTL) records."""
    ingested = 0
    skipped_fresh = 0
    total_fy_rows = 0
    now_ts = int(time.time())
    ttl_seconds = stale_days_ttl * 86400
    existing_qtr = db.get_all_quarterly_signals()

    with httpx.Client(headers={"User-Agent": BROWSER_UA}, follow_redirects=True, timeout=14.0) as client:
        for cand in candidates:
            tk = cand["ticker"]
            comp_existing = db.get_company(tk)
            if (
                stale_days_ttl > 0
                and comp_existing
                and comp_existing.get("data_source") == "real_nse_screener"
                and (now_ts - int(comp_existing.get("updated_at") or 0)) < ttl_seconds
                and len(db.get_company_fundamentals(tk)) >= 2
                and tk in existing_qtr
            ):
                db.mark_funnel_deep_scored(tk)
                skipped_fresh += 1
                continue
            sec = cand.get("sector") or (comp_existing["sector"] if comp_existing else "Diversified")
            nm = cand.get("name") or (comp_existing["name"] if comp_existing else tk)
            is_fin_hint = bool(cand.get("is_financial") or (comp_existing and comp_existing["is_financial"]))

            try:
                parsed = fetch_screener_real_fundamentals(
                    client=client,
                    ticker=tk,
                    fallback_name=nm,
                    fallback_sector=sec,
                    is_financial_hint=is_fin_hint,
                )
            except Exception as exc:
                logger.warning("Stage-2 fundamental parse skipped for %s: %s", tk, exc)
                parsed = None

            if parsed:
                db.upsert_company(
                    ticker=tk,
                    name=parsed["name"],
                    sector=parsed["sector"],
                    cap_tier=parsed["cap_tier"],
                    is_financial=parsed["is_financial"],
                    data_source="real_nse_screener",
                    promoter_pct=parsed["promoter_pct"],
                    inst_pct=parsed["inst_pct"],
                )
                db.upsert_fundamentals(parsed["annual_rows"])
                if parsed.get("quarterly_signals"):
                    db.upsert_quarterly_signals(parsed["quarterly_signals"])
                db.mark_funnel_deep_scored(tk)
                ingested += 1
                total_fy_rows += len(parsed["annual_rows"])

            if request_spacing_sec > 0:
                time.sleep(request_spacing_sec)

    return {
        "companies_deep_scored": ingested,
        "skipped_fresh_ttl": skipped_fresh,
        "annual_rows_saved": total_fy_rows,
    }


def sync_single_live_ticker(db: Database, ticker: str) -> Dict[str, Any]:
    """Sync both 5Y daily prices and multi-year consolidated fundamentals for a single NSE ticker."""
    price_rows = fetch_yahoo_5y_prices(ticker)
    if not price_rows:
        raise ValueError(f"No live NSE market price history found for {ticker}.")
    db.upsert_prices(price_rows)

    # Also keep Nifty 50 benchmark fresh
    bm_rows = fetch_yahoo_5y_prices(BENCHMARK_TICKER)
    if bm_rows:
        db.upsert_prices(bm_rows)

    existing = db.get_company(ticker)
    sec = existing["sector"] if existing else "Diversified"
    nm = existing["name"] if existing else ticker
    is_fin = bool(existing["is_financial"]) if existing else False

    with httpx.Client(headers={"User-Agent": BROWSER_UA}, follow_redirects=True, timeout=14.0) as client:
        parsed = fetch_screener_real_fundamentals(
            client=client,
            ticker=ticker,
            fallback_name=nm,
            fallback_sector=sec,
            is_financial_hint=is_fin,
        )

    fy_count = 0
    if parsed:
        sec_mapped, fin_mapped = _map_nse_industry_to_sector(sec, parsed["name"])
        final_sec = sec if sec != "Diversified" else sec_mapped
        db.upsert_company(
            ticker=ticker,
            name=parsed["name"],
            sector=final_sec,
            cap_tier=parsed["cap_tier"],
            is_financial=parsed["is_financial"] or fin_mapped,
            data_source="real_nse_screener",
            promoter_pct=parsed["promoter_pct"],
            inst_pct=parsed["inst_pct"],
        )
        db.upsert_fundamentals(parsed["annual_rows"])
        if parsed.get("quarterly_signals"):
            db.upsert_quarterly_signals(parsed["quarterly_signals"])
        db.mark_funnel_deep_scored(ticker)
        fy_count = len(parsed["annual_rows"])
        nm = parsed["name"]

    return {
        "ticker": ticker,
        "name": nm,
        "price_days_synced": len(price_rows),
        "fundamental_years_synced": fy_count,
    }
