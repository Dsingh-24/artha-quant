# ArthaQuant India — Institutional Factor Screener, Point-in-Time Backtester & Wealth Planner

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Dsingh-24/artha-quant)

**ArthaQuant** is a long-term Indian equity (NSE Nifty 200) fundamental investment advisor, multi-factor screener, bias-free historical backtester, and capital deployment planner inspired by institutional frameworks (**Motilal Oswal QGLP**, **Marcellus Coffee-Can**, **Joel Greenblatt Magic Formula**, **AQR Multi-Factor**, and **Piotroski 9-Point F-Score**).

---

## Key Capabilities

1. **Two-Stage Nifty 200 Institutional Funnel (`V1.2`)**
   - **Stage 1 (Bulk Quant Scan):** Scans all **200 NSE Nifty-200** liquid equities in ~4 seconds via batched Yahoo Finance `v7/finance/spark` calls (`12M-1M` Momentum, `6M` Relative Strength, `200-DMA` Trend, Annualized Volatility).
   - **Stage 2 (Deep Audited Fundamentals):** Evaluates **195+ consolidated NSE companies** across 8+ audited fiscal years (`1,672+` annual statements) plus latest quarterly & shareholding filings.
2. **4-Pillar Long-Term Scoring Engine (`QGLP + GARP`)**
   - **8-Year Anti-Cyclicality & Moat Longevity:** Evaluates `5Y Median ROCE/ROE`, `6Y–8Y Cycle Floor Return`, `8Y Margin Stability`, and `5Y Cumulative CFO/EBITDA` cash conversion so commodity peaks never masquerade as compounders.
   - **GARP & Cyclicality-Aware Fair P/E:** Computes a dynamic Fair P/E anchor (`10x–38x`), capping commodity/cyclical Fair P/E at `15.5x–20.0x` and flagging overextended `>56x P/E` (`PEG > 2.1`) names as `Hold — Buy on Dip`.
   - **Latest 2-Quarter (`2Q`) YoY Inflection & TTM Valuation:** Blends multi-year compounding with the latest 2 quarters' YoY Sales, PAT, and OPM expansion/contraction.
   - **4-Quarter Institutional/Promoter Flow & Banking NPA Guardrails:** Tracks 1-year `FII + DII` and Promoter stake changes plus banking `Gross NPA / Net NPA` asset quality.
3. **Capital Deployment & SIP Blueprint (`Deploy ₹5L Today`)**
   - Converts any lump-sum + monthly SIP budget into an actionable **6–8 stock diversified NSE compounder basket** (whole-share quantities, immediate vs. `6–8%` dip-staggered tranches, per-stock `"Why Buy"` thesis, and a **1,000-path stochastic wealth cone**).
4. **Zero-Look-Ahead Point-in-Time Backtester (`5Y NSE History`)**
   - Enforces a **60-day SEBI LODR reporting lag** (`reported_date <= rebalance_date`), **25 bps** Indian delivery brokerage/STT/slippage per turnover, and a **6.8% India 10Y G-Sec** risk-free rate benchmarked against **Nifty 50 (`^NSEI`)**.

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
- `app/factors.py` — V1.2 point-in-time multi-factor & forensic scoring engine
- `app/live_funnel.py` — Two-stage Nifty 200 Yahoo Finance spark + Screener.in consolidated parser
- `app/backtester.py` — Point-in-time NSE historical backtester with SEBI reporting lag & friction
- `app/planner.py` — ₹5L lump-sum + SIP whole-share allocator & 1,000-path wealth simulator
- `static/` — Vanilla ES-module frontend (`index.html`, `styles.css`, `app.js`, `charts.js`, `standalone_engine.js`)
- `scripts/export_snapshot.py` — Exports sanitized public NSE market snapshot JSON
- `scripts/build_netlify.py` — Zero-dependency static build script assembling `dist/` for Netlify
