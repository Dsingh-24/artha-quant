# ArthaQuant V4.0 — Global Factor Screener, Multi-Strategy Paper Trading, AI Analyst & Installable PWA

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Dsingh-24/artha-quant)

**ArthaQuant V4.0** is a long-term **global multi-index (`IN` NSE Nifty 200 + `US` Nasdaq-100 & S&P 500)** fundamental investment advisor, **Multi-Strategy Paper Trading & Buy-on-Dip Limit Order Sandbox**, **Everyday-Investor Plain-English Decision Graph**, **On-Demand AI Analyst Memo**, **Sell-Side EPS Revisions & Street Intelligence** engine, zero-look-ahead historical backtester, capital deployment planner, and **Installable PWA** inspired by institutional frameworks (**Motilal Oswal QGLP**, **Marcellus Coffee-Can**, **Joel Greenblatt Magic Formula**, **AQR Multi-Factor**, and **Piotroski 9-Point F-Score**).

---

## Key Capabilities

1. **V4.0 Multi-Strategy Paper Portfolios, Buy-on-Dip Limit Orders & Installable PWA**
   - **Multi-Strategy Virtual Portfolios (`₹10L` / `$100k` / Mixed `₹` + `$`):** Create up to 6 isolated strategy sandboxes (`QGLP Compounder`, `Street Revisions`, `GARP Value`, `Magic Formula`, `Momentum`, `Custom`) with per-user capital ledgers, weighted-average cost basis, FX conversion (`USD/INR`), mark-to-market NAV history vs. benchmarks (`^NSEI`, `^GSPC`, `^NDX`), and PnL attribution by entry ArthaQuant rating (`Strong Buy` / `Buy` / `Hold` / `Avoid`).
   - **Instant Market + Buy-on-Dip Limit Orders & `21:30 UTC` Daily Cron:** Execute instant Market Buy/Sell orders (`0.10%` slippage) or queue GTC **Buy-on-Dip Limit Orders** (`-3%`, `-5%`, `-10%`, Fair-P/E anchor, or custom price) with strict reserved-cash accounting (`available_cash = cash_balance - reserved_cash`). A scheduled Netlify Function (`daily-paper-refresh.mts` at `21:30 UTC` Mon–Fri) refreshes Yahoo Finance batch quotes, auto-fills crossed Buy-on-Dip limit orders at `min(limit_price, live_price)` when `day_low <= limit_price`, and records daily portfolio NAV snapshots.
   - **Invite-Only Cloud Auth & Managed Postgres + Installable PWA:** Cloud paper portfolios are secured via Invite-Only **`@netlify/identity`** JWT verification (`context.clientContext.user.sub` per-user isolation) backed by **`@netlify/database` Managed Postgres + Drizzle ORM** migrations, paired with an **Installable iOS / Android / macOS PWA** (`manifest.webmanifest`, `192`/`512`/maskable + Apple touch icons, and a security-hardened `sw.js` that strictly bypasses `/api/*`, `/.netlify/*`, and `/static/data/*`).
2. **V3.0 Everyday-Investor Plain-English Reasoning & On-Demand AI Analyst**
   - **6-Archetype Plain-English Decision Graph (`702` Scored Stocks):** Classifies every company into one of 6 business models (`Compounder`, `High-Growth Compounder`, `Share-Buyback Compounder`, `Bank / Financial Lender`, `Cyclical / Commodity`, or `Unprofitable / Turnaround`) and translates every pillar, strength, watchout, and valuation metric into clear, zero-jargon language (including accounting for US share-buyback book-equity distortions).
   - **`Simple View` + `Pro Ratios` Toggle & `707` Business Descriptions:** Every stock card opens with a crisp plain-English summary of what the business actually builds and sells, an instant one-line verdict, and a toggle between plain-English `Simple View` and institutional `Pro Ratios` (`ROCE`, `EV/EBITDA`, `Piotroski F-Score`, score attribution math).
   - **On-Demand `✨ Ask AI Analyst` (Netlify AI Gateway + Netlify Blobs):** Generates grounded, strict-JSON investment memos (`verdict_headline`, `what_the_business_does`, `why_it_scored_this_way`, `key_risk_to_watch`, `bottom_line_for_investors`) strictly from audited ArthaQuant metrics via **Netlify AI Gateway** and caches memos per `(ticker, snapshot_date)` in **Netlify Blobs** (and local SQLite in Local Advisor Mode).
3. **Global Three-Index Institutional Coverage (`702` Deep-Scored Equities Across `IN` + `US`)**
   - **India (`IN` — NSE Nifty 200):** Scans **200 NSE Nifty-200** equities via Yahoo Finance spark feeds and evaluates **195 consolidated Indian companies** across 8+ audited fiscal years (`₹ Cr`), quarterly YoY filings, promoter/FII/DII flows, and banking GNPA/NNPA guardrails.
   - **United States (`US` — Nasdaq-100 & S&P 500):** Evaluates **507 US companies** (`98` **Nasdaq-100** + `409` non-overlapping **S&P 500**) using official audited **SEC EDGAR XBRL** multi-year + quarterly filings (`$M` / `$B` / `$T`) and 5-year daily prices benchmarked against **S&P 500 (`^GSPC`)** and **Nasdaq-100 (`^NDX`)**.
   - **Deterministic Overlap Priority (`NASDAQ 100` > `S&P 500` > `NIFTY 200`):** Dual-listed US leaders (`AAPL`, `MSFT`, `NVDA`, `AMZN`, `META`, `GOOGL`, `COST`, `AVGO`, `PEP`) carry the primary `US Stock · NASDAQ 100` badge, while S&P 500 exclusives (`JPM`, `LLY`, `V`, `MA`, `WMT`, `GS`, `BRK-B`, `XOM`) carry `US Stock · S&P 500`.
   - **5-Mode Universe Switcher (`All Global · India · All US · Nasdaq 100 · S&P 500`):** Filter or blend any universe seamlessly across the Screener, Paper Sandbox, Wealth Planner (`₹` / `$`), and Point-in-Time Backtester.
4. **Sell-Side EPS Revisions & Street Intelligence (`street_quant` Preset)**
   - **Consensus & Target Upside:** Integrates active sell-side analyst coverage (`Strong Buy` / `Buy` / `Hold` / `Sell` distribution, consensus `Buy %`, mean/high/low price targets, and implied upside `%`).
   - **30D / 90D EPS Revision Breadth & Forward Growth:** Tracks net analyst upward vs. downward EPS revisions (`eps_revision_momentum`), `FY+1` / `FY+2` forward EPS growth, forward P/E compression, recent investment-bank rating actions, and clean long-only institutional ownership (filtering out 13F options market-maker noise).
   - **Forensic Revision Guardrail & Zero Look-Ahead Isolation:** Applies a `-6.0` point guardrail penalty on widespread sell-side EPS cuts while strictly gating `street_signals` by `as_of_date >= signals_as_of_date` during historical backtests.
5. **Transparent Score Attribution & 4-Pillar Engine (`QGLP + GARP + Street Quant`)**
   - **Per-Stock Score Attribution:** Breaks down exact pillar weights (`Quality`, `Valuation`, `Growth`, `Momentum`), weighted point contributions, raw composite score, forensic/valuation/revision point deductions, final clamped `0–100` score, and rating-gate rule (`Strong Buy` / `Buy` / `Hold` / `Avoid`).
   - **8-Year Anti-Cyclicality & GARP Fair P/E:** Evaluates `5Y Median ROCE/ROE`, `6Y–8Y Cycle Floor Return`, `8Y Margin Stability`, and `5Y Cumulative CFO/EBITDA` cash conversion alongside a dynamic Fair P/E anchor (`10x–38x`), capping commodity/cyclical Fair P/E at `15.5x–20.0x`.
6. **Multi-Currency Capital Deployment (`₹5L` / `$10k`) & Zero-Look-Ahead Backtester**
   - Converts any lump-sum + monthly SIP budget into an actionable **6–8 stock diversified compounder basket** (`₹` or `$`, whole-share quantities, dip-staggered tranches, and a **1,000-path stochastic wealth cone**).
   - Enforces a **60-day reporting lag** (`reported_date <= rebalance_date`), **25 bps** turnover friction, and market-appropriate risk-free rates (**6.8% India 10Y G-Sec** vs `^NSEI`, **4.3% US 10Y Treasury** vs `^GSPC` / `^NDX`).

---

## Dual Execution Architecture (Local FastAPI + Netlify Cloud + Managed Postgres + AI Gateway)

| Mode | How It Runs | Capabilities |
| :--- | :--- | :--- |
| **Local Advisor Mode** | FastAPI + SQLite (`127.0.0.1:8000`) | Argon2id/PBKDF2 local auth, CSRF-protected APIs, multi-strategy SQLite paper trading & Buy-on-Dip engine (`/api/paper/*`), live NSE/US price & SEC EDGAR XBRL sync, SQLite-cached `/api/ai-memo` |
| **Netlify Cloud Mode** | Static CDN (`dist/` + PWA `sw.js`) + Netlify Functions (`paper-api.mts`, `daily-paper-refresh.mts`, `ai-memo.mts`) + `@netlify/database` + `@netlify/identity` | Zero-backend client-side scoring (`0.0` parity diff vs Python), Invite-Only multi-strategy paper trading & `21:30 UTC` auto-fill cron on **Netlify Managed Postgres**, On-Demand `✨ Ask AI Analyst` via **Netlify AI Gateway + Netlify Blobs**, and Installable iOS/Android/Mac PWA |

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

- `app/main.py` — FastAPI application, CSP/security headers, Argon2/PBKDF2 auth, and REST endpoints (`/api/paper/*`, `/api/ai-memo`)
- `app/paper_trading.py` — Local SQLite multi-strategy paper portfolio, Market + Buy-on-Dip limit order, Yahoo quote sync & NAV engine
- `app/factors.py` — Multi-market point-in-time factor, Street revision, buyback-accounting, forensic & score-attribution engine
- `app/plain_english.py` — 6-archetype plain-English reasoning & decision graph engine (`0.0` parity diff with `standalone_engine.js`)
- `app/live_funnel.py` — Two-stage NSE Nifty 200 Yahoo Finance spark + Screener.in consolidated parser
- `app/nasdaq_funnel.py` — US Nasdaq-100 & S&P 500 (`NASDAQ100` > `SP500` priority) 5Y prices + SEC EDGAR XBRL ingestion
- `app/street_signals.py` — Sell-side analyst consensus, target price, 30D/90D EPS revision, institutional holder & 707-stock business profile sync
- `app/backtester.py` — Point-in-time `ALL` / `IN` / `US` / `NASDAQ100` / `SP500` historical backtester
- `app/planner.py` — Multi-currency (`₹` / `$`) lump-sum + SIP allocator & 1,000-path wealth simulator
- `netlify/functions/paper-api.mts` — Invite-Only `@netlify/identity` + `@netlify/database` multi-strategy cloud paper trading API
- `netlify/functions/daily-paper-refresh.mts` — Scheduled (`21:30 UTC` Mon–Fri) Yahoo batch quote sync, Buy-on-Dip auto-fill & NAV snapshot function
- `netlify/lib/paper-pg-service.mts` — Shared `@netlify/database` Managed Postgres service, Yahoo batch quote sync & Buy-on-Dip engine
- `netlify/database/migrations/` — Automated Netlify Postgres SQL migrations (`paper_portfolios`, `paper_positions`, `paper_orders`, `paper_trades`, `paper_live_quotes`, `paper_nav_history`)
- `netlify/functions/ai-memo.mts` — Netlify AI Gateway + Netlify Blobs serverless AI analyst memo endpoint
- `static/` — V4.0 vanilla ES-module frontend & PWA (`index.html`, `styles.css`, `app.js`, `paper_ui.js`, `auth_client.js`, `charts.js`, `standalone_engine.js`, `sw.js`, `manifest.webmanifest`, `icons/`)
- `scripts/export_snapshot.py` — Exports sanitized public `707`-company (`702` deep-scored) market snapshot JSON
- `scripts/build_netlify.sh` — Builds `dist/` (including PWA assets & vendor bundle) and server-only `stock_ai_context.json` for Netlify
