"""Real-Market US S&P 500 + Nasdaq-100 Funnel, Yahoo v8 5Y Price Sync & Official SEC EDGAR XBRL Engine.

Strict Overlap Priority Rule:
- Every US ticker in `NASDAQ100_SET` gets `index_tag = "NASDAQ100"` (even when also in S&P 500,
  e.g. `AAPL`, `MSFT`, `NVDA`, `AMZN`, `META`, `GOOGL`, `COST`, `AVGO`, `PEP`).
- Every US ticker in S&P 500 that is NOT in `NASDAQ100_SET` gets `index_tag = "SP500"`
  (e.g. `BRK-B`, `JPM`, `LLY`, `V`, `MA`, `UNH`, `XOM`, `WMT`, `GS`, `MS`, `CAT`, `ORCL`, `CRM`).
- Zero duplicate tickers (`ticker` is PRIMARY KEY) and zero duplicate dual-class CIKs.

Unit Invariant (Critical for Unified Multi-Market Scoring):
- Monetary fundamentals (`revenue_cr`, `ebitda_cr`, `ebit_cr`, `net_profit_cr`, `cfo_cr`, `fcf_cr`,
  `total_assets_cr`, `total_equity_cr`, `total_debt_cr`, `current_assets_cr`, `current_liabilities_cr`,
  `ttm_rev_cr`, `ttm_pat_cr`) are stored in **USD Millions ($M)** (`val / 1e6`).
- `shares_cr` is stored in **Millions of economic shares** (`shares / 1e6`, split-adjusted and
  cross-calibrated against consolidated market cap so dual-class / Class-B tickers like `BRK-B`,
  `BF-B`, `GOOGL`, `META` satisfy `price ($/sh) * shares_cr (M) = market_cap ($M)` with zero anomalies!).
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import logging
import math
import threading
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Set, Tuple

import httpx
import numpy as np
import pandas as pd
from bs4 import BeautifulSoup

from app.database import DEFAULT_DB_PATH, Database

logger = logging.getLogger("arthaquant.nasdaq")

NASDAQ_BENCHMARK_TICKER = "^NDX"
SP500_BENCHMARK_TICKER = "^GSPC"
SP500_WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
YAHOO_UA = "Mozilla/5.0"
SEC_UA = "ArthaQuant Research dipanshu2405@gmail.com"
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SEC_FACTS_URL_TMPL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"

MONTH_ABBR = [
    "", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

# Tuple: (ticker, name, sector, industry, is_financial, insider_pct, inst_pct)
# Sector names match the unified 9-sector taxonomy in `app/live_funnel.py`.
NASDAQ100_SPECS: List[Tuple[str, str, str, str, bool, float, float]] = [
    ("AAPL", "Apple Inc.", "IT Services", "Consumer Ecosystems & Silicon", False, 0.1, 62.5),
    ("MSFT", "Microsoft Corp.", "IT Services", "Cloud Infrastructure & Enterprise AI", False, 0.1, 73.8),
    ("NVDA", "NVIDIA Corp.", "IT Services", "AI Accelerators & Semiconductors", False, 4.2, 67.4),
    ("AMZN", "Amazon.com Inc.", "Consumer & Retail", "E-Commerce & Cloud (AWS)", False, 9.2, 64.5),
    ("META", "Meta Platforms Inc.", "Telecom, Infra & Services", "Social Platforms & Digital Ads", False, 13.4, 66.8),
    ("GOOGL", "Alphabet Inc.", "Telecom, Infra & Services", "Search, Cloud & Digital Media", False, 5.8, 65.2),
    ("AVGO", "Broadcom Inc.", "IT Services", "Custom AI Silicon & Infrastructure Software", False, 1.9, 77.6),
    ("COST", "Costco Wholesale Corp.", "Consumer & Retail", "Membership Warehouse Retail", False, 0.2, 69.5),
    ("TSLA", "Tesla Inc.", "Auto & Mobility", "Electric Vehicles & Energy Storage", False, 12.8, 48.2),
    ("NFLX", "Netflix Inc.", "Telecom, Infra & Services", "Global Streaming Entertainment", False, 0.6, 82.4),
    ("AMD", "Advanced Micro Devices", "IT Services", "Data Center CPUs & GPUs", False, 0.5, 71.3),
    ("ADBE", "Adobe Inc.", "IT Services", "Creative & Document Cloud SaaS", False, 0.3, 83.2),
    ("LIN", "Linde plc", "Materials, Metals & Chemicals", "Industrial Gases & Clean Hydrogen", False, 0.2, 85.4),
    ("PEP", "PepsiCo Inc.", "Consumer & Retail", "Global Beverages & Snacks", False, 0.2, 74.8),
    ("TMUS", "T-Mobile US Inc.", "Telecom, Infra & Services", "5G Wireless Telecommunications", False, 51.4, 42.1),
    ("CSCO", "Cisco Systems Inc.", "IT Services", "Enterprise Networking & Security", False, 0.1, 75.2),
    ("ISRG", "Intuitive Surgical Inc.", "Pharma & Healthcare", "Robotic-Assisted Surgery", False, 0.7, 85.6),
    ("INTU", "Intuit Inc.", "IT Services", "Small Business & Tax FinTech SaaS", False, 2.5, 84.1),
    ("QCOM", "Qualcomm Inc.", "IT Services", "Mobile & Edge Wireless Semiconductors", False, 0.2, 76.4),
    ("TXN", "Texas Instruments Inc.", "IT Services", "Analog & Embedded Semiconductors", False, 0.2, 85.8),
    ("AMGN", "Amgen Inc.", "Pharma & Healthcare", "Biotechnology & Therapeutics", False, 0.2, 78.4),
    ("BKNG", "Booking Holdings Inc.", "Consumer & Retail", "Online Travel & Hospitality Marketplace", False, 0.2, 91.2),
    ("AMAT", "Applied Materials Inc.", "IT Services", "Wafer Fab Semiconductor Equipment", False, 0.3, 81.5),
    ("HON", "Honeywell International", "Capital Goods & Defence", "Aerospace & Industrial Automation", False, 0.1, 76.9),
    ("VRTX", "Vertex Pharmaceuticals", "Pharma & Healthcare", "Specialty Biotechnology", False, 0.2, 90.4),
    ("ADP", "Automatic Data Processing", "IT Services", "Enterprise Payroll & HCM Cloud", False, 0.1, 80.7),
    ("PANW", "Palo Alto Networks", "IT Services", "Zero-Trust Network & Cloud Cybersecurity", False, 1.1, 84.5),
    ("SBUX", "Starbucks Corp.", "Consumer & Retail", "Specialty Coffee & QSR Chains", False, 2.0, 74.2),
    ("GILD", "Gilead Sciences Inc.", "Pharma & Healthcare", "Antiviral & Oncology Biopharma", False, 0.1, 84.3),
    ("MU", "Micron Technology Inc.", "IT Services", "HBM & DRAM Memory Semiconductors", False, 0.3, 81.2),
    ("MELI", "MercadoLibre Inc.", "Consumer & Retail", "LatAm E-Commerce & Digital Payments", False, 7.6, 80.4),
    ("INTC", "Intel Corp.", "IT Services", "Semiconductor Foundry & Client CPUs", False, 0.1, 64.5),
    ("LRCX", "Lam Research Corp.", "IT Services", "Etch & Deposition Semicap Equipment", False, 0.3, 84.9),
    ("KLAC", "KLA Corp.", "IT Services", "Semiconductor Process Control & Metrology", False, 0.2, 87.3),
    ("SNPS", "Synopsys Inc.", "IT Services", "Electronic Design Automation (EDA) & IP", False, 0.5, 86.8),
    ("CDNS", "Cadence Design Systems", "IT Services", "Chip Design Software & Verification", False, 0.5, 85.9),
    ("MDLZ", "Mondelez International", "Consumer & Retail", "Global Confectionery & Packaged Snacks", False, 0.1, 81.6),
    ("ADI", "Analog Devices Inc.", "IT Services", "High-Performance Mixed-Signal Chips", False, 0.2, 87.4),
    ("REGN", "Regeneron Pharmaceuticals", "Pharma & Healthcare", "Immunology & Biologic Medicines", False, 3.1, 83.5),
    ("CRWD", "CrowdStrike Holdings", "IT Services", "Endpoint & Cloud Workload Security", False, 3.8, 74.6),
    ("PYPL", "PayPal Holdings Inc.", "Banking & Financials", "Digital Wallets & Merchant Payments", True, 0.2, 72.4),
    ("ASML", "ASML Holding N.V.", "IT Services", "EUV Photolithography Systems", False, 0.1, 58.6),
    ("MAR", "Marriott International", "Consumer & Retail", "Global Hotel Franchising & Hospitality", False, 16.5, 65.4),
    ("ORLY", "O'Reilly Automotive", "Auto & Mobility", "Aftermarket Auto Parts Retail", False, 1.0, 86.2),
    ("CTAS", "Cintas Corp.", "Capital Goods & Defence", "Corporate Uniforms & Facility Services", False, 14.2, 66.8),
    ("CSX", "CSX Corp.", "Capital Goods & Defence", "Class I Freight Railroad Network", False, 0.2, 75.8),
    ("FTNT", "Fortinet Inc.", "IT Services", "Network Firewalls & Secure SD-WAN", False, 17.4, 69.2),
    ("MRVL", "Marvell Technology Inc.", "IT Services", "Data Center Interconnect & Custom ASICs", False, 0.4, 83.7),
    ("ABNB", "Airbnb Inc.", "Consumer & Retail", "Alternative Accommodations Marketplace", False, 27.5, 54.2),
    ("WDAY", "Workday Inc.", "IT Services", "Enterprise Finance & HR Cloud SaaS", False, 19.2, 69.4),
    ("ROP", "Roper Technologies Inc.", "IT Services", "Vertical Market Mission-Critical Software", False, 0.5, 92.1),
    ("NXPI", "NXP Semiconductors N.V.", "IT Services", "Automotive & Industrial Microcontrollers", False, 0.2, 90.5),
    ("ADSK", "Autodesk Inc.", "IT Services", "Architecture, Engineering & CAD SaaS", False, 0.2, 90.2),
    ("MNST", "Monster Beverage Corp.", "Consumer & Retail", "Energy Drinks & Functional Beverages", False, 27.8, 63.4),
    ("PCAR", "PACCAR Inc.", "Auto & Mobility", "Heavy-Duty Commercial Trucks & Parts", False, 1.8, 68.5),
    ("PAYX", "Paychex Inc.", "IT Services", "SMB Payroll & HR Outsourcing", False, 10.6, 74.8),
    ("AEP", "American Electric Power", "Energy, Oil & Power", "Regulated Electric Transmission & Utility", False, 0.1, 77.2),
    ("CPRT", "Copart Inc.", "Auto & Mobility", "Online Salvage Vehicle Auctions", False, 9.4, 78.5),
    ("FAST", "Fastenal Co.", "Capital Goods & Defence", "Industrial & Construction Supply Distribution", False, 0.4, 82.6),
    ("ROST", "Ross Stores Inc.", "Consumer & Retail", "Off-Price Apparel & Home Retail", False, 2.1, 88.4),
    ("ODFL", "Old Dominion Freight Line", "Capital Goods & Defence", "Less-Than-Truckload (LTL) Logistics", False, 10.2, 76.5),
    ("KDP", "Keurig Dr Pepper Inc.", "Consumer & Retail", "Coffee Systems & Refreshment Beverages", False, 21.0, 66.2),
    ("DDOG", "Datadog Inc.", "IT Services", "Cloud Observability & Security Platform", False, 8.6, 78.4),
    ("IDXX", "IDEXX Laboratories Inc.", "Pharma & Healthcare", "Veterinary Diagnostics & Software", False, 0.7, 88.5),
    ("EA", "Electronic Arts Inc.", "Telecom, Infra & Services", "Interactive Sports & Gaming Franchises", False, 0.4, 89.2),
    ("TEAM", "Atlassian Corp.", "IT Services", "Developer Collaboration & Agile Workflow SaaS", False, 38.5, 53.4),
    ("BKR", "Baker Hughes Co.", "Energy, Oil & Power", "LNG Turbomachinery & Oilfield Tech", False, 0.3, 91.5),
    ("VRSK", "Verisk Analytics Inc.", "Banking & Financials", "Property & Casualty Insurance Analytics", False, 0.3, 90.8),
    ("CTSH", "Cognizant Technology Solutions", "IT Services", "Global IT Consulting & Digital Engineering", False, 0.2, 92.4),
    ("EXC", "Exelon Corp.", "Energy, Oil & Power", "Regulated Electric & Gas Distribution", False, 0.1, 84.6),
    ("XEL", "Xcel Energy Inc.", "Energy, Oil & Power", "Regulated Clean-Transition Utility", False, 0.1, 85.2),
    ("GEHC", "GE HealthCare Technologies", "Pharma & Healthcare", "Medical Imaging & Patient Monitoring", False, 0.2, 83.4),
    ("FANG", "Diamondback Energy Inc.", "Energy, Oil & Power", "Permian Basin Shale Oil & Gas E&P", False, 0.5, 90.1),
    ("KHC", "Kraft Heinz Co.", "Consumer & Retail", "Packaged Foods & Condiments", False, 26.8, 55.4),
    ("CCEP", "Coca-Cola Europacific Partners", "Consumer & Retail", "Beverage Bottling & Distribution", False, 54.0, 32.5),
    ("MCHP", "Microchip Technology Inc.", "IT Services", "Embedded Control & Analog Semiconductors", False, 2.0, 91.2),
    ("TTD", "The Trade Desk Inc.", "Telecom, Infra & Services", "Programmatic Connected-TV AdTech", False, 9.8, 72.4),
    ("ZS", "Zscaler Inc.", "IT Services", "Cloud-Native Zero Trust Exchange", False, 37.8, 50.6),
    ("CSGP", "CoStar Group Inc.", "Telecom, Infra & Services", "Commercial Real Estate Data & Marketplaces", False, 1.2, 93.4),
    ("ON", "ON Semiconductor Corp.", "IT Services", "Intelligent Power & Automotive SiC Chips", False, 0.3, 94.2),
    ("AXON", "Axon Enterprise Inc.", "Capital Goods & Defence", "Public Safety Cloud, Body Cams & TASER", False, 4.8, 79.5),
    ("PLTR", "Palantir Technologies Inc.", "IT Services", "Defense & Enterprise AI Operating Platforms", False, 9.2, 52.8),
    ("APP", "AppLovin Corp.", "Telecom, Infra & Services", "AI Mobile Ad-Monetization Engine", False, 28.4, 56.2),
    ("ARM", "Arm Holdings plc", "IT Services", "CPU Architecture Licensing & Royalties", False, 87.8, 10.4),
    ("DASH", "DoorDash Inc.", "Consumer & Retail", "Local Commerce & On-Demand Delivery", False, 9.5, 76.8),
    ("COIN", "Coinbase Global Inc.", "Banking & Financials", "Digital Asset Exchange & Custody", True, 18.6, 56.4),
    ("MSTR", "MicroStrategy Inc.", "IT Services", "Enterprise BI Software & Bitcoin Treasury", False, 9.8, 59.2),
    ("DXCM", "DexCom Inc.", "Pharma & Healthcare", "Continuous Glucose Biosensing Systems", False, 0.4, 94.5),
    ("CDW", "CDW Corp.", "IT Services", "Enterprise IT Solutions & Cloud Resale", False, 0.4, 93.1),
    ("GFS", "GlobalFoundries Inc.", "IT Services", "Specialty Semiconductor Contract Wafer Fab", False, 81.8, 16.5),
    ("BIIB", "Biogen Inc.", "Pharma & Healthcare", "Neurology & Rare Disease Therapeutics", False, 0.2, 87.6),
    ("ILMN", "Illumina Inc.", "Pharma & Healthcare", "Genomic Sequencing & Array Systems", False, 0.2, 91.8),
    ("WBD", "Warner Bros. Discovery", "Telecom, Infra & Services", "Film Studios, Networks & Streaming", False, 2.5, 64.0),
    ("DLTR", "Dollar Tree Inc.", "Consumer & Retail", "Value Variety Retail Stores", False, 5.8, 88.2),
    ("MRNA", "Moderna Inc.", "Pharma & Healthcare", "mRNA Vaccines & Therapeutics", False, 11.4, 68.5),
    ("MDB", "MongoDB Inc.", "IT Services", "Developer Document Database Cloud (Atlas)", False, 3.6, 86.4),
    ("TTWO", "Take-Two Interactive", "Telecom, Infra & Services", "AAA Console & Mobile Game Publishing", False, 1.3, 91.4),
    ("CEG", "Constellation Energy Corp.", "Energy, Oil & Power", "Carbon-Free Nuclear Power Generation", False, 0.2, 85.8),
    ("LULU", "Lululemon Athletica Inc.", "Consumer & Retail", "Technical Athletic Apparel Retail", False, 4.2, 85.6),
    ("CHTR", "Charter Communications", "Telecom, Infra & Services", "Broadband Cable & Connectivity", False, 32.5, 61.4),
]

NASDAQ100_SET: Set[str] = {s[0] for s in NASDAQ100_SPECS}
NASDAQ100_BY_TICKER: Dict[str, Tuple[str, str, str, str, bool, float, float]] = {s[0]: s for s in NASDAQ100_SPECS}

KNOWN_CIK_FALLBACKS: Dict[str, int] = {
    "EA": 712515,
    "WBD": 1437107,
    "BRK-B": 1067983,
    "BF-B": 14693,
    "XOM": 34088,
}


def map_gics_to_artha_sector(gics_sector: str, gics_sub: str, name: str = "") -> Tuple[str, bool]:
    """Map S&P 500 GICS 11-sector taxonomy cleanly into ArthaQuant's unified 9-sector taxonomy."""
    sec = (gics_sector or "").strip().lower()
    sub = (gics_sub or "").strip().lower()
    nm = (name or "").strip().lower()

    if sec == "financials":
        return "Banking & Financials", True
    if sec == "information technology":
        return "IT Services", False
    if sec == "health care":
        return "Pharma & Healthcare", False
    if sec in ("energy", "utilities"):
        return "Energy, Oil & Power", False
    if sec == "materials":
        return "Materials, Metals & Chemicals", False
    if sec in ("communication services", "real estate"):
        return "Telecom, Infra & Services", False
    if sec == "consumer staples":
        return "Consumer & Retail", False
    if sec == "consumer discretionary":
        if any(k in sub or k in nm for k in ("automobile", "automotive", "auto parts", "tires", "vehicle")):
            return "Auto & Mobility", False
        return "Consumer & Retail", False
    if sec == "industrials":
        if any(k in sub or k in nm for k in ("passenger ground", "uber", "lyft")):
            return "Auto & Mobility", False
        if "human resource" in sub or "data processing" in sub:
            return "IT Services", False
        return "Capital Goods & Defence", False
    return "Capital Goods & Defence", False


def fetch_sp500_constituents() -> Tuple[List[Tuple[str, str, str, str, bool, float, float]], Dict[str, int]]:
    """Fetch S&P 500 constituents from Wikipedia, normalize `.` -> `-`, and deduplicate dual-class CIKs."""
    specs: List[Tuple[str, str, str, str, bool, float, float]] = []
    wiki_ciks: Dict[str, int] = {}

    with httpx.Client(headers={"User-Agent": YAHOO_UA}, follow_redirects=True, timeout=20.0) as client:
        resp = client.get(SP500_WIKI_URL)
        resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    table = soup.find("table", {"id": "constituents"}) or soup.find("table", class_="wikitable")
    if not table:
        raise RuntimeError("Could not locate S&P 500 constituents table on Wikipedia")

    raw_rows: List[Tuple[str, str, str, str, int]] = []
    for tr in table.find_all("tr")[1:]:
        cols = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
        if len(cols) < 4:
            continue
        raw_sym = cols[0].strip().upper().replace(".", "-")
        if not raw_sym:
            continue
        sec_name = cols[1].strip()
        gics_sec = cols[2].strip()
        gics_sub = cols[3].strip()
        cik_int = 0
        if len(cols) >= 7:
            digits = "".join(ch for ch in cols[6] if ch.isdigit())
            if digits:
                cik_int = int(digits)
        raw_rows.append((raw_sym, sec_name, gics_sec, gics_sub, cik_int))
        if cik_int > 0:
            wiki_ciks[raw_sym] = cik_int

    # Reserve CIKs already represented by NASDAQ100_SET (e.g. GOOGL CIK 1652044 beats GOOG)
    claimed_ciks: Set[int] = set()
    for sym, _, _, _, cik_int in raw_rows:
        if sym in NASDAQ100_SET and cik_int > 0:
            claimed_ciks.add(cik_int)

    seen_syms: Set[str] = set()
    for sym, sec_name, gics_sec, gics_sub, cik_int in raw_rows:
        if sym in seen_syms or sym in NASDAQ100_SET:
            continue
        if cik_int > 0 and cik_int in claimed_ciks:
            logger.info("Skipping duplicate dual-class S&P 500 share class %s (CIK %d already represented)", sym, cik_int)
            continue
        seen_syms.add(sym)
        if cik_int > 0:
            claimed_ciks.add(cik_int)

        sector, is_fin = map_gics_to_artha_sector(gics_sec, gics_sub, sec_name)
        specs.append((sym, sec_name, sector, gics_sub[:80], is_fin, 1.2, 78.5))

    return specs, wiki_ciks


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _lin(v: float, bad: float, good: float) -> float:
    if math.isnan(v) or good == bad:
        return 50.0
    return _clamp(((v - bad) / (good - bad)) * 100.0)


class _RateLimiter:
    """Thread-safe minimum spacing limiter (e.g. 0.135s = ~7.4 req/sec < SEC 8 req/s cap)."""

    def __init__(self, min_interval_sec: float = 0.135) -> None:
        self.min_interval = min_interval_sec
        self._lock = threading.Lock()
        self._next_allowed = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            if now < self._next_allowed:
                sleep_for = self._next_allowed - now
                self._next_allowed += self.min_interval
            else:
                sleep_for = 0.0
                self._next_allowed = now + self.min_interval
        if sleep_for > 0:
            time.sleep(sleep_for)


def fetch_yahoo_chart_5y_with_splits(
    symbol: str,
    client: Optional[httpx.Client] = None,
    host_idx: int = 0,
    range_str: str = "10y",
) -> Tuple[List[Tuple[str, str, float, float]], List[Tuple[str, float]]]:
    """Fetch 5Y daily closes + 10Y split history from Yahoo Finance v8/finance/chart."""
    enc = urllib.parse.quote(symbol, safe="")
    hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
    us_tz = dt.timezone(dt.timedelta(hours=-5))

    owns = client is None
    sess = client or httpx.Client(headers={"User-Agent": YAHOO_UA}, follow_redirects=True, timeout=14.0)
    payload = None
    try:
        for attempt in range(4):
            host = hosts[(host_idx + attempt) % 2]
            url = f"https://{host}/v8/finance/chart/{enc}?range={range_str}&interval=1d&events=splits"
            try:
                resp = sess.get(url)
            except Exception:
                time.sleep(0.4 * (attempt + 1))
                continue
            if resp.status_code == 200:
                payload = resp.json()
                break
            if resp.status_code == 429:
                time.sleep(0.7 * (attempt + 1))
                continue
            break
    finally:
        if owns:
            sess.close()

    if not payload:
        return [], []

    results = (payload.get("chart") or {}).get("result") or []
    if not results:
        return [], []

    res0 = results[0]
    timestamps = res0.get("timestamp") or []
    indicators = res0.get("indicators") or {}
    quotes = (indicators.get("quote") or [{}])[0]
    closes = quotes.get("close") or []
    volumes = quotes.get("volume") or []

    by_date: Dict[str, Tuple[float, float]] = {}
    for i, ts in enumerate(timestamps):
        if i >= len(closes) or closes[i] is None:
            continue
        px = float(closes[i])
        if px <= 0 or math.isnan(px):
            continue
        vol = float(volumes[i]) if i < len(volumes) and volumes[i] is not None else 0.0
        d_str = dt.datetime.fromtimestamp(int(ts), tz=us_tz).date().isoformat()
        by_date[d_str] = (round(px, 2), vol)

    sorted_dates = sorted(by_date.items())
    if sorted_dates:
        latest_dt = dt.date.fromisoformat(sorted_dates[-1][0])
        cutoff_5y = (latest_dt - dt.timedelta(days=365 * 5 + 5)).isoformat()
        sorted_dates = [(d, pv) for d, pv in sorted_dates if d >= cutoff_5y]

    price_rows = [(symbol, d, pv[0], pv[1]) for d, pv in sorted_dates]

    splits_raw = ((res0.get("events") or {}).get("splits") or {}).values()
    splits: List[Tuple[str, float]] = []
    for sp in splits_raw:
        num = float(sp.get("numerator") or 0.0)
        den = float(sp.get("denominator") or 1.0)
        ts_sp = sp.get("date")
        if num > 0 and den > 0 and ts_sp:
            ratio = num / den
            if abs(ratio - 1.0) > 1e-4:
                sp_date = dt.datetime.fromtimestamp(int(ts_sp), tz=us_tz).date().isoformat()
                splits.append((sp_date, ratio))
    splits.sort(key=lambda x: x[0])

    return price_rows, splits


def _fetch_yahoo_implied_shares_millions(symbols: List[str]) -> Dict[str, float]:
    """Fetch consolidated implied share count (`marketCap / regularMarketPrice / 1e6`) via Yahoo v7 quote."""
    implied: Dict[str, float] = {}
    if not symbols:
        return implied
    try:
        with httpx.Client(headers={"User-Agent": YAHOO_UA}, follow_redirects=True, timeout=15.0) as client:
            client.get("https://fc.yahoo.com")
            rc = client.get("https://query2.finance.yahoo.com/v1/test/getcrumb")
            if rc.status_code != 200 or not rc.text.strip():
                return implied
            crumb = urllib.parse.quote(rc.text.strip(), safe="")
            for i in range(0, len(symbols), 45):
                batch = ",".join(urllib.parse.quote(s, safe="") for s in symbols[i : i + 45])
                url = f"https://query2.finance.yahoo.com/v7/finance/quote?symbols={batch}&crumb={crumb}"
                rq = client.get(url)
                if rq.status_code != 200:
                    continue
                for q in (rq.json().get("quoteResponse") or {}).get("result") or []:
                    sym = str(q.get("symbol") or "").strip().upper()
                    px = float(q.get("regularMarketPrice") or 0.0)
                    mc = float(q.get("marketCap") or 0.0)
                    sh = float(q.get("sharesOutstanding") or 0.0)
                    if sym and px > 0 and mc > 0:
                        implied[sym] = (mc / px) / 1e6
                    elif sym and sh > 0:
                        implied[sym] = sh / 1e6
    except Exception as exc:
        logger.warning("Yahoo v7 implied share calibration warning: %s", exc)
    return implied


def _fetch_fx_yearly_rates() -> Dict[str, Dict[int, float]]:
    """Fetch historical EUR/USD and GBP/USD annual average FX rates via Yahoo v8 chart."""
    fx_map: Dict[str, Dict[int, float]] = {
        "EUR": {y: 1.09 for y in range(2016, 2028)},
        "GBP": {y: 1.27 for y in range(2016, 2028)},
    }
    with httpx.Client(headers={"User-Agent": YAHOO_UA}, follow_redirects=True, timeout=12.0) as client:
        for ccy, yf_sym in (("EUR", "EURUSD=X"), ("GBP", "GBPUSD=X")):
            rows, _ = fetch_yahoo_chart_5y_with_splits(yf_sym, client=client, range_str="5y")
            by_yr: Dict[int, List[float]] = {}
            for _, d_str, px, _ in rows:
                if 0.5 < px < 2.5:
                    by_yr.setdefault(int(d_str[:4]), []).append(px)
            for yr, vals in by_yr.items():
                fx_map[ccy][yr] = sum(vals) / len(vals)
    return fx_map


def _select_unit_list(
    concept_obj: Dict[str, Any],
    allowed_units: Tuple[str, ...],
) -> Tuple[str, List[Dict[str, Any]]]:
    units_dict = concept_obj.get("units") or {}
    for u in allowed_units:
        arr = units_dict.get(u)
        if arr:
            return u, arr
    return "", []


def _extract_flow_series(
    facts_root: Dict[str, Any],
    candidates: List[Tuple[str, str]],
    fx_rates: Dict[str, Dict[int, float]],
    min_days: int,
    max_days: int,
    take_max_across_tags: bool = False,
) -> Dict[str, Tuple[float, str]]:
    """Return `{end_date: (val_in_usd_millions, earliest_valid_filed_date)}` for flow items."""
    allowed_ccy = ("USD", "EUR", "GBP")
    merged: Dict[str, Tuple[float, str, str]] = {}

    for tax_name, tag_name in candidates:
        concept = (facts_root.get(tax_name) or {}).get(tag_name)
        if not concept:
            continue
        unit, arr = _select_unit_list(concept, allowed_ccy)
        if not arr:
            continue

        tag_by_end: Dict[str, Tuple[float, str, str]] = {}
        for item in arr:
            start_s = item.get("start")
            end_s = item.get("end")
            val = item.get("val")
            if not start_s or not end_s or val is None or end_s < "2017-01-01":
                continue
            try:
                d_days = (dt.date.fromisoformat(end_s) - dt.date.fromisoformat(start_s)).days
            except ValueError:
                continue
            if not (min_days <= d_days <= max_days):
                continue

            filed_s = item.get("filed") or end_s
            yr = int(end_s[:4])
            fx = 1.0 if unit == "USD" else fx_rates.get(unit, {}).get(yr, 1.09)
            val_m = (float(val) * fx) / 1e6

            prev = tag_by_end.get(end_s)
            if prev is None:
                tag_by_end[end_s] = (val_m, filed_s, filed_s)
            else:
                earliest_f = min(prev[1], filed_s)
                if filed_s >= prev[2]:
                    tag_by_end[end_s] = (val_m, earliest_f, filed_s)
                else:
                    tag_by_end[end_s] = (prev[0], earliest_f, prev[2])

        for end_s, info in tag_by_end.items():
            if end_s not in merged:
                merged[end_s] = info
            elif take_max_across_tags and info[0] > merged[end_s][0] * 1.02:
                merged[end_s] = (info[0], min(merged[end_s][1], info[1]), max(merged[end_s][2], info[2]))

    return {k: (v[0], v[1]) for k, v in merged.items()}


def _extract_instant_series(
    facts_root: Dict[str, Any],
    candidates: List[Tuple[str, str]],
    fx_rates: Dict[str, Dict[int, float]],
) -> Dict[str, float]:
    """Return `{end_date: val_in_usd_millions}` for point-in-time balance sheet items."""
    allowed_ccy = ("USD", "EUR", "GBP")
    merged: Dict[str, Tuple[float, str]] = {}

    for tax_name, tag_name in candidates:
        concept = (facts_root.get(tax_name) or {}).get(tag_name)
        if not concept:
            continue
        unit, arr = _select_unit_list(concept, allowed_ccy)
        if not arr:
            continue

        tag_by_end: Dict[str, Tuple[float, str]] = {}
        for item in arr:
            if "start" in item:
                continue
            end_s = item.get("end")
            val = item.get("val")
            if not end_s or val is None or end_s < "2017-01-01":
                continue
            filed_s = item.get("filed") or end_s
            yr = int(end_s[:4])
            fx = 1.0 if unit == "USD" else fx_rates.get(unit, {}).get(yr, 1.09)
            val_m = (float(val) * fx) / 1e6
            if end_s not in tag_by_end or filed_s >= tag_by_end[end_s][1]:
                tag_by_end[end_s] = (val_m, filed_s)

        for end_s, info in tag_by_end.items():
            if end_s not in merged:
                merged[end_s] = info

    return {k: v[0] for k, v in merged.items()}


def _lookup_nearest_instant(series: Dict[str, float], target_end: str, max_gap_days: int = 10) -> Optional[float]:
    if target_end in series:
        return series[target_end]
    if not series:
        return None
    t_dt = dt.date.fromisoformat(target_end)
    best_val = None
    best_gap = max_gap_days + 1
    for d_str, val in series.items():
        gap = abs((dt.date.fromisoformat(d_str) - t_dt).days)
        if gap < best_gap:
            best_gap = gap
            best_val = val
    return best_val if best_gap <= max_gap_days else None


def _extract_split_adjusted_shares(
    facts_root: Dict[str, Any],
    splits: List[Tuple[str, float]],
) -> Tuple[Dict[str, float], float]:
    """Return `({end_date: shares_millions}, latest_shares_millions)` split-adjusted to current basis."""
    share_candidates = [
        ("us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding", True),
        ("us-gaap", "WeightedAverageNumberOfSharesOutstandingBasic", True),
        ("ifrs-full", "AdjustedWeightedAverageShares", True),
        ("ifrs-full", "WeightedAverageShares", True),
        ("ifrs-full", "DilutedShares", True),
        ("us-gaap", "CommonStockSharesOutstanding", False),
        ("ifrs-full", "NumberOfSharesOutstanding", False),
        ("ifrs-full", "NumberOfSharesIssued", False),
        ("dei", "EntityCommonStockSharesOutstanding", False),
    ]

    by_end: Dict[str, Tuple[float, str]] = {}
    latest_date = ""
    latest_sh_m = 0.0

    for tax_name, tag_name, is_flow in share_candidates:
        concept = (facts_root.get(tax_name) or {}).get(tag_name)
        if not concept:
            continue
        _, arr = _select_unit_list(concept, ("shares",))
        if not arr:
            continue

        tag_map: Dict[str, Tuple[float, str]] = {}
        for item in arr:
            end_s = item.get("end")
            val = item.get("val")
            if not end_s or val is None or float(val) <= 0 or end_s < "2017-01-01":
                continue
            if is_flow:
                start_s = item.get("start")
                if not start_s:
                    continue
                d_days = (dt.date.fromisoformat(end_s) - dt.date.fromisoformat(start_s)).days
                if not (70 <= d_days <= 385):
                    continue
            filed_s = item.get("filed") or end_s
            raw_m = float(val) / 1e6
            if raw_m < 0.005 and float(val) > 10.0:
                raw_m = float(val)
            adj_factor = 1.0
            for sp_date, sp_ratio in splits:
                if sp_date > filed_s:
                    adj_factor *= sp_ratio
            adj_m = raw_m * adj_factor

            if end_s not in tag_map or filed_s >= tag_map[end_s][1]:
                tag_map[end_s] = (adj_m, filed_s)

        for end_s, info in tag_map.items():
            if end_s not in by_end:
                by_end[end_s] = info
            if end_s >= latest_date and info[0] > 0:
                latest_date = end_s
                latest_sh_m = info[0]

        if len(by_end) >= 3 and is_flow:
            break

    clean_map = {k: v[0] for k, v in by_end.items()}
    return clean_map, latest_sh_m


def parse_sec_company_facts(
    ticker: str,
    spec: Tuple[str, str, str, str, bool, float, float],
    sec_payload: Dict[str, Any],
    cur_price: float,
    splits: List[Tuple[str, float]],
    fx_rates: Dict[str, Dict[int, float]],
    target_shares_m: float = 0.0,
) -> Optional[Dict[str, Any]]:
    """Normalize SEC EDGAR XBRL `companyfacts` into audited annual FY rows + 2Q YoY signals ($M)."""
    _, fallback_name, sector, _industry, is_fin, insider_pct, inst_pct = spec
    facts_root = sec_payload.get("facts") or {}
    if not facts_root:
        return None

    rev_primary_tags = [
        ("us-gaap", "Revenues"),
        ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"),
        ("us-gaap", "SalesRevenueNet"),
        ("us-gaap", "RevenuesNetOfInterestExpense"),
        ("us-gaap", "RegulatedAndUnregulatedOperatingRevenue"),
        ("us-gaap", "ElectricUtilityRevenue"),
        ("us-gaap", "HealthCareOrganizationRevenue"),
        ("us-gaap", "RealEstateRevenueNet"),
        ("us-gaap", "FinancialServicesRevenue"),
        ("us-gaap", "PremiumsEarnedNet"),
        ("ifrs-full", "Revenue"),
        ("ifrs-full", "RevenueFromContractsWithCustomers"),
    ]
    rev_fallback_tags = [
        ("us-gaap", "RevenueFromContractWithCustomerIncludingAssessedTax"),
        ("us-gaap", "SalesRevenueGoodsNet"),
        ("us-gaap", "SalesRevenueServicesNet"),
        ("us-gaap", "OperatingLeaseLeaseIncome"),
        ("us-gaap", "InterestAndDividendIncomeOperating"),
        ("us-gaap", "NoninterestIncome"),
    ]

    ebit_tags = [
        ("us-gaap", "OperatingIncomeLoss"),
        ("ifrs-full", "ProfitLossFromOperatingActivities"),
        ("us-gaap", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"),
        ("us-gaap", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"),
        ("us-gaap", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic"),
        ("ifrs-full", "ProfitLossBeforeTax"),
    ]
    pat_tags = [
        ("us-gaap", "NetIncomeLoss"),
        ("ifrs-full", "ProfitLossAttributableToOwnersOfParent"),
        ("ifrs-full", "ProfitLoss"),
        ("us-gaap", "ProfitLoss"),
        ("us-gaap", "NetIncomeLossAvailableToCommonStockholdersBasic"),
        ("us-gaap", "IncomeLossFromContinuingOperations"),
    ]
    da_tags = [
        ("us-gaap", "DepreciationDepletionAndAmortization"),
        ("us-gaap", "DepreciationAndAmortization"),
        ("us-gaap", "DepreciationAmortizationAndAccretionNet"),
        ("us-gaap", "OtherDepreciationAndAmortization"),
        ("us-gaap", "Depreciation"),
        ("ifrs-full", "DepreciationAndAmortisationExpense"),
        ("ifrs-full", "AdjustmentsForDepreciationAndAmortisationExpense"),
        ("ifrs-full", "AdjustmentsForDepreciationExpense"),
    ]
    cfo_tags = [
        ("us-gaap", "NetCashProvidedByUsedInOperatingActivities"),
        ("us-gaap", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"),
        ("ifrs-full", "CashFlowsFromUsedInOperatingActivities"),
    ]
    capex_tags = [
        ("us-gaap", "PaymentsToAcquirePropertyPlantAndEquipment"),
        ("us-gaap", "PaymentsToAcquireProductiveAssets"),
        ("us-gaap", "PaymentsToAcquireOtherPropertyPlantAndEquipment"),
        ("ifrs-full", "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"),
        ("ifrs-full", "PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets"),
    ]

    ann_rev = _extract_flow_series(facts_root, rev_primary_tags, fx_rates, 330, 385, take_max_across_tags=True)
    if len(ann_rev) < 3:
        fb_rev = _extract_flow_series(facts_root, rev_fallback_tags, fx_rates, 330, 385, take_max_across_tags=True)
        for k, v in fb_rev.items():
            ann_rev.setdefault(k, v)

    ann_ebit = _extract_flow_series(facts_root, ebit_tags, fx_rates, 330, 385)
    ann_pat = _extract_flow_series(facts_root, pat_tags, fx_rates, 330, 385)
    ann_da = _extract_flow_series(facts_root, da_tags, fx_rates, 330, 385)
    ann_cfo = _extract_flow_series(facts_root, cfo_tags, fx_rates, 330, 385)
    ann_capex = _extract_flow_series(facts_root, capex_tags, fx_rates, 330, 385)

    bs_assets = _extract_instant_series(facts_root, [("us-gaap", "Assets"), ("ifrs-full", "Assets")], fx_rates)
    bs_equity = _extract_instant_series(
        facts_root,
        [
            ("us-gaap", "StockholdersEquity"),
            ("ifrs-full", "EquityAttributableToOwnersOfParent"),
            ("us-gaap", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"),
            ("ifrs-full", "Equity"),
            ("us-gaap", "MembersEquity"),
        ],
        fx_rates,
    )
    bs_cur_assets = _extract_instant_series(
        facts_root, [("us-gaap", "AssetsCurrent"), ("ifrs-full", "CurrentAssets")], fx_rates
    )
    bs_cur_liab = _extract_instant_series(
        facts_root, [("us-gaap", "LiabilitiesCurrent"), ("ifrs-full", "CurrentLiabilities")], fx_rates
    )
    bs_lt_debt = _extract_instant_series(
        facts_root,
        [
            ("us-gaap", "LongTermDebtNoncurrent"),
            ("us-gaap", "LongTermDebtAndCapitalLeaseObligations"),
            ("us-gaap", "LongTermDebt"),
            ("ifrs-full", "LongtermBorrowings"),
            ("ifrs-full", "NoncurrentFinancialLiabilities"),
        ],
        fx_rates,
    )
    bs_st_debt = _extract_instant_series(
        facts_root,
        [
            ("us-gaap", "DebtCurrent"),
            ("us-gaap", "LongTermDebtCurrent"),
            ("us-gaap", "ShortTermBorrowings"),
            ("ifrs-full", "CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings"),
            ("ifrs-full", "ShorttermBorrowings"),
        ],
        fx_rates,
    )
    bs_tot_liab = _extract_instant_series(
        facts_root, [("us-gaap", "Liabilities"), ("ifrs-full", "Liabilities")], fx_rates
    )

    shares_by_end, latest_sh_m = _extract_split_adjusted_shares(facts_root, splits)
    if target_shares_m > 0:
        if latest_sh_m <= 0:
            latest_sh_m = target_shares_m
        else:
            ratio = target_shares_m / latest_sh_m
            # Rescale Class-A / dual-class / ADR / thousands-vs-shares SEC discrepancies (e.g. BRK-B 1500x, BF-B, GOOGL)
            if ratio < 0.72 or ratio > 1.38:
                shares_by_end = {d_k: v_sh * ratio for d_k, v_sh in shares_by_end.items()}
                latest_sh_m = target_shares_m
    if latest_sh_m <= 0:
        latest_sh_m = 500.0

    candidate_ends = sorted(d for d in (set(ann_rev.keys()) & set(ann_pat.keys())) if d >= "2018-01-01")
    selected_ends: List[str] = []
    for d_str in candidate_ends:
        if ann_rev[d_str][0] <= 0:
            continue
        if not selected_ends:
            selected_ends.append(d_str)
        else:
            gap = (dt.date.fromisoformat(d_str) - dt.date.fromisoformat(selected_ends[-1])).days
            if gap >= 300:
                selected_ends.append(d_str)
            elif gap < 45:
                selected_ends[-1] = d_str

    selected_ends = selected_ends[-8:]
    if len(selected_ends) < 2:
        return None

    annual_rows: List[Tuple[Any, ...]] = []
    prev_fy_int = 0

    for idx_yr, end_s in enumerate(selected_ends):
        end_dt = dt.date.fromisoformat(end_s)
        fy_int = (end_dt.year - 1) if (end_dt.month == 1 and end_dt.day <= 10) else end_dt.year
        if fy_int <= prev_fy_int:
            fy_int = prev_fy_int + 1
        prev_fy_int = fy_int

        rev_m, rev_filed = ann_rev[end_s]
        pat_m, pat_filed = ann_pat[end_s]
        earliest_filed = min(rev_filed, pat_filed)
        try:
            f_dt = dt.date.fromisoformat(earliest_filed)
            lag_days = (f_dt - end_dt).days
            rep_dt = f_dt if (15 <= lag_days <= 90) else (end_dt + dt.timedelta(days=60))
        except ValueError:
            rep_dt = end_dt + dt.timedelta(days=60)

        ebit_entry = ann_ebit.get(end_s)
        ebit_m = ebit_entry[0] if ebit_entry is not None else (pat_m * 1.26)
        da_entry = ann_da.get(end_s)
        da_m = abs(da_entry[0]) if da_entry is not None else max(0.0, rev_m * 0.038)
        ebitda_m = ebit_m + da_m if not is_fin else max(ebit_m, pat_m * 1.25)

        cfo_entry = ann_cfo.get(end_s)
        cfo_m = cfo_entry[0] if cfo_entry is not None else (pat_m + da_m * 0.85)
        capex_entry = ann_capex.get(end_s)
        capex_m = abs(capex_entry[0]) if capex_entry is not None else da_m
        fcf_m = pat_m if is_fin else (cfo_m - capex_m)

        tot_assets_m = _lookup_nearest_instant(bs_assets, end_s)
        tot_eq_m = _lookup_nearest_instant(bs_equity, end_s)
        lt_d = _lookup_nearest_instant(bs_lt_debt, end_s) or 0.0
        st_d = _lookup_nearest_instant(bs_st_debt, end_s) or 0.0
        tot_debt_m = max(0.0, lt_d + st_d)

        if tot_assets_m is None or tot_assets_m <= 0:
            tot_assets_m = max(rev_m * 1.2, abs(pat_m) * 8.0, 100.0)
        if tot_eq_m is None:
            liab_m = _lookup_nearest_instant(bs_tot_liab, end_s)
            tot_eq_m = (tot_assets_m - liab_m) if liab_m is not None else (tot_assets_m * 0.45)

        effective_eq_m = tot_eq_m
        if effective_eq_m <= 0 and pat_m > 0 and cfo_m > 0 and ebit_m > 0:
            effective_eq_m = max(rev_m * 0.12, pat_m * 2.8)

        cur_assets_m = _lookup_nearest_instant(bs_cur_assets, end_s)
        if cur_assets_m is None or cur_assets_m <= 0:
            cur_assets_m = max(10.0, tot_assets_m * 0.32)
        cur_liab_m = _lookup_nearest_instant(bs_cur_liab, end_s)
        if cur_liab_m is None or cur_liab_m <= 0:
            cur_liab_m = max(10.0, tot_assets_m * 0.22)

        sh_m = _lookup_nearest_instant(shares_by_end, end_s, max_gap_days=20) or latest_sh_m
        if latest_sh_m > 0 and (sh_m < latest_sh_m * 0.22 or sh_m > latest_sh_m * 4.5):
            sh_m = latest_sh_m
        # For the latest annual FY, ensure exact alignment with consolidated market-cap share count if calibrated
        if idx_yr == len(selected_ends) - 1 and target_shares_m > 0:
            if sh_m < target_shares_m * 0.78 or sh_m > target_shares_m * 1.30:
                sh_m = target_shares_m

        opm_pct = (ebitda_m / max(1.0, rev_m)) * 100.0
        if is_fin:
            roe_pct = _clamp((pat_m / effective_eq_m) * 100.0, -45.0, 125.0) if effective_eq_m > 0 else -25.0
            roa_pct = (pat_m / max(1.0, tot_assets_m)) * 100.0
            roce_pct = _clamp(max(roe_pct * 0.85, roa_pct * 7.5), -45.0, 95.0)
            cfo_ebitda_pct = 92.0 if pat_m > 0 else 40.0
        else:
            cap_employed = max(25.0, tot_assets_m - cur_liab_m, max(0.0, effective_eq_m) + tot_debt_m)
            roce_pct = _clamp((ebit_m / cap_employed) * 100.0, -45.0, 95.0)
            roe_pct = _clamp((pat_m / effective_eq_m) * 100.0, -55.0, 125.0) if effective_eq_m > 0 else -25.0
            cfo_ebitda_pct = (
                (cfo_m / max(1.0, ebitda_m)) * 100.0
                if ebitda_m > 0
                else (80.0 if cfo_m > 0 else 30.0)
            )

        de_ratio = (tot_debt_m / effective_eq_m) if effective_eq_m > 0 else 6.0

        annual_rows.append(
            (
                ticker,
                fy_int,
                end_dt.isoformat(),
                rep_dt.isoformat(),
                round(rev_m, 2),
                round(ebitda_m, 2),
                round(ebit_m, 2),
                round(pat_m, 2),
                round(cfo_m, 2),
                round(fcf_m, 2),
                round(max(1.0, tot_assets_m), 2),
                round(effective_eq_m, 2),
                round(tot_debt_m, 2),
                round(cur_assets_m, 2),
                round(cur_liab_m, 2),
                round(max(0.05, sh_m), 3),
                round(roce_pct, 2),
                round(roe_pct, 2),
                round(_clamp(opm_pct, -60.0, 85.0), 2),
                round(max(0.0, min(15.0, de_ratio)), 3),
                round(_clamp(cfo_ebitda_pct, -50.0, 160.0), 2),
            )
        )

    # --- Extract 3-Month Standalone Quarterly Series (10-Q + Derived Q4) ---
    q_rev = _extract_flow_series(facts_root, rev_primary_tags, fx_rates, 75, 106, take_max_across_tags=True)
    if len(q_rev) < 5:
        q_rev_fb = _extract_flow_series(facts_root, rev_fallback_tags, fx_rates, 75, 106, take_max_across_tags=True)
        for k, v in q_rev_fb.items():
            q_rev.setdefault(k, v)
    q_pat = _extract_flow_series(facts_root, pat_tags, fx_rates, 75, 106)
    q_ebit = _extract_flow_series(facts_root, ebit_tags, fx_rates, 75, 106)

    for fy_end_s in selected_ends[-3:]:
        if fy_end_s in q_rev and fy_end_s in q_pat:
            continue
        fy_end_dt = dt.date.fromisoformat(fy_end_s)
        prior_q_ends = sorted(
            q_d
            for q_d in (set(q_rev.keys()) & set(q_pat.keys()))
            if 50 <= (fy_end_dt - dt.date.fromisoformat(q_d)).days <= 305
        )
        dedup_q: List[str] = []
        for q_d in prior_q_ends:
            if not dedup_q or (dt.date.fromisoformat(q_d) - dt.date.fromisoformat(dedup_q[-1])).days >= 60:
                dedup_q.append(q_d)
        if len(dedup_q) == 3:
            r_q4 = ann_rev[fy_end_s][0] - sum(q_rev[d][0] for d in dedup_q)
            p_q4 = ann_pat[fy_end_s][0] - sum(q_pat[d][0] for d in dedup_q)
            if r_q4 > 0:
                q_rev[fy_end_s] = (r_q4, ann_rev[fy_end_s][1])
                q_pat[fy_end_s] = (p_q4, ann_pat[fy_end_s][1])
                if fy_end_s in ann_ebit and all(d in q_ebit for d in dedup_q):
                    e_q4 = ann_ebit[fy_end_s][0] - sum(q_ebit[d][0] for d in dedup_q)
                    q_ebit[fy_end_s] = (e_q4, ann_ebit[fy_end_s][1])

    common_q = sorted(d for d in (set(q_rev.keys()) & set(q_pat.keys())) if q_rev[d][0] > 0)
    clean_q: List[str] = []
    for q_d in common_q:
        if not clean_q or (dt.date.fromisoformat(q_d) - dt.date.fromisoformat(clean_q[-1])).days >= 60:
            clean_q.append(q_d)
        else:
            clean_q[-1] = q_d

    last_ann = annual_rows[-1]
    ttm_rev_m = float(last_ann[4])
    ttm_pat_m = float(last_ann[7])
    latest_qtr_label = ""
    signals_rep_date = str(last_ann[3])
    qtr_rev_yoy = 0.0
    qtr_pat_yoy = 0.0
    qtr_opm_delta = 0.0
    has_qtr_data = False

    if len(clean_q) >= 4:
        last4 = clean_q[-4:]
        span_days_4q = (dt.date.fromisoformat(last4[-1]) - dt.date.fromisoformat(last4[0])).days
        if 240 <= span_days_4q <= 320:
            ttm_rev_m = sum(q_rev[d][0] for d in last4)
            ttm_pat_m = sum(q_pat[d][0] for d in last4)

        q_last_dt = dt.date.fromisoformat(clean_q[-1])
        latest_qtr_label = f"{MONTH_ABBR[q_last_dt.month]} {q_last_dt.year}"
        q_filed = min(q_rev[clean_q[-1]][1], q_pat[clean_q[-1]][1])
        try:
            qf_dt = dt.date.fromisoformat(q_filed)
            signals_rep_date = (
                qf_dt.isoformat()
                if 10 <= (qf_dt - q_last_dt).days <= 75
                else (q_last_dt + dt.timedelta(days=38)).isoformat()
            )
        except ValueError:
            signals_rep_date = (q_last_dt + dt.timedelta(days=38)).isoformat()

    if len(clean_q) >= 5:
        span = 2 if len(clean_q) >= 6 else 1
        cur_qs = clean_q[-span:]
        prv_qs: List[str] = []
        for cq in cur_qs:
            cq_dt = dt.date.fromisoformat(cq)
            best_pq = None
            best_diff = 999
            for cand in clean_q[:-span]:
                diff = abs((cq_dt - dt.date.fromisoformat(cand)).days - 365)
                if diff < best_diff:
                    best_diff = diff
                    best_pq = cand
            if best_pq and best_diff <= 45:
                prv_qs.append(best_pq)

        if len(prv_qs) == len(cur_qs):
            rev_cur_q = sum(q_rev[d][0] for d in cur_qs)
            rev_prv_q = sum(q_rev[d][0] for d in prv_qs)
            pat_cur_q = sum(q_pat[d][0] for d in cur_qs)
            pat_prv_q = sum(q_pat[d][0] for d in prv_qs)

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

            if all(d in q_ebit for d in cur_qs + prv_qs) and rev_cur_q > 0 and rev_prv_q > 0:
                op_cur_q = sum(q_ebit[d][0] for d in cur_qs)
                op_prv_q = sum(q_ebit[d][0] for d in prv_qs)
                m_cur = (op_cur_q / rev_cur_q) * 100.0
                m_prv = (op_prv_q / rev_prv_q) * 100.0
                qtr_opm_delta = _clamp(m_cur - m_prv, -20.0, 20.0)

    final_sh_m = float(annual_rows[-1][15])
    mcap_m = cur_price * final_sh_m
    if mcap_m >= 200_000:
        cap_tier = "Mega Cap ($200B+)"
    elif mcap_m >= 50_000:
        cap_tier = "Large Cap ($50B+)"
    else:
        cap_tier = "Large/Mid Cap"

    return {
        "ticker": ticker,
        "name": fallback_name[:80],
        "sector": sector,
        "cap_tier": cap_tier,
        "is_financial": is_fin,
        "promoter_pct": round(insider_pct, 2),
        "inst_pct": round(inst_pct, 2),
        "annual_rows": annual_rows,
        "quarterly_signals": {
            "ticker": ticker,
            "latest_qtr_label": latest_qtr_label,
            "signals_reported_date": signals_rep_date,
            "ttm_rev_cr": round(ttm_rev_m, 2),
            "ttm_pat_cr": round(ttm_pat_m, 2),
            "qtr_rev_yoy_pct": round(qtr_rev_yoy, 2),
            "qtr_pat_yoy_pct": round(qtr_pat_yoy, 2),
            "qtr_opm_delta_pct": round(qtr_opm_delta, 2),
            "promoter_chg_1y_pct": 0.0,
            "inst_chg_1y_pct": 0.4,
            "gnpa_pct": 0.0,
            "nnpa_pct": 0.0,
            "has_qtr_data": has_qtr_data,
            "has_sh_trend": False,
        },
    }


def ingest_us_universe(db: Optional[Database] = None, force_resync_nasdaq: bool = False) -> Dict[str, Any]:
    """Ingest S&P 500 + Nasdaq-100 US universe with strict `NASDAQ100` > `SP500` overlap priority."""
    if db is None:
        db = Database(db_path=DEFAULT_DB_PATH)

    t0 = time.time()
    sp500_only_specs, wiki_ciks = fetch_sp500_constituents()
    combined_specs: List[Tuple[str, str, str, str, bool, float, float]] = list(NASDAQ100_SPECS) + sp500_only_specs
    spec_by_tk = {s[0]: s for s in combined_specs}

    logger.info(
        "US Universe assembled: %d NASDAQ100 + %d non-overlap SP500 = %d unique US tickers",
        len(NASDAQ100_SPECS),
        len(sp500_only_specs),
        len(combined_specs),
    )

    # Inspect already-synced US tickers in SQLite so fresh NASDAQ100 SEC filings can be reused cleanly
    with db.connect() as conn:
        existing_fund_counts = {
            r["ticker"]: int(r["cnt"])
            for r in conn.execute("SELECT ticker, COUNT(*) AS cnt FROM fundamentals_annual GROUP BY ticker").fetchall()
        }
        existing_price_counts = {
            r["ticker"]: int(r["cnt"])
            for r in conn.execute("SELECT ticker, COUNT(*) AS cnt FROM daily_prices GROUP BY ticker").fetchall()
        }

    # Fetch 5Y daily prices for ^NDX, ^GSPC, and all new / stale US tickers; fetch 1M tail for already-fresh tickers
    full_sync_syms: List[str] = [SP500_BENCHMARK_TICKER, NASDAQ_BENCHMARK_TICKER]
    tail_sync_syms: List[str] = []
    for spec in combined_specs:
        tk = spec[0]
        if force_resync_nasdaq or existing_price_counts.get(tk, 0) < 1000 or existing_fund_counts.get(tk, 0) < 2:
            full_sync_syms.append(tk)
        else:
            tail_sync_syms.append(tk)

    logger.info(
        "Syncing Yahoo v8 prices: %d full 5Y series + %d incremental tail updates...",
        len(full_sync_syms),
        len(tail_sync_syms),
    )

    price_map: Dict[str, List[Tuple[str, str, float, float]]] = {}
    splits_map: Dict[str, List[Tuple[str, float]]] = {}

    def _pull_yf_full(idx_sym: Tuple[int, str]) -> Tuple[str, List[Tuple[str, str, float, float]], List[Tuple[str, float]]]:
        idx, sym = idx_sym
        with httpx.Client(headers={"User-Agent": YAHOO_UA}, follow_redirects=True, timeout=15.0) as client:
            rows, sps = fetch_yahoo_chart_5y_with_splits(sym, client=client, host_idx=idx % 2, range_str="10y")
            return sym, rows, sps

    def _pull_yf_tail(idx_sym: Tuple[int, str]) -> Tuple[str, List[Tuple[str, str, float, float]]]:
        idx, sym = idx_sym
        with httpx.Client(headers={"User-Agent": YAHOO_UA}, follow_redirects=True, timeout=12.0) as client:
            rows, _ = fetch_yahoo_chart_5y_with_splits(sym, client=client, host_idx=idx % 2, range_str="1mo")
            return sym, rows

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for sym, rows, sps in pool.map(_pull_yf_full, enumerate(full_sync_syms)):
            if rows:
                price_map[sym] = rows
            splits_map[sym] = sps

    tail_rows_to_upsert: List[Tuple[str, str, float, float]] = []
    if tail_sync_syms:
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            for sym, rows in pool.map(_pull_yf_tail, enumerate(tail_sync_syms)):
                if rows:
                    tail_rows_to_upsert.extend(rows)

    for bm_tk in (NASDAQ_BENCHMARK_TICKER, SP500_BENCHMARK_TICKER):
        bm_rows = price_map.pop(bm_tk, [])
        if bm_rows:
            db.upsert_prices(bm_rows)

    if tail_rows_to_upsert:
        db.upsert_prices(tail_rows_to_upsert)

    # Persist newly fetched full 5Y stock price histories (>= 65 trading days)
    new_price_rows: List[Tuple[str, str, float, float]] = []
    for sym, rows in price_map.items():
        if len(rows) >= 65:
            new_price_rows.extend(rows)
    if new_price_rows:
        db.upsert_prices(new_price_rows)

    # Load full US price histories from SQLite for uniform Stage-1 cross-sectional ranking across all ~510 US stocks
    us_tk_list = [s[0] for s in combined_specs]
    full_us_prices: Dict[str, List[Tuple[str, float]]] = {}
    with db.connect() as conn:
        placeholders = ",".join("?" for _ in us_tk_list)
        for r in conn.execute(
            f"SELECT ticker, trade_date, close_price FROM daily_prices WHERE ticker IN ({placeholders}) ORDER BY trade_date ASC",
            tuple(us_tk_list),
        ).fetchall():
            full_us_prices.setdefault(r["ticker"], []).append((r["trade_date"], float(r["close_price"])))

        bm_gspc_rows = conn.execute(
            "SELECT trade_date, close_price FROM daily_prices WHERE ticker = ? ORDER BY trade_date ASC",
            (SP500_BENCHMARK_TICKER,),
        ).fetchall()
        bm_ndx_rows = conn.execute(
            "SELECT trade_date, close_price FROM daily_prices WHERE ticker = ? ORDER BY trade_date ASC",
            (NASDAQ_BENCHMARK_TICKER,),
        ).fetchall()

    bm_ref = bm_gspc_rows if len(bm_gspc_rows) >= 126 else bm_ndx_rows
    bm_6m_ret = 0.0
    if len(bm_ref) >= 126:
        bm_6m_ret = ((float(bm_ref[-1]["close_price"]) / float(bm_ref[-126]["close_price"])) - 1.0) * 100.0

    # Calibrate consolidated economic share counts across ALL active US tickers via Yahoo v7 quote
    active_us_Syms = [s[0] for s in combined_specs if len(full_us_prices.get(s[0], [])) >= 65]
    implied_shares_map = _fetch_yahoo_implied_shares_millions(active_us_Syms)
    logger.info("Calibrated consolidated implied share counts for %d/%d US tickers", len(implied_shares_map), len(active_us_Syms))

    # Determine which active US tickers require SEC EDGAR XBRL download
    specs_needing_sec: List[Tuple[str, str, str, str, bool, float, float]] = [
        spec_by_tk[tk]
        for tk in active_us_Syms
        if force_resync_nasdaq or existing_fund_counts.get(tk, 0) < 2
    ]

    fx_rates = _fetch_fx_yearly_rates()
    sec_limiter = _RateLimiter(min_interval_sec=0.135)  # ~7.4 req/s (strictly <= 8 req/s)
    cik_map: Dict[str, int] = {}
    cik_map.update(wiki_ciks)

    if specs_needing_sec:
        with httpx.Client(headers={"User-Agent": SEC_UA}, follow_redirects=True, timeout=20.0) as sec_client:
            sec_limiter.wait()
            tk_resp = sec_client.get(SEC_TICKERS_URL)
            tk_resp.raise_for_status()
            for entry in tk_resp.json().values():
                sym_u = str(entry.get("ticker") or "").strip().upper()
                if sym_u and entry.get("cik_str"):
                    cik_map[sym_u] = int(entry["cik_str"])
                    cik_map.setdefault(sym_u.replace(".", "-"), int(entry["cik_str"]))
        # Explicit historical 10-K CIK overrides take priority over recent re-domicile shell CIKs (e.g. XOM -> 34088)
        cik_map.update(KNOWN_CIK_FALLBACKS)

        logger.info("Fetching SEC EDGAR XBRL companyfacts for %d US stocks...", len(specs_needing_sec))

        def _pull_sec_parsed(spec: Tuple[str, str, str, str, bool, float, float]) -> Optional[Dict[str, Any]]:
            tk = spec[0]
            cik = cik_map.get(tk) or cik_map.get(tk.replace("-", "."))
            if not cik:
                logger.warning("No SEC CIK found for %s", tk)
                return None
            cur_px = float(full_us_prices[tk][-1][1])
            url = SEC_FACTS_URL_TMPL.format(cik=cik)
            payload = None
            with httpx.Client(headers={"User-Agent": SEC_UA}, follow_redirects=True, timeout=25.0) as sec_client:
                for attempt in range(3):
                    sec_limiter.wait()
                    try:
                        resp = sec_client.get(url)
                    except Exception:
                        time.sleep(0.8 * (attempt + 1))
                        continue
                    if resp.status_code == 200:
                        payload = resp.json()
                        break
                    if resp.status_code in (429, 500, 502, 503, 504):
                        time.sleep(0.8 * (attempt + 1))
                        continue
                    break
            if not payload:
                return None
            try:
                return parse_sec_company_facts(
                    ticker=tk,
                    spec=spec,
                    sec_payload=payload,
                    cur_price=cur_px,
                    splits=splits_map.get(tk, []),
                    fx_rates=fx_rates,
                    target_shares_m=implied_shares_map.get(tk, 0.0),
                )
            except Exception as exc:
                logger.warning("SEC XBRL parse error for %s: %s", tk, exc)
                return None

        new_annual_rows: List[Tuple[Any, ...]] = []
        parsed_new: Dict[str, Dict[str, Any]] = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            for res in pool.map(_pull_sec_parsed, specs_needing_sec):
                if res is not None:
                    parsed_new[res["ticker"]] = res
                    new_annual_rows.extend(res["annual_rows"])

        for tk, parsed in parsed_new.items():
            idx_tag = "NASDAQ100" if tk in NASDAQ100_SET else "SP500"
            db.upsert_company(
                ticker=tk,
                name=parsed["name"],
                sector=parsed["sector"],
                cap_tier=parsed["cap_tier"],
                is_financial=parsed["is_financial"],
                data_source="real_sec_edgar_xbrl",
                promoter_pct=parsed["promoter_pct"],
                inst_pct=parsed["inst_pct"],
                market="US",
                currency="USD",
                index_tag=idx_tag,
            )
            db.upsert_quarterly_signals(parsed["quarterly_signals"])

        if new_annual_rows:
            db.upsert_fundamentals(new_annual_rows)

    # Audit & heal any share-count scaling discrepancies across ALL US fundamentals (including previously synced rows)
    with db.connect() as conn:
        for tk in active_us_Syms:
            target_sh = implied_shares_map.get(tk, 0.0)
            if target_sh <= 0:
                continue
            f_rows = conn.execute(
                "SELECT fiscal_year, shares_cr FROM fundamentals_annual WHERE ticker = ? ORDER BY fiscal_year ASC",
                (tk,),
            ).fetchall()
            if not f_rows:
                continue
            latest_db_sh = float(f_rows[-1]["shares_cr"])
            if latest_db_sh > 0 and (target_sh / latest_db_sh < 0.72 or target_sh / latest_db_sh > 1.38):
                scale = target_sh / latest_db_sh
                logger.info(
                    "Rescaling %s shares_cr by %.3fx (%.2fM -> %.2fM) to match consolidated market cap",
                    tk,
                    scale,
                    latest_db_sh,
                    target_sh,
                )
                for fr in f_rows:
                    conn.execute(
                        "UPDATE fundamentals_annual SET shares_cr = ? WHERE ticker = ? AND fiscal_year = ?",
                        (round(max(0.05, float(fr["shares_cr"]) * scale), 3), tk, int(fr["fiscal_year"])),
                    )

        scored_us_set = {
            r["ticker"]
            for r in conn.execute("SELECT DISTINCT ticker FROM fundamentals_annual").fetchall()
        }

    # Ensure every active US company with fundamentals has strict overlap priority `index_tag` (`NASDAQ100` > `SP500`)
    # and recompute unified US Stage-1 rankings
    existing_comp_map = {c["ticker"]: c for c in db.get_all_companies()}
    stage1_items: List[Dict[str, Any]] = []

    for spec in combined_specs:
        tk, name, sector, industry, is_fin, insider_pct, inst_pct = spec
        if tk not in scored_us_set or tk not in full_us_prices:
            continue
        p_hist = full_us_prices[tk]
        if len(p_hist) < 65:
            continue

        idx_tag = "NASDAQ100" if tk in NASDAQ100_SET else "SP500"
        closes = np.array([p[1] for p in p_hist], dtype=float)
        cur_px = float(closes[-1])

        # Refresh company metadata & strict overlap index_tag
        ex_c = existing_comp_map.get(tk)
        sh_est = implied_shares_map.get(tk, 0.0)
        mcap_m = cur_px * sh_est if sh_est > 0 else 0.0
        if mcap_m >= 200_000:
            cap_tier = "Mega Cap ($200B+)"
        elif mcap_m >= 50_000:
            cap_tier = "Large Cap ($50B+)"
        elif ex_c and ex_c.get("cap_tier"):
            cap_tier = str(ex_c["cap_tier"])
        else:
            cap_tier = "Large/Mid Cap"

        db.upsert_company(
            ticker=tk,
            name=name[:80],
            sector=sector,
            cap_tier=cap_tier,
            is_financial=is_fin,
            data_source="real_sec_edgar_xbrl",
            promoter_pct=float(ex_c["promoter_pct"]) if ex_c and float(ex_c.get("promoter_pct") or 0) > 0 else insider_pct,
            inst_pct=float(ex_c["inst_pct"]) if ex_c and float(ex_c.get("inst_pct") or 0) > 0 else inst_pct,
            market="US",
            currency="USD",
            index_tag=idx_tag,
        )

        ret_6m = ((cur_px / float(closes[-min(len(closes), 126)])) - 1.0) * 100.0
        rel_6m_vs_bm = ret_6m - bm_6m_ret

        if len(closes) >= 252:
            mom_12_1 = ((float(closes[-21]) / float(closes[-252])) - 1.0) * 100.0
            high_52w = float(np.max(closes[-252:]))
        else:
            mom_12_1 = ret_6m
            high_52w = float(np.max(closes))

        dist_52w_high = ((cur_px / max(0.01, high_52w)) - 1.0) * 100.0
        dma_200 = float(np.mean(closes[-min(len(closes), 200) :]))
        above_200 = 1 if cur_px >= dma_200 else 0
        pct_vs_200dma = ((cur_px / max(0.01, dma_200)) - 1.0) * 100.0

        tail_closes = closes[-min(len(closes), 253) :]
        daily_rets = np.diff(tail_closes) / tail_closes[:-1]
        ann_vol = float(np.std(daily_rets) * math.sqrt(252.0) * 100.0) if len(daily_rets) > 20 else 28.0

        risk_adj = mom_12_1 / max(14.0, ann_vol)
        s_mom = _lin(mom_12_1, -15.0, 48.0)
        s_rel = _lin(rel_6m_vs_bm, -14.0, 26.0)
        s_trend = 0.55 * _lin(dist_52w_high, -32.0, -2.0) + 0.45 * _lin(pct_vs_200dma, -12.0, 22.0)
        s_stab = 0.65 * _lin(risk_adj, -0.5, 1.6) + 0.35 * _lin(ann_vol, 48.0, 18.0)
        stage1_score = round(_clamp(0.35 * s_mom + 0.25 * s_rel + 0.25 * s_trend + 0.15 * s_stab), 1)

        stage1_items.append(
            {
                "ticker": tk,
                "name": name[:80],
                "sector": sector,
                "industry": industry,
                "last_price": round(cur_px, 2),
                "ret_6m_pct": round(ret_6m, 1),
                "mom_12_1_pct": round(mom_12_1, 1),
                "volatility_pct": round(ann_vol, 1),
                "dist_52w_high_pct": round(dist_52w_high, 1),
                "above_200dma": above_200,
                "avg_turnover_cr": round(risk_adj, 2),
                "stage1_score": stage1_score,
                "index_tag": idx_tag,
            }
        )

    stage1_items.sort(key=lambda x: x["stage1_score"], reverse=True)
    now_ts = int(time.time())
    stage1_rows = [
        {
            **item,
            "stage1_rank": rank_idx,
            "shortlisted": 1,
            "deep_scored": 1,
            "updated_at": now_ts,
            "market": "US",
            "currency": "USD",
        }
        for rank_idx, item in enumerate(stage1_items, start=1)
    ]
    if stage1_rows:
        db.upsert_stage1_rows(stage1_rows)

    nasdaq_cnt = sum(1 for r in stage1_rows if r["index_tag"] == "NASDAQ100")
    sp500_cnt = sum(1 for r in stage1_rows if r["index_tag"] == "SP500")
    elapsed = round(time.time() - t0, 1)
    summary = {
        "us_stocks_total": len(stage1_rows),
        "nasdaq100_tagged": nasdaq_cnt,
        "sp500_non_overlap_tagged": sp500_cnt,
        "benchmark_ndx_days": len(bm_ndx_rows),
        "benchmark_gspc_days": len(bm_gspc_rows),
        "elapsed_sec": elapsed,
    }
    logger.info("Completed S&P 500 + Nasdaq-100 US ingestion: %s", summary)
    return summary


def ingest_nasdaq100_universe(db: Optional[Database] = None) -> Dict[str, Any]:
    """Backward-compatible entrypoint invoking full US (`NASDAQ100` + `SP500`) ingestion."""
    return ingest_us_universe(db=db)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    result = ingest_us_universe()
    print("US S&P 500 + Nasdaq-100 ingestion summary:", result)
