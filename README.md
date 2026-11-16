# ArthaQuant V2.0 — Multi-Market Institutional Factor Screener, Point-in-Time Backtester & Wealth Planner

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Dsingh-24/artha-quant)

**ArthaQuant V2.0** is a long-term **dual-market (`IN` NSE Nifty 200 + `US` Nasdaq-100)** fundamental investment advisor, multi-factor screener, per-stock **Score Reasoning Deep Dive**, bias-free historical backtester, and capital deployment planner inspired by institutional frameworks (**Motilal Oswal QGLP**, **Marcellus Coffee-Can**, **Joel Greenblatt Magic Formula**, **AQR Multi-Factor**, and **Piotroski 9-Point F-Score**).

---

## Key Capabilities

1. **Dual-Market Institutional Coverage (`293` Deep-Scored Equities: `IN` + `US`)**
   - **India (`IN` — NSE Nifty 200):** Scans **200 NSE Nifty-200** equities via Yahoo Finance spark feeds and evaluates **195 consolidated Indian companies** across 8+ audited fiscal years (`₹ Cr`), quarterly YoY filings, promoter/FII/DII flows, and banking GNPA/NNPA guardrails.
   - **United States (`US` — Nasdaq-100):** Evaluates **98 Nasdaq-100** companies using official audited **SEC EDGAR XBRL** multi-year + quarterly filings (`$M` / `$B`) and 5-year daily prices benchmarked against **Nasdaq-100 (`^NDX`)**.
   - **Global Market Switcher (`India · US · All Markets`):** Filter or blend `IN`, `US`, and `ALL` universes seamlessly across the Screener, Wealth Planner (`₹` / `$`), and Point-in-Time Backtester.
2. **V2.0 UI & Per-Stock Score Reasoning Deep Dive**
   - **Transparent Score Attribution:** Every stock detail drawer breaks down exact pillar weights (`Quality`, `Valuation`, `Growth`, `Momentum`), weighted point contributions, raw composite score, forensic/valuation point deductions, final clamped `0–100` score, and rating-gate rule (`Strong Buy` / `Buy` / `Hold` / `Avoid`).
   - **Interactive Workspace:** Left-rail navigation, KPI command deck, sortable institutional screener with market badges (`Indian Stock` / `US Stock`), and clean custom canvas charts.
3. **4-Pillar Long-Term Scoring Engine (`QGLP + GARP`)**
   - **8-Year Anti-Cyclicality & Moat Longevity:** Evaluates `5Y Median ROCE/ROE`, `6Y–8Y Cycle Floor Return`, `8Y Margin Stability`, and `5Y Cumulative CFO/EBITDA` cash conversion so commodity peaks never masquerade as compounders.
   - **GARP & Cyclicality-Aware Fair P/E:** Computes a dynamic Fair P/E anchor (`10x–38x`), capping commodity/cyclical Fair P/E at `15.5x–20.0x` and flagging overextended `>56x P/E` (`PEG > 2.1`) names as `Hold — Buy on Dip`.
   - **Latest 2-Quarter (`2Q`) YoY Inflection & TTM Valuation:** Blends multi-year compounding with the latest quarters' YoY Revenue, Net Profit, and Operating Margin expansion/contraction.
4. **Multi-Currency Capital Deployment & SIP Blueprint (`₹5L` / `$10k`)**
   - Converts any lump-sum + monthly SIP budget into an actionable **6–8 stock diversified compounder basket** (native currency formatting in `₹` or `$`, whole-share quantities, immediate vs. `6–8%` dip-staggered tranches, per-stock `"Why Buy"` thesis, and a **1,000-path stochastic wealth cone**).
5. **Zero-Look-Ahead Point-in-Time Backtester (`5Y NSE & Nasdaq-100 History`)**
   - Enforces a **60-day reporting lag** (`reported_date <= rebalance_date`), **25 bps** transaction friction per turnover, and market-appropriate risk-free rates (**6.8% India 10Y G-Sec** vs `^NSEI`, **4.3% US 10Y Treasury** vs `^NDX`).

---

## Dual Execution Architecture (Local FastAPI + Netlify Cloud Snapshot)

| Mode | How It Runs | Capabilities |
| :--- | :--- | :--- |
| **Local Advisor Mode** | FastAPI + SQLite (`127.0.0.1:8000`) | Argon2id/PBKDF2 local auth, CSRF-protected APIs, live weekly NSE price sync (`4s`), live Screener.in consolidated statement scraping, custom CSV persistence |
| **Netlify Cloud Mode** | Static CDN (`dist/` + `standalone_engine.js`) | Zero-backend client-side scoring, custom factor sliders, company deep-dive charts, 5Y point-in-time backtesting, and ₹5L planner powered by `static/data/market_snapshot.json` |

---

## Local Quickstart

```bash
# 1. Create virtual environment & install dependencies
python3 -m venv .venv
.venv/bin/pip install -r requirements-local.txt

# 2. Launch ArthaQuant locally (strictly bound to localhost)
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000` in your browser.

### Refreshing the Public Snapshot for Netlify

Whenever you sync fresh weekly prices or quarterly results locally, export a sanitized public snapshot (excludes all `users`, `sessions`, and `saved_plans` tables):

```bash
.venv/bin/python3 scripts/export_snapshot.py
python3 scripts/build_netlify.py
```

### Running Automated Tests

```bash
.venv/bin/pytest -v
```

---

## Project Structure

- `app/main.py` — FastAPI application, CSP/security headers, Argon2/PBKDF2 auth, and REST endpoints
- `app/factors.py` — V2.0 multi-market point-in-time factor, forensic & score-attribution engine
- `app/live_funnel.py` — Two-stage NSE Nifty 200 Yahoo Finance spark + Screener.in consolidated parser
- `app/nasdaq_funnel.py` — Nasdaq-100 Yahoo Finance 5Y daily prices + SEC EDGAR XBRL audited ingestion
- `app/backtester.py` — Point-in-time `IN` / `US` / `ALL` historical backtester with reporting lag & friction
- `app/planner.py` — Multi-currency (`₹` / `$`) lump-sum + SIP allocator & 1,000-path wealth simulator
- `static/` — V2.0 vanilla ES-module frontend (`index.html`, `styles.css`, `app.js`, `charts.js`, `standalone_engine.js`)
- `scripts/export_snapshot.py` — Exports sanitized public `IN + US` market snapshot JSON
- `scripts/build_netlify.py` — Zero-dependency static build script assembling `dist/` for Netlify
