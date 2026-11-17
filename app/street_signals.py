"""Sell-Side Consensus, EPS Revision Momentum & Long-Only Institutional Signals (`app/street_signals.py`).

Fetches live Wall Street & Dalal Street institutional consensus across all ~700+ companies
(`IN` Nifty-200 + `US` Nasdaq-100 & S&P 500) via Yahoo Finance `v10/finance/quoteSummary`:
- Authenticates a Yahoo session cookie (`https://fc.yahoo.com`) + crumb (`v1/test/getcrumb`).
- Extracts covering analyst count, Strong Buy / Buy / Hold / Sell / Strong Sell breakdown,
  12-month target price range (`mean`, `high`, `low`), Forward P/E, FY1 (`0y`) & FY2 (`+1y`)
  consensus EPS growth, and 30d/90d EPS revision breadth (`rev_breadth_pct`).
- Extracts top-5 recent Tier-1 sell-side bank rating actions (`upgradeDowngradeHistory`).
- Extracts up to 4 top institutional 13F holders (`institutionOwnership`), explicitly excluding
  options/prop market-maker 13F noise (`Jane Street`, `Citadel`, `Susquehanna`, `Simplex`,
  `Wolverine`, `Group One`, `IMC`, `Optiver`, `Two Sigma`, `Millennium`) so only genuine
  long-only buy-side asset managers remain.
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import logging
import math
import re
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.database import DEFAULT_DB_PATH, Database

logger = logging.getLogger("arthaquant.street")

YAHOO_UA = "Mozilla/5.0"
QUOTE_SUMMARY_MODULES = (
    "financialData,recommendationTrend,earningsTrend,"
    "upgradeDowngradeHistory,institutionOwnership,majorHoldersBreakdown,"
    "summaryDetail,defaultKeyStatistics"
)

# Options / prop-trading market-makers whose 13F filings reflect delta-hedged option books
# rather than fundamental long-only institutional conviction.
EXCLUDED_PROP_MARKET_MAKERS: Tuple[str, ...] = (
    "jane street",
    "citadel",
    "susquehanna",
    "simplex",
    "wolverine",
    "group one",
    "imc",
    "optiver",
    "two sigma",
    "millennium",
)

ACTION_LABELS: Dict[str, str] = {
    "up": "Upgrade",
    "down": "Downgrade",
    "main": "Maintained",
    "init": "Initiated",
    "reit": "Reiterated",
}


def _raw_num(obj: Any) -> Optional[float]:
    if isinstance(obj, dict):
        val = obj.get("raw")
        if val is None:
            return None
        try:
            f = float(val)
            return None if (math.isnan(f) or math.isinf(f)) else f
        except (TypeError, ValueError):
            return None
    if isinstance(obj, (int, float)):
        f = float(obj)
        return None if (math.isnan(f) or math.isinf(f)) else f
    return None


def _clamp(val: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, val))


def is_excluded_market_maker(org_name: str) -> bool:
    low = (org_name or "").strip().lower()
    if not low:
        return True
    return any(mm in low for mm in EXCLUDED_PROP_MARKET_MAKERS)


def authenticate_yahoo_crumb(timeout: float = 15.0) -> Tuple[Dict[str, str], str]:
    """Obtain Yahoo Finance A3 session cookies and valid `getcrumb` token."""
    with httpx.Client(headers={"User-Agent": YAHOO_UA}, follow_redirects=True, timeout=timeout) as client:
        client.get("https://fc.yahoo.com")
        for host in ("query2.finance.yahoo.com", "query1.finance.yahoo.com"):
            resp = client.get(f"https://{host}/v1/test/getcrumb")
            if resp.status_code == 200 and resp.text.strip() and "Too Many" not in resp.text:
                cookies = {k: v for k, v in client.cookies.items()}
                return cookies, resp.text.strip()
    raise RuntimeError("Failed to authenticate Yahoo Finance session cookie + crumb")


def parse_quote_summary_result(
    ticker: str,
    res0: Dict[str, Any],
    signals_as_of_date: str,
    fallback_inst_pct: float = 0.0,
) -> Tuple[Dict[str, Any], Optional[Tuple[float, float]]]:
    """Parse a Yahoo `quoteSummary.result[0]` object into a `company_street_signals` row dict."""
    fd = res0.get("financialData") or {}
    sd = res0.get("summaryDetail") or {}
    ks = res0.get("defaultKeyStatistics") or {}
    rt_list = (res0.get("recommendationTrend") or {}).get("trend") or []
    et_list = (res0.get("earningsTrend") or {}).get("trend") or []
    udh_list = (res0.get("upgradeDowngradeHistory") or {}).get("history") or []
    io_list = (res0.get("institutionOwnership") or {}).get("ownershipList") or []
    mhb = res0.get("majorHoldersBreakdown") or {}

    # 1. Recommendation Trend & Analyst Count
    t0: Dict[str, Any] = {}
    for item in rt_list:
        if isinstance(item, dict) and item.get("period") == "0m":
            t0 = item
            break
    if not t0 and rt_list and isinstance(rt_list[0], dict):
        t0 = rt_list[0]

    sb = max(0, int(_raw_num(t0.get("strongBuy")) or 0))
    b = max(0, int(_raw_num(t0.get("buy")) or 0))
    h = max(0, int(_raw_num(t0.get("hold")) or 0))
    s = max(0, int(_raw_num(t0.get("sell")) or 0))
    ss = max(0, int(_raw_num(t0.get("strongSell")) or 0))
    trend_sum = sb + b + h + s + ss

    num_opinions = max(0, int(_raw_num(fd.get("numberOfAnalystOpinions")) or 0))
    rec_key = str(fd.get("recommendationKey") or "none").strip().lower()
    rec_mean = _raw_num(fd.get("recommendationMean"))

    if trend_sum > 0:
        analyst_count = trend_sum if trend_sum >= num_opinions else num_opinions
        consensus_buy_pct = round(((sb + b) / trend_sum) * 100.0, 1)
    elif num_opinions > 0:
        analyst_count = num_opinions
        if rec_mean is not None and 1.0 <= rec_mean <= 5.0:
            consensus_buy_pct = round(_clamp(((4.4 - rec_mean) / 3.0) * 100.0, 5.0, 95.0), 1)
        elif rec_key in ("strong_buy", "strongbuy"):
            consensus_buy_pct = 85.0
        elif rec_key in ("buy", "outperform", "overweight"):
            consensus_buy_pct = 70.0
        elif rec_key == "hold":
            consensus_buy_pct = 45.0
        elif rec_key in ("underperform", "sell", "strong_sell"):
            consensus_buy_pct = 15.0
        else:
            consensus_buy_pct = 50.0
        buy_total = int(round(num_opinions * (consensus_buy_pct / 100.0)))
        sb = buy_total // 3
        b = buy_total - sb
        rem = max(0, num_opinions - buy_total)
        h = int(round(rem * 0.7))
        s = max(0, rem - h)
        ss = 0
    else:
        analyst_count = 0
        consensus_buy_pct = 0.0

    if rec_key in ("", "none") and analyst_count > 0:
        if consensus_buy_pct >= 75.0:
            rec_key = "strong_buy"
        elif consensus_buy_pct >= 55.0:
            rec_key = "buy"
        elif consensus_buy_pct >= 35.0:
            rec_key = "hold"
        else:
            rec_key = "underperform"

    # 2. Price Targets & Forward P/E
    target_mean = _raw_num(fd.get("targetMeanPrice")) or 0.0
    target_high = _raw_num(fd.get("targetHighPrice")) or 0.0
    target_low = _raw_num(fd.get("targetLowPrice")) or 0.0
    raw_fpe = (
        _raw_num(fd.get("forwardPE"))
        or _raw_num(sd.get("forwardPE"))
        or _raw_num(ks.get("forwardPE"))
        or 0.0
    )
    forward_pe = round(raw_fpe, 2) if (0.0 < raw_fpe <= 400.0) else 0.0

    # 3. Forward Consensus EPS Growth & 30d/90d EPS Revisions (`earningsTrend`)
    et_by_period: Dict[str, Dict[str, Any]] = {}
    for item in et_list:
        if isinstance(item, dict) and item.get("period"):
            et_by_period[str(item["period"])] = item

    t_0y = et_by_period.get("0y") or {}
    t_1y = et_by_period.get("+1y") or {}

    g_fy1_raw = _raw_num(t_0y.get("growth"))
    g_fy2_raw = _raw_num(t_1y.get("growth"))
    fwd_eps_fy1 = round(_clamp(g_fy1_raw * 100.0, -95.0, 250.0), 2) if g_fy1_raw is not None else 0.0
    fwd_eps_fy2 = round(_clamp(g_fy2_raw * 100.0, -95.0, 250.0), 2) if g_fy2_raw is not None else 0.0

    eps_rev = t_0y.get("epsRevisions") or {}
    up30 = max(0, int(_raw_num(eps_rev.get("upLast30days", eps_rev.get("upLast30Days"))) or 0))
    dn30 = max(0, int(_raw_num(eps_rev.get("downLast30days", eps_rev.get("downLast30Days"))) or 0))
    up90 = max(0, int(_raw_num(eps_rev.get("upLast90days", eps_rev.get("upLast90Days"))) or 0))
    dn90 = max(0, int(_raw_num(eps_rev.get("downLast90days", eps_rev.get("downLast90Days"))) or 0))

    if (up30 + dn30) >= 3:
        rev_breadth_pct = round(((up30 - dn30) / max(1, up30 + dn30)) * 100.0, 1)
    elif (up90 + dn90) >= 3:
        rev_breadth_pct = round(((up90 - dn90) / max(1, up90 + dn90)) * 100.0, 1)
    else:
        rev_breadth_pct = 0.0

    # 4. Institutional Ownership & Filtered Buy-Side Top Holders
    inst_raw = _raw_num(mhb.get("institutionsPercentHeld"))
    insider_raw = _raw_num(mhb.get("insidersPercentHeld"))
    if inst_raw is not None and inst_raw > 0:
        inst_held_pct = round(_clamp(inst_raw * 100.0, 0.0, 100.0), 2)
    else:
        inst_held_pct = round(_clamp(fallback_inst_pct, 0.0, 100.0), 2)

    ownership_pair: Optional[Tuple[float, float]] = None
    if inst_raw is not None and inst_raw > 0:
        ins_pct = round(_clamp((insider_raw or 0.0) * 100.0, 0.0, 95.0), 2)
        ownership_pair = (ins_pct, inst_held_pct)

    top_holders: List[str] = []
    seen_holders = set()
    for h_obj in io_list:
        if not isinstance(h_obj, dict):
            continue
        org = str(h_obj.get("organization") or "").strip()
        if not org or is_excluded_market_maker(org):
            continue
        org_key = org.lower()
        if org_key in seen_holders:
            continue
        seen_holders.add(org_key)
        top_holders.append(org)
        if len(top_holders) >= 4:
            break

    # 5. Recent Tier-1 Sell-Side Bank Rating Actions (`upgradeDowngradeHistory`)
    valid_hist = [
        item for item in udh_list
        if isinstance(item, dict) and item.get("firm") and item.get("toGrade")
    ]
    valid_hist.sort(key=lambda x: int(x.get("epochGradeDate") or 0), reverse=True)
    recent_actions: List[Dict[str, str]] = []
    for item in valid_hist[:5]:
        raw_act = str(item.get("action") or "").strip().lower()
        act_label = ACTION_LABELS.get(raw_act, raw_act.capitalize() if raw_act else "Maintained")
        epoch = int(item.get("epochGradeDate") or 0)
        d_iso = (
            dt.datetime.fromtimestamp(epoch, tz=dt.timezone.utc).date().isoformat()
            if epoch > 0
            else signals_as_of_date
        )
        recent_actions.append(
            {
                "firm": str(item.get("firm") or "").strip(),
                "to_grade": str(item.get("toGrade") or "").strip(),
                "from_grade": str(item.get("fromGrade") or "").strip(),
                "action": act_label,
                "date": d_iso,
            }
        )

    signal_row = {
        "ticker": ticker,
        "signals_as_of_date": signals_as_of_date,
        "analyst_count": analyst_count,
        "strong_buy_count": sb,
        "buy_count": b,
        "hold_count": h,
        "sell_count": s,
        "strong_sell_count": ss,
        "consensus_buy_pct": consensus_buy_pct,
        "recommendation_key": rec_key,
        "target_mean_price": round(max(0.0, target_mean), 2),
        "target_high_price": round(max(0.0, target_high), 2),
        "target_low_price": round(max(0.0, target_low), 2),
        "forward_pe": forward_pe,
        "fwd_eps_growth_fy1_pct": fwd_eps_fy1,
        "fwd_eps_growth_fy2_pct": fwd_eps_fy2,
        "eps_rev_up_30d": up30,
        "eps_rev_down_30d": dn30,
        "eps_rev_up_90d": up90,
        "eps_rev_down_90d": dn90,
        "rev_breadth_pct": rev_breadth_pct,
        "inst_held_pct": inst_held_pct,
        "recent_bank_actions": recent_actions,
        "top_holders": top_holders,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    return signal_row, ownership_pair


def ingest_street_signals(db: Optional[Database] = None, max_workers: int = 12) -> Dict[str, Any]:
    """Fetch and persist Sell-Side & Long-Only Institutional signals across ALL companies in `db`."""
    if db is None:
        db = Database(db_path=DEFAULT_DB_PATH)

    t0 = time.time()
    companies = db.get_all_companies()
    if not companies:
        return {"companies_checked": 0, "signals_saved": 0, "covered_companies": 0}

    with db.connect() as conn:
        row_dt = conn.execute("SELECT MAX(trade_date) AS max_dt FROM daily_prices").fetchone()
        signals_as_of_date = str(row_dt["max_dt"]) if (row_dt and row_dt["max_dt"]) else dt.date.today().isoformat()

    cookies, crumb = authenticate_yahoo_crumb()
    enc_crumb = urllib.parse.quote(crumb, safe="")
    hosts = ("query2.finance.yahoo.com", "query1.finance.yahoo.com")

    logger.info(
        "Fetching Yahoo v10 quoteSummary street signals for %d companies (signals_as_of_date=%s)...",
        len(companies),
        signals_as_of_date,
    )

    def _fetch_one(idx_comp: Tuple[int, Dict[str, Any]]) -> Optional[Tuple[Dict[str, Any], Optional[Tuple[float, float]], str]]:
        idx, comp = idx_comp
        tk = str(comp["ticker"])
        enc_tk = urllib.parse.quote(tk, safe="")
        fb_inst = float(comp.get("inst_pct") or 0.0)
        mkt = str(comp.get("market") or "IN")

        with httpx.Client(
            headers={"User-Agent": YAHOO_UA},
            cookies=cookies,
            follow_redirects=True,
            timeout=14.0,
        ) as client:
            for attempt in range(4):
                host = hosts[(idx + attempt) % 2]
                url = (
                    f"https://{host}/v10/finance/quoteSummary/{enc_tk}"
                    f"?modules={QUOTE_SUMMARY_MODULES}&crumb={enc_crumb}"
                )
                try:
                    resp = client.get(url)
                except Exception:
                    time.sleep(0.45 * (attempt + 1))
                    continue

                if resp.status_code == 200:
                    try:
                        data = resp.json()
                        results = (data.get("quoteSummary") or {}).get("result") or []
                        if not results:
                            return None
                        sig, own_pair = parse_quote_summary_result(
                            ticker=tk,
                            res0=results[0],
                            signals_as_of_date=signals_as_of_date,
                            fallback_inst_pct=fb_inst,
                        )
                        return sig, own_pair, mkt
                    except Exception as exc:
                        logger.debug("Parse warning on %s: %s", tk, exc)
                        return None

                if resp.status_code in (429, 500, 502, 503, 504):
                    time.sleep(0.75 * (attempt + 1))
                    continue
                if resp.status_code == 404:
                    return None
                time.sleep(0.35 * (attempt + 1))
        return None

    signal_rows: List[Dict[str, Any]] = []
    us_ownership_updates: List[Tuple[float, float, str]] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(14, max_workers))) as pool:
        for out in pool.map(_fetch_one, enumerate(companies)):
            if out is None:
                continue
            sig, own_pair, mkt = out
            signal_rows.append(sig)
            if mkt == "US" and own_pair is not None:
                us_ownership_updates.append((own_pair[0], own_pair[1], sig["ticker"]))

    if signal_rows:
        db.upsert_street_signals(signal_rows)

    # Refresh US insider & institutional ownership % on `companies` from live majorHoldersBreakdown
    if us_ownership_updates:
        with db.connect() as conn:
            conn.executemany(
                "UPDATE companies SET promoter_pct = ?, inst_pct = ? WHERE ticker = ? AND market = 'US'",
                us_ownership_updates,
            )

    covered = sum(1 for r in signal_rows if int(r.get("analyst_count") or 0) > 0)
    in_set = {c["ticker"] for c in companies if c.get("market") == "IN"}
    us_set = {c["ticker"] for c in companies if c.get("market") == "US"}
    covered_in = sum(1 for r in signal_rows if r["ticker"] in in_set and int(r.get("analyst_count") or 0) > 0)
    covered_us = sum(1 for r in signal_rows if r["ticker"] in us_set and int(r.get("analyst_count") or 0) > 0)

    elapsed = round(time.time() - t0, 1)
    summary = {
        "companies_checked": len(companies),
        "signals_saved": len(signal_rows),
        "covered_companies": covered,
        "covered_in": covered_in,
        "covered_us": covered_us,
        "signals_as_of_date": signals_as_of_date,
        "elapsed_sec": elapsed,
    }
    logger.info("Completed street signals ingestion: %s", summary)
    return summary


_ABBREV_DOT_RE = re.compile(
    r"\b(?:Inc|Corp|Co|Ltd|Plc|PLC|Pvt|LLC|Dr|Mr|Mrs|Ms|St|Ft|Mt|Jr|Sr|Prof|No|vs|approx|est|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\."
)
_MULTI_INIT_RE = re.compile(r"(?:\b[A-Z]\.){2,}")
_SINGLE_INIT_RE = re.compile(r"\b([A-Z])\.(?=\s+[A-Z])")
_EG_IE_RE = re.compile(r"\b(e\.g|i\.e)\.", re.IGNORECASE)

_BOILERPLATE_SENT_RE = re.compile(
    r"\b(?:"
    r"was incorporated in|is incorporated in|incorporated in \d{4}|"
    r"is headquartered in|headquartered in|"
    r"was founded in|founded in \d{4}|"
    r"formerly known as|changed its name (?:to|from)|"
    r"has a? ?strategic collaboration|has collaboration agreement"
    r")\b",
    re.IGNORECASE,
)
_CORP_BASED_SENT_RE = re.compile(
    r"^(?:The\s+)?(?:company|firm|bank|corporation|group|trust)\s+is\s+based\s+in\b",
    re.IGNORECASE,
)
_SEGMENT_ONLY_SENT_RE = re.compile(
    r"^(?:The\s+company|It)\s+operates\s+(?:through|in)\s+[^.]{5,180}\bsegments?\b\.?$",
    re.IGNORECASE,
)
_SUBSIDIARY_FILLER_RE = re.compile(
    r",\s*(?:together\s+with|through|along\s+with)\s+its\s+subsidiaries,?\s*"
    r"|\s+and\s+its\s+subsidiaries\b,?",
    re.IGNORECASE,
)
_LONG_GEO_TAIL_RE = re.compile(
    r"\s+in\s+(India|the United States)(?:,\s*[A-Za-z&.\- ]+){3,}(?:,?\s+and\s+[A-Za-z&.\- ]+)?\.?$"
)
_TRAILING_STOPWORDS_RE = re.compile(
    r"(?:[\s,;:\-–—]+|\s+\b(?:and|or|with|for|of|in|to|from|by|on|at|as|including|such|well|a|an|the|its|their)\b)+$",
    re.IGNORECASE,
)

_ALTERNATE_YAHOO_SYMBOLS: Dict[str, Tuple[str, ...]] = {
    "ZOMATO.NS": ("ETERNAL.NS",),
    "TATAMOTORS.NS": ("TMPV.NS", "TMCV.NS"),
    "MCDOWELL-N.NS": ("UNITDSPR.NS",),
    "LTIM.NS": ("LTM.NS",),
    "BRK-B": ("BRK.B",),
    "BF-B": ("BF.B",),
}


def _sanitize_summary_tokens(text: str) -> str:
    """Ensure clean plain-English output with zero sentinel/null tokens."""
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    cleaned = cleaned.replace("99.9%", "nearly 100%").replace("99.9", "nearly 100")
    cleaned = re.sub(r"\b(?:NaN|undefined|null|None)\b", "", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned


def _split_clean_sentences(raw_text: str) -> List[str]:
    protected = _ABBREV_DOT_RE.sub(lambda m: m.group(0)[:-1] + "<DOT>", raw_text)
    protected = _MULTI_INIT_RE.sub(lambda m: m.group(0).replace(".", "<DOT>"), protected)
    protected = _SINGLE_INIT_RE.sub(r"\1<DOT>", protected)
    protected = _EG_IE_RE.sub(lambda m: m.group(0).replace(".", "<DOT>"), protected)
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])", protected)
    out: List[str] = []
    for p in parts:
        restored = p.replace("<DOT>", ".").strip()
        if restored:
            out.append(restored)
    return out


def _clean_single_sentence(sent: str) -> str:
    s = _SUBSIDIARY_FILLER_RE.sub(" ", sent)
    s = re.sub(r"\bprimarily engages in the manufacture and sale of\b", "manufactures and sells", s, flags=re.I)
    s = re.sub(r"\bengages in the manufacture and sale of\b", "manufactures and sells", s, flags=re.I)
    s = re.sub(
        r"\bengages in the design,\s*manufacture,\s*and\s*(?:sale|marketing)\s+of\b",
        "designs, manufactures, and sells",
        s,
        flags=re.I,
    )
    s = re.sub(
        r"\bengages in the research,\s*development,\s*manufacture,\s*and\s*(?:sale|commercialization)\s+of\b",
        "develops, manufactures, and sells",
        s,
        flags=re.I,
    )
    s = re.sub(r"\bengages in the operation of\b", "operates", s, flags=re.I)
    s = re.sub(r"\bengages in the provision of\b", "provides", s, flags=re.I)
    s = re.sub(r"\bis engaged in the business of\b", "focuses on", s, flags=re.I)
    s = re.sub(r"\bprimarily engages in\b", "focuses on", s, flags=re.I)
    s = _LONG_GEO_TAIL_RE.sub(r" in \1 and internationally.", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s+,", ",", s)
    if s and s[-1] not in ".!?":
        s += "."
    return s


def _trim_sentence_to_budget(sent: str, budget: int) -> str:
    if len(sent) <= budget:
        return sent
    if budget < 40:
        return ""
    window = sent[: budget - 1]
    # Prefer cutting at semicolon or natural clause break first
    for sep in ("; ", ", as well as ", ", including ", ", such as ", ", which "):
        idx = window.rfind(sep)
        if idx >= max(45, budget // 2):
            cand = _TRAILING_STOPWORDS_RE.sub("", window[:idx].strip())
            if len(cand) >= 40:
                return cand + "."
    # Fall back to last comma or space boundary
    comma_idx = window.rfind(", ")
    if comma_idx >= max(55, int(budget * 0.62)):
        cand = _TRAILING_STOPWORDS_RE.sub("", window[:comma_idx].strip())
        if len(cand) >= 45:
            prev_comma = cand.rfind(", ")
            if prev_comma > 25 and ";" not in cand[prev_comma:] and " and " not in cand[prev_comma:].lower():
                with_and = cand[:prev_comma] + ", and " + cand[prev_comma + 2 :]
                if len(with_and) + 1 <= budget:
                    return with_and + "."
                shorter_prev = _TRAILING_STOPWORDS_RE.sub("", cand[:prev_comma].strip())
                prev2 = shorter_prev.rfind(", ")
                if prev2 > 25 and " and " not in shorter_prev[prev2:].lower():
                    with_and2 = shorter_prev[:prev2] + ", and " + shorter_prev[prev2 + 2 :]
                    if len(with_and2) >= 45 and len(with_and2) + 1 <= budget:
                        return with_and2 + "."
            return cand + "."
    space_idx = window.rfind(" ")
    cut = window[:space_idx] if space_idx > 25 else window
    cut = _TRAILING_STOPWORDS_RE.sub("", cut.strip())
    return (cut + ".") if cut else ""


def build_fallback_business_summary(name: str, industry: str, sector: str, market: str = "IN") -> str:
    clean_name = (name or "The company").strip()
    clean_ind = (industry or "").strip()
    clean_sec = (sector or "Diversified").strip()
    region = "India and global markets" if market == "IN" else "the United States and international markets"
    if clean_ind and clean_ind.lower() != clean_sec.lower():
        text = (
            f"{clean_name} operates in the {clean_ind} industry within the {clean_sec} sector, "
            f"providing specialized products and services across {region}."
        )
    else:
        text = (
            f"{clean_name} delivers core products and services across the {clean_sec} sector "
            f"for customers in {region}."
        )
    return _sanitize_summary_tokens(_trim_sentence_to_budget(text, 238))


def distill_business_summary(
    raw_summary: Optional[str],
    name: str,
    industry: str,
    sector: str,
    market: str = "IN",
    max_chars: int = 238,
) -> str:
    """Distill Yahoo `longBusinessSummary` into a crisp 1-2 sentence plain-English summary (<= ~240 chars)."""
    raw = re.sub(r"\s+", " ", str(raw_summary or "")).strip()
    if not raw:
        return build_fallback_business_summary(name, industry, sector, market)

    raw_sents = _split_clean_sentences(raw)
    kept: List[str] = []
    segment_fallbacks: List[str] = []

    for s in raw_sents:
        if _BOILERPLATE_SENT_RE.search(s) or _CORP_BASED_SENT_RE.search(s):
            continue
        if re.search(r"\boperates as a subsidiary of\b", s, flags=re.I) and len(raw_sents) > 1:
            continue
        cleaned = _clean_single_sentence(s)
        if len(cleaned) < 18:
            continue
        if _SEGMENT_ONLY_SENT_RE.match(cleaned):
            segment_fallbacks.append(cleaned)
            continue
        kept.append(cleaned)

    if not kept and segment_fallbacks:
        kept = segment_fallbacks

    if not kept:
        return build_fallback_business_summary(name, industry, sector, market)

    s1 = _trim_sentence_to_budget(kept[0], max_chars)
    if not s1:
        return build_fallback_business_summary(name, industry, sector, market)

    out = s1
    if len(kept) >= 2 and len(s1) <= max_chars - 48:
        rem = max_chars - len(s1) - 1
        s2_raw = kept[1]
        if len(s2_raw) <= rem:
            out = f"{s1} {s2_raw}"
        elif len(s1) < 135 and rem >= 65:
            s2_short = _trim_sentence_to_budget(s2_raw, rem)
            if len(s2_short) >= 45:
                out = f"{s1} {s2_short}"

    sanitized = _sanitize_summary_tokens(out)
    if len(sanitized) < 20:
        return build_fallback_business_summary(name, industry, sector, market)
    return sanitized


def sync_company_business_profiles(db: Optional[Database] = None, max_workers: int = 14) -> Dict[str, Any]:
    """Fetch `assetProfile` across all companies in `db` and populate `industry` + crisp `business_summary`."""
    if db is None:
        db = Database(db_path=DEFAULT_DB_PATH)

    t0 = time.time()
    companies = db.get_all_companies()
    if not companies:
        return {"companies_checked": 0, "yahoo_profiles_fetched": 0, "fallback_profiles": 0}

    s1_industry_map = {
        str(r["ticker"]): str(r.get("industry") or "").strip()
        for r in db.get_stage1_funnel()
    }

    cookies, crumb = authenticate_yahoo_crumb()
    enc_crumb = urllib.parse.quote(crumb, safe="")
    hosts = ("query2.finance.yahoo.com", "query1.finance.yahoo.com")

    logger.info("Fetching Yahoo v10 assetProfile for %d companies...", len(companies))

    def _fetch_profile(idx_comp: Tuple[int, Dict[str, Any]]) -> Tuple[str, str, str, bool]:
        idx, comp = idx_comp
        tk = str(comp["ticker"])
        name = str(comp.get("name") or tk)
        sector = str(comp.get("sector") or "Diversified")
        mkt = str(comp.get("market") or "IN")
        existing_ind = str(comp.get("industry") or "").strip() or s1_industry_map.get(tk, "")

        candidate_syms = (tk,) + _ALTERNATE_YAHOO_SYMBOLS.get(tk, ())
        ap_data: Optional[Dict[str, Any]] = None

        with httpx.Client(
            headers={"User-Agent": YAHOO_UA},
            cookies=cookies,
            follow_redirects=True,
            timeout=14.0,
        ) as client:
            for sym in candidate_syms:
                enc_sym = urllib.parse.quote(sym, safe="")
                for attempt in range(3):
                    host = hosts[(idx + attempt) % 2]
                    url = (
                        f"https://{host}/v10/finance/quoteSummary/{enc_sym}"
                        f"?modules=assetProfile&crumb={enc_crumb}"
                    )
                    try:
                        resp = client.get(url)
                    except Exception:
                        time.sleep(0.35 * (attempt + 1))
                        continue

                    if resp.status_code == 200:
                        try:
                            payload = resp.json()
                            results = (payload.get("quoteSummary") or {}).get("result") or []
                            if results and isinstance(results[0], dict):
                                ap = results[0].get("assetProfile") or {}
                                if ap.get("longBusinessSummary") or ap.get("industry"):
                                    ap_data = ap
                                    break
                        except Exception:
                            pass
                        break
                    if resp.status_code in (429, 500, 502, 503, 504):
                        time.sleep(0.65 * (attempt + 1))
                        continue
                    if resp.status_code == 404:
                        break
                    time.sleep(0.3 * (attempt + 1))
                if ap_data is not None:
                    break

        yahoo_ind = str((ap_data or {}).get("industry") or "").strip()
        resolved_ind = yahoo_ind or existing_ind or sector
        raw_summary = str((ap_data or {}).get("longBusinessSummary") or "").strip()
        used_yahoo = bool(raw_summary)
        summary_text = distill_business_summary(
            raw_summary=raw_summary,
            name=name,
            industry=resolved_ind,
            sector=sector,
            market=mkt,
            max_chars=238,
        )
        return tk, resolved_ind, summary_text, used_yahoo

    updates: List[Tuple[str, str, str]] = []
    s1_updates: List[Tuple[str, str]] = []
    yahoo_hits = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(16, max_workers))) as pool:
        for tk, ind, summary_text, used_yahoo in pool.map(_fetch_profile, enumerate(companies)):
            updates.append((ind, summary_text, tk))
            s1_updates.append((ind, tk))
            if used_yahoo:
                yahoo_hits += 1

    now_ts = int(time.time())
    with db.connect() as conn:
        conn.executemany(
            "UPDATE companies SET industry = ?, business_summary = ?, updated_at = ? WHERE ticker = ?",
            [(ind, summ, now_ts, tk) for ind, summ, tk in updates],
        )
        conn.executemany(
            "UPDATE stage1_funnel SET industry = ? WHERE ticker = ? AND (industry = '' OR industry IS NULL)",
            s1_updates,
        )

    elapsed = round(time.time() - t0, 1)
    result = {
        "companies_checked": len(companies),
        "yahoo_profiles_fetched": yahoo_hits,
        "fallback_profiles": len(companies) - yahoo_hits,
        "elapsed_sec": elapsed,
    }
    logger.info("Completed company business profile sync: %s", result)
    return result


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    result = ingest_street_signals()
    print("Street signals ingestion summary:", result)
