# ArthaQuant V2.5 — Global Institutional Factor Screener, Street Intelligence, Backtester & Wealth Planner

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Dsingh-24/artha-quant)

**ArthaQuant V2.5** is a long-term **global multi-index (`IN` NSE Nifty 200 + `US` Nasdaq-100 & S&P 500)** fundamental investment advisor, multi-factor screener, **Sell-Side EPS Revisions & Street Intelligence** engine, per-stock **Score Reasoning Deep Dive**, zero-look-ahead historical backtester, and capital deployment planner inspired by institutional frameworks (**Motilal Oswal QGLP**, **Marcellus Coffee-Can**, **Joel Greenblatt Magic Formula**, **AQR Multi-Factor**, and **Piotroski 9-Point F-Score**).

---

## Key Capabilities

1. **Global Three-Index Institutional Coverage (`702` Deep-Scored Equities Across `IN` + `US`)**
   - **India (`IN` — NSE Nifty 200):** Scans **200 NSE Nifty-200** equities via Yahoo Finance spark feeds and evaluates **195 consolidated Indian companies** across 8+ audited fiscal years (`₹ Cr`), quarterly YoY filings, promoter/FII/DII flows, and banking GNPA/NNPA guardrails.
   - **United States (`US` — Nasdaq-100 & S&P 500):** Evaluates **507 US companies** (`98` **Nasdaq-100** + `409` non-overlapping **S&P 500**) using official audited **SEC EDGAR XBRL** multi-year + quarterly filings (`$M` / `$B` / `$T`) and 5-year daily prices benchmarked against **S&P 500 (`^GSPC`)** and **Nasdaq-100 (`^NDX`)**.
   - **Deterministic Overlap Priority (`NASDAQ 100` > `S&P 500` > `NIFTY 200`):** Dual-listed US leaders (`AAPL`, `MSFT`, `NVDA`, `AMZN`, `META`, `GOOGL`, `COST`, `AVGO`, `PEP`) carry the primary `US Stock · NASDAQ 100` badge, while S&P 500 exclusives (`JPM`, `LLY`, `V`, `MA`, `WMT`, `GS`, `BRK-B`, `XOM`) carry `US Stock · S&P 500`.
   - **5-Mode Universe Switcher (`All Global · India · All US · Nasdaq 100 · S&P 500`):** Filter or blend any universe seamlessly across the Screener, Wealth Planner (`₹` / `$`), and Point-in-Time Backtester.
2. **Sell-Side EPS Revisions & Street Intelligence (`street_quant` Preset)**
   - **Consensus & Target Upside:** Integrates active sell-side analyst coverage (`Strong Buy` / `Buy` / `Hold` / `Sell` distribution, consensus `Buy %`, mean/high/low price targets, and implied upside `%`).
   - **30D / 90D EPS Revision Breadth & Forward Growth:** Tracks net analyst upward vs. downward EPS revisions (`eps_revision_momentum`), `FY+1` / `FY+2` forward EPS growth, forward P/E compression, recent investment-bank rating actions, and clean long-only institutional ownership (filtering out 13F options market-maker noise).
   - **Forensic Revision Guardrail & Zero Look-Ahead Isolation:** Applies a `-6.0` point guardrail penalty on widespread sell-side EPS cuts while strictly gating `street_signals` by `as_of_date >= signals_as_of_date` during historical backtests.
3. **V2.5 UI & Per-Stock Score Reasoning Deep Dive**
   - **Transparent Score Attribution:** Every stock detail drawer breaks down exact pillar weights (`Quality`, `Valuation`, `Growth`, `Momentum`), weighted point contributions, raw composite score, forensic/valuation/revision point deductions, final clamped `0–100` score, and rating-gate rule (`Strong Buy` / `Buy` / `Hold` / `Avoid`).
   - **Interactive Workspace:** Left-rail navigation, triple-benchmark KPI command deck (`^NSEI`, `^GSPC`, `^NDX`), sortable institutional screener with index badges, Street Consensus & EPS Revisions panel, and custom canvas charts.
4. **4-Pillar Long-Term Scoring Engine (`QGLP + GARP + Street Quant`)**
   - **8-Year Anti-Cyclicality & Moat Longevity:** Evaluates `5Y Median ROCE/ROE`, `6Y–8Y Cycle Floor Return`, `8Y Margin Stability`, and `5Y Cumulative CFO/EBITDA` cash conversion so commodity peaks never masquerade as compounders.
   - **GARP & Cyclicality-Aware Fair P/E:** Computes a dynamic Fair P/E anchor (`10x–38x`), capping commodity/cyclical Fair P/E at `15.5x–20.0x` and flagging overextended `>56x P/E` (`PEG > 2.1`) names as `Hold — Buy on Dip`.
5. **Multi-Currency Capital Deployment (`₹5L` / `$10k`) & Zero-Look-Ahead Backtester**
   - Converts any lump-sum + monthly SIP budget into an actionable **6–8 stock diversified compounder basket** (`₹` or `$`, whole-share quantities, dip-staggered tranches, and a **1,000-path stochastic wealth cone**).
   - Enforces a **60-day reporting lag** (`reported_date <= rebalance_date`), **25 bps** turnover friction, and market-appropriate risk-free rates (**6.8% India 10Y G-Sec** vs `^NSEI`, **4.3% US 10Y Treasury** vs `^GSPC` / `^NDX`).

---

## Dual Execution Architecture (Local FastAPI + Netlify Cloud Snapshot)

| Mode | How It Runs | Capabilities |
| :--- | :--- | :--- |
| **Local Advisor Mode** | FastAPI + SQLite (`127.0.0.1:8000`) | Argon2id/PBKDF2 local auth, CSRF-protected APIs, live NSE/US price & SEC EDGAR XBRL sync, sell-side Street signal refresh, custom CSV persistence |
| **Netlify Cloud Mode** | Static CDN (`dist/` + `standalone_engine.js`) | Zero-backend client-side scoring (`0.0` parity diff vs Python), custom factor sliders, Street Intelligence drawer, 5Y point-in-time backtesting, and `₹5L` / `$10k` planner powered by `static/data/market_snapshot.json` |

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

Whenever you sync fresh weekly prices, quarterly filings, or Street signals locally, export a sanitized public snapshot (excludes all `users`, `sessions`, and `saved_plans` tables):

```bash
.venv/bin/python3 scripts/export_snapshot.py
sh scripts/build_netlify.sh
```

### Running Automated Tests

```bash
.venv/bin/pytest -v
```

---

## Project Structure

- `app/main.py` — FastAPI application, CSP/security headers, Argon2/PBKDF2 auth, and REST endpoints
- `app/factors.py` — V2.5 multi-market point-in-time factor, Street revision, forensic & score-attribution engine
- `app/live_funnel.py` — Two-stage NSE Nifty 200 Yahoo Finance spark + Screener.in consolidated parser
- `app/nasdaq_funnel.py` — US Nasdaq-100 & S&P 500 (`NASDAQ100` > `SP500` priority) 5Y prices + SEC EDGAR XBRL ingestion
- `app/street_signals.py` — Sell-side analyst consensus, target price, 30D/90D EPS revision & institutional holder sync
- `app/backtester.py` — Point-in-time `ALL` / `IN` / `US` / `NASDAQ100` / `SP500` historical backtester
- `app/planner.py` — Multi-currency (`₹` / `$`) lump-sum + SIP allocator & 1,000-path wealth simulator
- `static/` — V2.5 vanilla ES-module frontend (`index.html`, `styles.css`, `app.js`, `charts.js`, `standalone_engine.js`)
- `scripts/export_snapshot.py` — Exports sanitized public `707`-company (`702` deep-scored) market snapshot JSON
- `scripts/build_netlify.py` — Zero-dependency static build script assembling `dist/` for Netlify
