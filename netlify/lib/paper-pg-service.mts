import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDatabase,
  MissingDatabaseConnectionError,
  type DatabaseConnection,
} from "@netlify/database";

export const USD_INR_FX = 84.5;
export const BENCHMARK_SYMBOLS = ["^NSEI", "^GSPC", "^NDX"] as const;
const ATTRIBUTION_RATINGS = ["Strong Buy", "Buy", "Hold"] as const;
const ALLOWED_PRESETS = new Set<string>([
  "qglp_compounder",
  "street_quant",
  "artha_blend",
  "coffee_can",
  "magic_formula",
  "value_momentum",
]);
const ALLOWED_CURRENCIES = new Set<string>(["INR", "USD"]);
const ALLOWED_BENCHMARKS = new Set<string>(["^NSEI", "^GSPC", "^NDX"]);
const TICKER_FORMAT_RE = /^[A-Z0-9.^&-]{1,20}$/;

export interface VerifiedPaperUser {
  id: string;
  email?: string;
}

export interface PresetScoreEntry {
  score: number;
  rating: string;
}

export interface StockUniverseEntry {
  name: string;
  sector: string;
  industry: string;
  market: string;
  index_tag: string;
  currency: string;
  is_financial?: boolean;
  last_price: number | null;
  composite_score?: number;
  rating?: string;
  preset_scores?: Record<string, PresetScoreEntry>;
}

export interface StockUniverseContext {
  as_of_date: string;
  stock_count: number;
  benchmarks?: Record<string, number>;
  stocks: Record<string, StockUniverseEntry>;
}

export interface LiveQuoteRow {
  ticker: string;
  close_price: number;
  day_low: number;
  day_high: number;
  trade_date: string;
  updated_at?: string;
}

interface PortfolioRow {
  id: string;
  user_id: string;
  name: string;
  currency: string;
  strategy_preset: string;
  benchmark_ticker: string;
  cash_balance: number;
  reserved_cash: number;
  total_deposited: number;
  fee_bps: number;
  created_at: string;
  updated_at: string;
}

interface PositionRow {
  portfolio_id: string;
  ticker: string;
  shares: number;
  avg_cost: number;
  native_currency: string;
  entry_score: number;
  entry_rating: string;
  updated_at: string;
}

interface OrderRow {
  id: string;
  portfolio_id: string;
  user_id: string;
  ticker: string;
  side: string;
  order_type: string;
  shares: number;
  limit_price: number | null;
  reserved_amount: number;
  status: string;
  score_at_order: number | null;
  rating_at_order: string | null;
  note: string;
  created_at: string;
  filled_at: string | null;
  filled_price: number | null;
}

interface TradeWithOrderTypeRow {
  id: string;
  portfolio_id: string;
  order_id: string | null;
  ticker: string;
  side: string;
  shares: number;
  exec_price_native: number;
  fx_rate: number;
  gross_amount: number;
  fee_amount: number;
  net_amount: number;
  realized_pnl: number;
  score_at_trade: number | null;
  rating_at_trade: string | null;
  executed_at: string;
  order_type: string;
}

interface NavHistoryRow {
  portfolio_id?: string;
  snap_date: string;
  cash_balance: number;
  holdings_value: number;
  total_nav: number;
  total_deposited: number;
  return_pct: number;
  benchmark_close: number;
  benchmark_return_pct: number;
}

interface QueryResultLike<T = Record<string, unknown>> {
  rows: T[];
}

interface PoolClientLike {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResultLike<T>>;
  release(): void;
}

export class PaperServiceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PaperServiceError";
    this.status = status;
  }
}

let cachedUniverse: StockUniverseContext | null = null;

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function utcTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function roundTo(val: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(val * factor) / factor;
}

function makeShortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
}

export function resolveDbConnection(): DatabaseConnection {
  try {
    return getDatabase();
  } catch (err) {
    if (err instanceof MissingDatabaseConnectionError) {
      throw new PaperServiceError(
        "Netlify Managed Postgres is not provisioned yet on this deploy. Deploy with @netlify/database installed so migrations under netlify/database/migrations/ auto-provision the database.",
        503,
      );
    }
    const msg = err instanceof Error ? err.message : "";
    if (
      msg.includes("Environment not configured") ||
      msg.includes("connection") ||
      msg.includes("NETLIFY_DB_URL") ||
      msg.includes("database")
    ) {
      throw new PaperServiceError(
        "Paper trading database is temporarily unavailable or not yet provisioned for this deploy.",
        503,
      );
    }
    throw new PaperServiceError("Unable to initialize database connection.", 503);
  }
}

async function connectPoolClient(db: DatabaseConnection): Promise<PoolClientLike> {
  try {
    const client = await (db.pool as unknown as { connect(): Promise<PoolClientLike> }).connect();
    return client;
  } catch {
    throw new PaperServiceError(
      "Unable to open a transaction against Netlify Managed Postgres. Ensure database migrations have been applied on deploy.",
      503,
    );
  }
}

function resolveMarketLabel(indexTag: string, market: string): string {
  if (indexTag === "NASDAQ100") return "US Stock · NASDAQ 100";
  if (indexTag === "SP500") return "US Stock · S&P 500";
  if (market === "US") return "US Stock · S&P 500";
  return "Indian Stock · NIFTY 200";
}

export function computeFxRate(nativeCurrency: string, portfolioCurrency: string): number {
  const src = (nativeCurrency || "INR").toUpperCase();
  const dst = (portfolioCurrency || "INR").toUpperCase();
  if (src === dst) return 1.0;
  if (src === "USD" && dst === "INR") return USD_INR_FX;
  if (src === "INR" && dst === "USD") return 1.0 / USD_INR_FX;
  return 1.0;
}

export function computeBuyCost(
  shares: number,
  priceNative: number,
  fxRate: number,
  feeBps: number,
): { gross: number; fee: number; netDebit: number } {
  const gross = roundTo(shares * priceNative * fxRate, 2);
  const fee = roundTo(gross * (feeBps / 10_000), 2);
  const netDebit = roundTo(gross + fee, 2);
  return { gross, fee, netDebit };
}

export function computeSellProceeds(
  shares: number,
  priceNative: number,
  fxRate: number,
  feeBps: number,
): { gross: number; fee: number; netCredit: number } {
  const gross = roundTo(shares * priceNative * fxRate, 2);
  const fee = roundTo(gross * (feeBps / 10_000), 2);
  const netCredit = Math.max(0, roundTo(gross - fee, 2));
  return { gross, fee, netCredit };
}

export async function loadStockUniverse(reqUrl?: string): Promise<StockUniverseContext> {
  if (cachedUniverse && cachedUniverse.stock_count > 0) {
    return cachedUniverse;
  }

  const candidatePaths: string[] = [
    path.resolve(process.cwd(), "netlify/functions/data/stock_ai_context.json"),
  ];
  try {
    candidatePaths.push(
      fileURLToPath(new URL("../functions/data/stock_ai_context.json", import.meta.url)),
    );
  } catch {
    // Ignore bundler URL differences
  }
  try {
    candidatePaths.push(fileURLToPath(new URL("./data/stock_ai_context.json", import.meta.url)));
  } catch {
    // Ignore bundler URL differences
  }

  for (const filePath of candidatePaths) {
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as StockUniverseContext;
      if (parsed && parsed.stocks && Object.keys(parsed.stocks).length > 0) {
        cachedUniverse = parsed;
        return parsed;
      }
    } catch {
      // Try next path
    }
  }

  if (reqUrl) {
    const snapUrl = new URL("/static/data/market_snapshot.json", reqUrl);
    const res = await fetch(snapUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const snap = (await res.json()) as Record<string, unknown>;
      const asOf = typeof snap.as_of_date === "string" ? snap.as_of_date : utcTodayStr();
      const pricesMap = (snap.prices ?? {}) as Record<string, Array<number | null>>;
      const s1Map: Record<string, Record<string, unknown>> = {};
      if (Array.isArray(snap.stage1_funnel)) {
        for (const r of snap.stage1_funnel) {
          if (r && typeof r === "object" && typeof (r as Record<string, unknown>).ticker === "string") {
            s1Map[(r as Record<string, unknown>).ticker as string] = r as Record<string, unknown>;
          }
        }
      }
      const latestPx = (sym: string): number | null => {
        const arr = pricesMap[sym];
        if (!Array.isArray(arr)) return null;
        for (let i = arr.length - 1; i >= 0; i -= 1) {
          if (typeof arr[i] === "number" && Number.isFinite(arr[i]!)) {
            return roundTo(arr[i]!, 2);
          }
        }
        return null;
      };
      const benchmarks: Record<string, number> = {};
      for (const bm of BENCHMARK_SYMBOLS) {
        const px = latestPx(bm);
        if (px && px > 0) benchmarks[bm] = px;
      }
      const stocks: Record<string, StockUniverseEntry> = {};
      for (const rawComp of Array.isArray(snap.companies) ? snap.companies : []) {
        if (!rawComp || typeof rawComp !== "object") continue;
        const c = rawComp as Record<string, unknown>;
        const tk = typeof c.ticker === "string" ? c.ticker : "";
        if (!tk) continue;
        const s1 = s1Map[tk] ?? {};
        const rawTag = String(c.index_tag ?? s1.index_tag ?? "").toUpperCase();
        const isUs = c.market === "US" || rawTag === "NASDAQ100" || rawTag === "SP500";
        const s1Score = typeof s1.stage1_score === "number" ? roundTo(s1.stage1_score, 1) : 55.0;
        stocks[tk] = {
          name: typeof c.name === "string" ? c.name : tk,
          sector: typeof c.sector === "string" ? c.sector : "Diversified",
          industry: typeof c.industry === "string" ? c.industry : "",
          market: isUs ? "US" : "IN",
          index_tag: isUs ? (rawTag === "SP500" ? "SP500" : "NASDAQ100") : "NIFTY200",
          currency: isUs ? "USD" : "INR",
          last_price: typeof s1.last_price === "number" ? roundTo(s1.last_price, 2) : latestPx(tk),
          composite_score: s1Score,
          rating: s1Score >= 68 ? "Buy" : s1Score >= 48 ? "Hold" : "Avoid",
        };
      }
      cachedUniverse = {
        as_of_date: asOf,
        stock_count: Object.keys(stocks).length,
        benchmarks,
        stocks,
      };
      return cachedUniverse;
    }
  }

  throw new PaperServiceError("Stock universe context could not be loaded on the server.", 500);
}

function resolveTradableCompany(
  universe: StockUniverseContext,
  rawTicker: unknown,
): { ticker: string; entry: StockUniverseEntry; marketLabel: string } {
  const cleaned = typeof rawTicker === "string" ? rawTicker.trim().toUpperCase() : "";
  if (!cleaned || !TICKER_FORMAT_RE.test(cleaned)) {
    throw new PaperServiceError("Invalid or disallowed ticker symbol.", 400);
  }

  let resolved = cleaned;
  let entry: StockUniverseEntry | undefined = Object.prototype.hasOwnProperty.call(
    universe.stocks,
    cleaned,
  )
    ? universe.stocks[cleaned]
    : undefined;

  if (!entry && !cleaned.endsWith(".NS") && !cleaned.endsWith(".BO")) {
    const candidateNs = `${cleaned}.NS`;
    if (
      TICKER_FORMAT_RE.test(candidateNs) &&
      Object.prototype.hasOwnProperty.call(universe.stocks, candidateNs)
    ) {
      resolved = candidateNs;
      entry = universe.stocks[candidateNs];
    }
  }

  if (!entry) {
    throw new PaperServiceError(
      `Ticker '${cleaned}' is not in the ArthaQuant 707-stock universe allowlist.`,
      400,
    );
  }

  return {
    ticker: resolved,
    entry,
    marketLabel: resolveMarketLabel(entry.index_tag, entry.market),
  };
}

function getScoreAndRating(
  universe: StockUniverseContext,
  ticker: string,
  preset: string,
): { score: number; rating: string } {
  const entry = universe.stocks[ticker];
  if (!entry) return { score: 50.0, rating: "Hold" };
  const effPreset = ALLOWED_PRESETS.has(preset) ? preset : "qglp_compounder";
  const presetHit = entry.preset_scores?.[effPreset];
  if (presetHit && Number.isFinite(presetHit.score) && presetHit.rating) {
    return { score: roundTo(presetHit.score, 1), rating: presetHit.rating };
  }
  const score = Number.isFinite(entry.composite_score) ? roundTo(entry.composite_score!, 1) : 50.0;
  const rating = entry.rating || (score >= 68 ? "Buy" : score >= 48 ? "Hold" : "Avoid");
  return { score, rating };
}

function getBaselinePrice(
  universe: StockUniverseContext,
  ticker: string,
): { close_price: number; trade_date: string } {
  const asOf = universe.as_of_date || utcTodayStr();
  if (universe.benchmarks && typeof universe.benchmarks[ticker] === "number" && universe.benchmarks[ticker] > 0) {
    return { close_price: roundTo(universe.benchmarks[ticker], 2), trade_date: asOf };
  }
  const stock = universe.stocks[ticker];
  if (stock && typeof stock.last_price === "number" && stock.last_price > 0) {
    return { close_price: roundTo(stock.last_price, 2), trade_date: asOf };
  }
  // Fallback defaults for indices if missing from JSON
  if (ticker === "^NSEI") return { close_price: 25387.4, trade_date: asOf };
  if (ticker === "^GSPC") return { close_price: 7416.59, trade_date: asOf };
  if (ticker === "^NDX") return { close_price: 27197.15, trade_date: asOf };
  return { close_price: 0, trade_date: asOf };
}

function getQuoteSnapshot(
  universe: StockUniverseContext,
  ticker: string,
  liveQuotes: Map<string, LiveQuoteRow>,
): LiveQuoteRow {
  const live = liveQuotes.get(ticker);
  if (live && Number(live.close_price) > 0) {
    const closePx = roundTo(Number(live.close_price), 2);
    const lowPx = roundTo(Number(live.day_low || closePx), 2);
    const highPx = roundTo(Number(live.day_high || closePx), 2);
    return {
      ticker,
      close_price: closePx,
      day_low: lowPx,
      day_high: highPx,
      trade_date: String(live.trade_date || universe.as_of_date || utcTodayStr()),
    };
  }
  const base = getBaselinePrice(universe, ticker);
  return {
    ticker,
    close_price: base.close_price,
    day_low: base.close_price,
    day_high: base.close_price,
    trade_date: base.trade_date,
  };
}

function defaultSnapDate(universe: StockUniverseContext, liveQuotes: Map<string, LiveQuoteRow>): string {
  let latest = "";
  for (const q of liveQuotes.values()) {
    if (q.trade_date && q.trade_date > latest) {
      latest = q.trade_date;
    }
  }
  return latest || universe.as_of_date || utcTodayStr();
}

async function fetchLiveQuotesMap(db: DatabaseConnection): Promise<Map<string, LiveQuoteRow>> {
  try {
    const rows = await db.sql<LiveQuoteRow>`
      SELECT ticker, close_price, day_low, day_high, trade_date, updated_at
      FROM paper_live_quotes
    `;
    const map = new Map<string, LiveQuoteRow>();
    for (const r of rows) {
      map.set(String(r.ticker), {
        ticker: String(r.ticker),
        close_price: Number(r.close_price),
        day_low: Number(r.day_low),
        day_high: Number(r.day_high),
        trade_date: String(r.trade_date),
        updated_at: r.updated_at ? String(r.updated_at) : undefined,
      });
    }
    return map;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const causeMsg =
      err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    const combined = `${msg} ${causeMsg}`.toLowerCase();
    if (
      combined.includes("does not exist") ||
      combined.includes("relation") ||
      combined.includes("econnrefused") ||
      combined.includes("enotfound") ||
      combined.includes("etimedout")
    ) {
      throw new PaperServiceError(
        "Paper trading database schema or connection is not yet ready on this deploy branch. Deploy via Netlify to apply netlify/database/migrations/.",
        503,
      );
    }
    throw err;
  }
}

async function recordNavSnapshotInTx(
  client: PoolClientLike,
  universe: StockUniverseContext,
  portfolio: PortfolioRow,
  liveQuotes: Map<string, LiveQuoteRow>,
  snapDateOverride?: string,
): Promise<NavHistoryRow> {
  const pfId = String(portfolio.id);
  const pfCcy = String(portfolio.currency);
  const bmTk = String(portfolio.benchmark_ticker || (pfCcy === "INR" ? "^NSEI" : "^GSPC"));

  const posRes = await client.query<{ ticker: string; shares: number; native_currency: string }>(
    "SELECT ticker, shares, native_currency FROM paper_positions WHERE portfolio_id = $1 AND shares > 0",
    [pfId],
  );

  let holdingsVal = 0;
  for (const p of posRes.rows) {
    const q = getQuoteSnapshot(universe, String(p.ticker), liveQuotes);
    const fx = computeFxRate(String(p.native_currency), pfCcy);
    holdingsVal += roundTo(Number(p.shares) * q.close_price * fx, 2);
  }
  holdingsVal = roundTo(holdingsVal, 2);

  const cashBal = roundTo(Number(portfolio.cash_balance), 2);
  const totDep = roundTo(Number(portfolio.total_deposited), 2);
  const totNav = roundTo(cashBal + holdingsVal, 2);
  const retPct = totDep > 0 ? roundTo(((totNav - totDep) / totDep) * 100, 2) : 0;

  const bmQuote = getQuoteSnapshot(universe, bmTk, liveQuotes);
  const bmClose = roundTo(bmQuote.close_price, 2);
  const snapDate = snapDateOverride || defaultSnapDate(universe, liveQuotes);

  const firstNavRes = await client.query<{ snap_date: string; benchmark_close: number }>(
    `SELECT snap_date, benchmark_close
     FROM paper_nav_history
     WHERE portfolio_id = $1
     ORDER BY snap_date ASC
     LIMIT 1`,
    [pfId],
  );

  let bmRetPct = 0;
  const firstNav = firstNavRes.rows[0];
  if (firstNav && String(firstNav.snap_date) < snapDate && Number(firstNav.benchmark_close) > 0 && bmClose > 0) {
    const baseBm = Number(firstNav.benchmark_close);
    bmRetPct = roundTo(((bmClose - baseBm) / baseBm) * 100, 2);
  } else if (firstNav && String(firstNav.snap_date) === snapDate && bmClose > 0) {
    const baseDbBm = getBaselinePrice(universe, bmTk).close_price;
    if (baseDbBm > 0 && Math.abs(bmClose - baseDbBm) > 1e-6) {
      bmRetPct = roundTo(((bmClose - baseDbBm) / baseDbBm) * 100, 2);
    }
  }

  await client.query(
    `INSERT INTO paper_nav_history (
       portfolio_id, snap_date, cash_balance, holdings_value, total_nav,
       total_deposited, return_pct, benchmark_close, benchmark_return_pct
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (portfolio_id, snap_date) DO UPDATE SET
       cash_balance = EXCLUDED.cash_balance,
       holdings_value = EXCLUDED.holdings_value,
       total_nav = EXCLUDED.total_nav,
       total_deposited = EXCLUDED.total_deposited,
       return_pct = EXCLUDED.return_pct,
       benchmark_close = EXCLUDED.benchmark_close,
       benchmark_return_pct = EXCLUDED.benchmark_return_pct`,
    [pfId, snapDate, cashBal, holdingsVal, totNav, totDep, retPct, bmClose, bmRetPct],
  );

  return {
    snap_date: snapDate,
    cash_balance: cashBal,
    holdings_value: holdingsVal,
    total_nav: totNav,
    total_deposited: totDep,
    return_pct: retPct,
    benchmark_close: bmClose,
    benchmark_return_pct: bmRetPct,
  };
}

async function executeBuyFillInTx(params: {
  client: PoolClientLike;
  portfolio: PortfolioRow;
  userId: string;
  ticker: string;
  nativeCurrency: string;
  shares: number;
  execPriceNative: number;
  orderType: "MARKET" | "LIMIT";
  limitPrice: number | null;
  scoreVal: number;
  ratingVal: string;
  note: string;
  nowIso: string;
  existingOrderId?: string;
  releasedReservation?: number;
}): Promise<{
  portfolio: PortfolioRow;
  order: Record<string, unknown>;
  trade: Record<string, unknown>;
}> {
  const {
    client,
    portfolio,
    userId,
    ticker,
    nativeCurrency,
    shares,
    execPriceNative,
    orderType,
    limitPrice,
    scoreVal,
    ratingVal,
    note,
    nowIso,
    existingOrderId,
    releasedReservation = 0,
  } = params;

  const pfId = String(portfolio.id);
  const pfCcy = String(portfolio.currency);
  const feeBps = Number(portfolio.fee_bps);
  const fx = computeFxRate(nativeCurrency, pfCcy);
  const { gross, fee, netDebit } = computeBuyCost(shares, execPriceNative, fx, feeBps);

  const curCash = roundTo(Number(portfolio.cash_balance), 2);
  const curRes = Math.max(0, roundTo(Number(portfolio.reserved_cash) - releasedReservation, 2));
  const availCash = roundTo(curCash - curRes, 2);

  if (availCash + 1e-9 < netDebit) {
    throw new PaperServiceError(
      `Insufficient available cash for ${ticker}: required ${netDebit.toFixed(2)} ${pfCcy}, available ${availCash.toFixed(2)} ${pfCcy}.`,
      400,
    );
  }

  const newCash = Math.max(0, roundTo(curCash - netDebit, 2));
  await client.query(
    "UPDATE paper_portfolios SET cash_balance = $1, reserved_cash = $2, updated_at = $3 WHERE id = $4 AND user_id = $5",
    [newCash, curRes, nowIso, pfId, userId],
  );
  const updatedPf: PortfolioRow = {
    ...portfolio,
    cash_balance: newCash,
    reserved_cash: curRes,
    updated_at: nowIso,
  };

  const posRes = await client.query<PositionRow>(
    "SELECT * FROM paper_positions WHERE portfolio_id = $1 AND ticker = $2 FOR UPDATE",
    [pfId, ticker],
  );
  const posRow = posRes.rows[0];

  if (posRow && Number(posRow.shares) > 0) {
    const oldSh = Number(posRow.shares);
    const oldAvg = Number(posRow.avg_cost);
    const newSh = oldSh + shares;
    const newAvg = roundTo((oldSh * oldAvg + shares * execPriceNative) / newSh, 4);
    await client.query(
      "UPDATE paper_positions SET shares = $1, avg_cost = $2, updated_at = $3 WHERE portfolio_id = $4 AND ticker = $5",
      [newSh, newAvg, nowIso, pfId, ticker],
    );
  } else {
    await client.query(
      `INSERT INTO paper_positions (
         portfolio_id, ticker, shares, avg_cost, native_currency,
         entry_score, entry_rating, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (portfolio_id, ticker) DO UPDATE SET
         shares = EXCLUDED.shares,
         avg_cost = EXCLUDED.avg_cost,
         native_currency = EXCLUDED.native_currency,
         entry_score = EXCLUDED.entry_score,
         entry_rating = EXCLUDED.entry_rating,
         updated_at = EXCLUDED.updated_at`,
      [pfId, ticker, shares, roundTo(execPriceNative, 4), nativeCurrency, scoreVal, ratingVal, nowIso],
    );
  }

  let ordId: string;
  const cleanLim = limitPrice !== null ? roundTo(limitPrice, 2) : null;
  if (existingOrderId) {
    ordId = existingOrderId;
    await client.query(
      `UPDATE paper_orders
       SET status = 'FILLED', reserved_amount = 0, filled_at = $1, filled_price = $2
       WHERE id = $3 AND user_id = $4`,
      [nowIso, roundTo(execPriceNative, 2), ordId, userId],
    );
  } else {
    ordId = makeShortId("ord");
    await client.query(
      `INSERT INTO paper_orders (
         id, portfolio_id, user_id, ticker, side, order_type, shares,
         limit_price, reserved_amount, status, score_at_order, rating_at_order,
         note, created_at, filled_at, filled_price
       ) VALUES ($1, $2, $3, $4, 'BUY', $5, $6, $7, 0, 'FILLED', $8, $9, $10, $11, $12, $13)`,
      [
        ordId,
        pfId,
        userId,
        ticker,
        orderType,
        shares,
        cleanLim,
        scoreVal,
        ratingVal,
        note,
        nowIso,
        nowIso,
        roundTo(execPriceNative, 2),
      ],
    );
  }

  const trdId = makeShortId("trd");
  await client.query(
    `INSERT INTO paper_trades (
       id, portfolio_id, order_id, ticker, side, shares,
       exec_price_native, fx_rate, gross_amount, fee_amount, net_amount,
       realized_pnl, score_at_trade, rating_at_trade, executed_at
     ) VALUES ($1, $2, $3, $4, 'BUY', $5, $6, $7, $8, $9, $10, 0, $11, $12, $13)`,
    [
      trdId,
      pfId,
      ordId,
      ticker,
      shares,
      roundTo(execPriceNative, 2),
      roundTo(fx, 6),
      gross,
      fee,
      netDebit,
      scoreVal,
      ratingVal,
      nowIso,
    ],
  );

  return {
    portfolio: updatedPf,
    order: {
      id: ordId,
      portfolio_id: pfId,
      ticker,
      side: "BUY",
      order_type: orderType,
      shares,
      limit_price: cleanLim,
      reserved_amount: 0,
      status: "FILLED",
      score_at_order: scoreVal,
      rating_at_order: ratingVal,
      note,
      created_at: nowIso,
      filled_at: nowIso,
      filled_price: roundTo(execPriceNative, 2),
    },
    trade: {
      id: trdId,
      portfolio_id: pfId,
      order_id: ordId,
      ticker,
      side: "BUY",
      order_type: orderType,
      shares,
      exec_price_native: roundTo(execPriceNative, 2),
      native_currency: nativeCurrency,
      fx_rate: roundTo(fx, 6),
      gross_amount: gross,
      fee_amount: fee,
      net_amount: netDebit,
      realized_pnl: 0,
      score_at_trade: scoreVal,
      rating_at_trade: ratingVal,
      executed_at: nowIso,
    },
  };
}

async function executeSellFillInTx(params: {
  client: PoolClientLike;
  portfolio: PortfolioRow;
  userId: string;
  ticker: string;
  nativeCurrency: string;
  shares: number;
  execPriceNative: number;
  orderType: "MARKET" | "LIMIT";
  limitPrice: number | null;
  scoreVal: number;
  ratingVal: string;
  note: string;
  nowIso: string;
  existingOrderId?: string;
}): Promise<{
  portfolio: PortfolioRow;
  order: Record<string, unknown>;
  trade: Record<string, unknown>;
}> {
  const {
    client,
    portfolio,
    userId,
    ticker,
    nativeCurrency,
    shares,
    execPriceNative,
    orderType,
    limitPrice,
    scoreVal,
    ratingVal,
    note,
    nowIso,
    existingOrderId,
  } = params;

  const pfId = String(portfolio.id);
  const pfCcy = String(portfolio.currency);
  const feeBps = Number(portfolio.fee_bps);
  const fx = computeFxRate(nativeCurrency, pfCcy);

  const posRes = await client.query<PositionRow>(
    "SELECT * FROM paper_positions WHERE portfolio_id = $1 AND ticker = $2 FOR UPDATE",
    [pfId, ticker],
  );
  const posRow = posRes.rows[0];
  const ownedSh = posRow ? Number(posRow.shares) : 0;

  let sellableSh = ownedSh;
  if (!existingOrderId) {
    const encRes = await client.query<{ locked: number }>(
      `SELECT COALESCE(SUM(shares), 0) AS locked
       FROM paper_orders
       WHERE portfolio_id = $1 AND ticker = $2 AND side = 'SELL' AND status = 'OPEN'`,
      [pfId, ticker],
    );
    const lockedSh = Number(encRes.rows[0]?.locked ?? 0);
    sellableSh = ownedSh - lockedSh;
  }

  if (shares > sellableSh || !posRow) {
    throw new PaperServiceError(
      `Insufficient unencumbered shares to sell for ${ticker}: requested ${shares}, sellable ${Math.max(0, sellableSh)}.`,
      400,
    );
  }

  const avgCost = Number(posRow.avg_cost);
  const { gross, fee, netCredit } = computeSellProceeds(shares, execPriceNative, fx, feeBps);
  const costBasis = roundTo(shares * avgCost * fx, 2);
  const realizedPnl = roundTo(netCredit - costBasis, 2);

  const newCash = roundTo(Number(portfolio.cash_balance) + netCredit, 2);
  await client.query(
    "UPDATE paper_portfolios SET cash_balance = $1, updated_at = $2 WHERE id = $3 AND user_id = $4",
    [newCash, nowIso, pfId, userId],
  );
  const updatedPf: PortfolioRow = {
    ...portfolio,
    cash_balance: newCash,
    updated_at: nowIso,
  };

  const remSh = ownedSh - shares;
  if (remSh <= 0) {
    await client.query("DELETE FROM paper_positions WHERE portfolio_id = $1 AND ticker = $2", [
      pfId,
      ticker,
    ]);
  } else {
    await client.query(
      "UPDATE paper_positions SET shares = $1, updated_at = $2 WHERE portfolio_id = $3 AND ticker = $4",
      [remSh, nowIso, pfId, ticker],
    );
  }

  let ordId: string;
  const cleanLim = limitPrice !== null ? roundTo(limitPrice, 2) : null;
  if (existingOrderId) {
    ordId = existingOrderId;
    await client.query(
      `UPDATE paper_orders
       SET status = 'FILLED', filled_at = $1, filled_price = $2
       WHERE id = $3 AND user_id = $4`,
      [nowIso, roundTo(execPriceNative, 2), ordId, userId],
    );
  } else {
    ordId = makeShortId("ord");
    await client.query(
      `INSERT INTO paper_orders (
         id, portfolio_id, user_id, ticker, side, order_type, shares,
         limit_price, reserved_amount, status, score_at_order, rating_at_order,
         note, created_at, filled_at, filled_price
       ) VALUES ($1, $2, $3, $4, 'SELL', $5, $6, $7, 0, 'FILLED', $8, $9, $10, $11, $12, $13)`,
      [
        ordId,
        pfId,
        userId,
        ticker,
        orderType,
        shares,
        cleanLim,
        scoreVal,
        ratingVal,
        note,
        nowIso,
        nowIso,
        roundTo(execPriceNative, 2),
      ],
    );
  }

  const trdId = makeShortId("trd");
  await client.query(
    `INSERT INTO paper_trades (
       id, portfolio_id, order_id, ticker, side, shares,
       exec_price_native, fx_rate, gross_amount, fee_amount, net_amount,
       realized_pnl, score_at_trade, rating_at_trade, executed_at
     ) VALUES ($1, $2, $3, $4, 'SELL', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      trdId,
      pfId,
      ordId,
      ticker,
      shares,
      roundTo(execPriceNative, 2),
      roundTo(fx, 6),
      gross,
      fee,
      netCredit,
      realizedPnl,
      scoreVal,
      ratingVal,
      nowIso,
    ],
  );

  return {
    portfolio: updatedPf,
    order: {
      id: ordId,
      portfolio_id: pfId,
      ticker,
      side: "SELL",
      order_type: orderType,
      shares,
      limit_price: cleanLim,
      reserved_amount: 0,
      status: "FILLED",
      score_at_order: scoreVal,
      rating_at_order: ratingVal,
      note,
      created_at: nowIso,
      filled_at: nowIso,
      filled_price: roundTo(execPriceNative, 2),
    },
    trade: {
      id: trdId,
      portfolio_id: pfId,
      order_id: ordId,
      ticker,
      side: "SELL",
      order_type: orderType,
      shares,
      exec_price_native: roundTo(execPriceNative, 2),
      native_currency: nativeCurrency,
      fx_rate: roundTo(fx, 6),
      gross_amount: gross,
      fee_amount: fee,
      net_amount: netCredit,
      realized_pnl: realizedPnl,
      score_at_trade: scoreVal,
      rating_at_trade: ratingVal,
      executed_at: nowIso,
    },
  };
}

async function queueOpenLimitBuyInTx(params: {
  client: PoolClientLike;
  portfolio: PortfolioRow;
  userId: string;
  ticker: string;
  nativeCurrency: string;
  shares: number;
  limitPrice: number;
  scoreVal: number;
  ratingVal: string;
  note: string;
  nowIso: string;
}): Promise<{ portfolio: PortfolioRow; order: Record<string, unknown> }> {
  const {
    client,
    portfolio,
    userId,
    ticker,
    nativeCurrency,
    shares,
    limitPrice,
    scoreVal,
    ratingVal,
    note,
    nowIso,
  } = params;

  const pfId = String(portfolio.id);
  const pfCcy = String(portfolio.currency);
  const feeBps = Number(portfolio.fee_bps);
  const fx = computeFxRate(nativeCurrency, pfCcy);
  const { netDebit: reservedAmt } = computeBuyCost(shares, limitPrice, fx, feeBps);

  const curCash = roundTo(Number(portfolio.cash_balance), 2);
  const curRes = roundTo(Number(portfolio.reserved_cash), 2);
  const availCash = roundTo(curCash - curRes, 2);

  if (availCash + 1e-9 < reservedAmt) {
    throw new PaperServiceError(
      `Insufficient available cash to reserve LIMIT BUY on ${ticker}: required ${reservedAmt.toFixed(2)} ${pfCcy}, available ${availCash.toFixed(2)} ${pfCcy}.`,
      400,
    );
  }

  const newRes = roundTo(curRes + reservedAmt, 2);
  await client.query(
    "UPDATE paper_portfolios SET reserved_cash = $1, updated_at = $2 WHERE id = $3 AND user_id = $4",
    [newRes, nowIso, pfId, userId],
  );
  const updatedPf: PortfolioRow = {
    ...portfolio,
    reserved_cash: newRes,
    updated_at: nowIso,
  };

  const ordId = makeShortId("ord");
  const cleanLim = roundTo(limitPrice, 2);
  await client.query(
    `INSERT INTO paper_orders (
       id, portfolio_id, user_id, ticker, side, order_type, shares,
       limit_price, reserved_amount, status, score_at_order, rating_at_order,
       note, created_at, filled_at, filled_price
     ) VALUES ($1, $2, $3, $4, 'BUY', 'LIMIT', $5, $6, $7, 'OPEN', $8, $9, $10, $11, NULL, NULL)`,
    [ordId, pfId, userId, ticker, shares, cleanLim, reservedAmt, scoreVal, ratingVal, note, nowIso],
  );

  return {
    portfolio: updatedPf,
    order: {
      id: ordId,
      portfolio_id: pfId,
      ticker,
      side: "BUY",
      order_type: "LIMIT",
      shares,
      limit_price: cleanLim,
      reserved_amount: reservedAmt,
      status: "OPEN",
      score_at_order: scoreVal,
      rating_at_order: ratingVal,
      note,
      created_at: nowIso,
      filled_at: null,
      filled_price: null,
    },
  };
}

// --- Public Parameterized Read Overview (`db.sql`) ---

export async function getPaperOverview(
  user: VerifiedPaperUser,
  portfolioId?: string | null,
  reqUrl?: string,
): Promise<Record<string, unknown>> {
  const db = resolveDbConnection();
  const universe = await loadStockUniverse(reqUrl);
  const liveQuotes = await fetchLiveQuotesMap(db);
  const cleanPfId = (portfolioId ?? "").trim() || null;

  if (cleanPfId) {
    const ownedRows = await db.sql<{ id: string }>`
      SELECT id FROM paper_portfolios
      WHERE id = ${cleanPfId} AND user_id = ${user.id}
    `;
    if (ownedRows.length === 0) {
      throw new PaperServiceError("Paper portfolio not found.", 404);
    }
  }

  const pfRows = await db.sql<PortfolioRow>`
    SELECT id, user_id, name, currency, strategy_preset, benchmark_ticker,
           cash_balance, reserved_cash, total_deposited, fee_bps, created_at, updated_at
    FROM paper_portfolios
    WHERE user_id = ${user.id}
    ORDER BY created_at ASC, id ASC
  `;

  const portfoliosSummary: Record<string, unknown>[] = [];
  let activeDetail: Record<string, unknown> | null = null;
  const targetId = cleanPfId ?? (pfRows.length > 0 ? String(pfRows[0].id) : null);

  for (const pf of pfRows) {
    const pfId = String(pf.id);
    const pfCcy = String(pf.currency);
    const preset = String(pf.strategy_preset || "qglp_compounder");
    const bmTk = String(pf.benchmark_ticker || (pfCcy === "INR" ? "^NSEI" : "^GSPC"));

    const [posRows, openOrdRows, navRows] = await Promise.all([
      db.sql<PositionRow>`
        SELECT portfolio_id, ticker, shares, avg_cost, native_currency,
               entry_score, entry_rating, updated_at
        FROM paper_positions
        WHERE portfolio_id = ${pfId} AND shares > 0
        ORDER BY ticker ASC
      `,
      db.sql<OrderRow>`
        SELECT id, portfolio_id, user_id, ticker, side, order_type, shares, limit_price,
               reserved_amount, status, score_at_order, rating_at_order, note, created_at,
               filled_at, filled_price
        FROM paper_orders
        WHERE portfolio_id = ${pfId} AND user_id = ${user.id} AND status = 'OPEN'
        ORDER BY created_at DESC, id DESC
      `,
      db.sql<NavHistoryRow>`
        SELECT snap_date, cash_balance, holdings_value, total_nav,
               total_deposited, return_pct, benchmark_close, benchmark_return_pct
        FROM paper_nav_history
        WHERE portfolio_id = ${pfId}
        ORDER BY snap_date ASC
      `,
    ]);

    let holdingsVal = 0;
    for (const p of posRows) {
      const q = getQuoteSnapshot(universe, String(p.ticker), liveQuotes);
      const fx = computeFxRate(String(p.native_currency), pfCcy);
      holdingsVal += roundTo(Number(p.shares) * q.close_price * fx, 2);
    }
    holdingsVal = roundTo(holdingsVal, 2);

    const cashBal = roundTo(Number(pf.cash_balance), 2);
    const resCash = roundTo(Number(pf.reserved_cash), 2);
    const availCash = Math.max(0, roundTo(cashBal - resCash, 2));
    const totDep = roundTo(Number(pf.total_deposited), 2);
    const totNav = roundTo(cashBal + holdingsVal, 2);
    const netRetAmt = roundTo(totNav - totDep, 2);
    const retPct = totDep > 0 ? roundTo((netRetAmt / totDep) * 100, 2) : 0;

    let bmRetPct = navRows.length > 0 ? roundTo(Number(navRows[navRows.length - 1].benchmark_return_pct), 2) : 0;
    if (navRows.length > 0) {
      const firstBm = Number(navRows[0].benchmark_close);
      const curBm = getQuoteSnapshot(universe, bmTk, liveQuotes).close_price;
      if (firstBm > 0 && curBm > 0 && Math.abs(curBm - firstBm) > 1e-6) {
        bmRetPct = roundTo(((curBm - firstBm) / firstBm) * 100, 2);
      }
    }
    const alphaPct = roundTo(retPct - bmRetPct, 2);

    const summaryCard: Record<string, unknown> = {
      id: pfId,
      name: String(pf.name),
      currency: pfCcy,
      strategy_preset: preset,
      benchmark_ticker: bmTk,
      cash_balance: cashBal,
      reserved_cash: resCash,
      available_cash: availCash,
      holdings_value: holdingsVal,
      total_nav: totNav,
      total_deposited: totDep,
      net_return_amount: netRetAmt,
      total_return_amt: netRetAmt,
      return_pct: retPct,
      benchmark_return_pct: bmRetPct,
      alpha_pct: alphaPct,
      positions_count: posRows.length,
      open_orders_count: openOrdRows.length,
      fee_bps: Number(pf.fee_bps),
      created_at: String(pf.created_at),
      updated_at: String(pf.updated_at),
    };
    portfoliosSummary.push(summaryCard);

    if (pfId !== targetId) continue;

    const lockedSellByTk = new Map<string, number>();
    for (const o of openOrdRows) {
      if (String(o.side) === "SELL") {
        const tk = String(o.ticker);
        lockedSellByTk.set(tk, (lockedSellByTk.get(tk) ?? 0) + Number(o.shares));
      }
    }

    const positionsOut: Array<Record<string, unknown> & { market_value: number; unrealized_pnl: number; unrealized_pnl_pct: number; entry_rating: string; invested_value: number; ticker: string; name: string }> = [];
    for (const p of posRows) {
      const tk = String(p.ticker);
      const meta = universe.stocks[tk];
      const nativeCcy = String(p.native_currency || meta?.currency || "INR");
      const fx = computeFxRate(nativeCcy, pfCcy);
      const q = getQuoteSnapshot(universe, tk, liveQuotes);
      const livePx = roundTo(q.close_price, 2);
      const sh = Number(p.shares);
      const sellableSh = Math.max(0, sh - (lockedSellByTk.get(tk) ?? 0));
      const avgC = roundTo(Number(p.avg_cost), 2);

      const invested = roundTo(sh * Number(p.avg_cost) * fx, 2);
      const mktVal = roundTo(sh * livePx * fx, 2);
      const unrlPnl = roundTo(mktVal - invested, 2);
      const unrlPct = invested > 0 ? roundTo((unrlPnl / invested) * 100, 2) : 0;
      const wtPct = totNav > 0 ? roundTo((mktVal / totNav) * 100, 2) : 0;

      const { score: curScore, rating: curRating } = getScoreAndRating(universe, tk, preset);
      const entScore = roundTo(Number(p.entry_score), 1);
      const entRating = String(p.entry_rating);
      const mktCode = meta?.market || (nativeCcy === "INR" ? "IN" : "US");
      const idxTag = meta?.index_tag || (nativeCcy === "INR" ? "NIFTY200" : "NASDAQ100");

      positionsOut.push({
        portfolio_id: pfId,
        ticker: tk,
        name: meta?.name || tk,
        sector: meta?.sector || "Diversified",
        market: mktCode,
        index_tag: idxTag,
        market_label: resolveMarketLabel(idxTag, mktCode),
        native_currency: nativeCcy,
        shares: sh,
        sellable_shares: sellableSh,
        avg_cost: avgC,
        live_price: livePx,
        current_price: livePx,
        fx_rate: roundTo(fx, 6),
        cost_basis: invested,
        invested_value: invested,
        market_value: mktVal,
        unrealized_pnl: unrlPnl,
        unrealized_pnl_pct: unrlPct,
        weight_pct: wtPct,
        entry_score: entScore,
        entry_rating: entRating,
        current_score: curScore,
        current_rating: curRating,
        score_delta: roundTo(curScore - entScore, 1),
        updated_at: String(p.updated_at),
      });
    }

    positionsOut.sort((a, b) => b.market_value - a.market_value);

    let bestPick: Record<string, unknown> | null = null;
    if (positionsOut.length > 0) {
      let topPos = positionsOut[0];
      for (const cand of positionsOut) {
        if (cand.unrealized_pnl_pct > topPos.unrealized_pnl_pct) {
          topPos = cand;
        }
      }
      bestPick = {
        ticker: topPos.ticker,
        name: topPos.name,
        unrealized_pnl: topPos.unrealized_pnl,
        unrealized_pnl_pct: topPos.unrealized_pnl_pct,
      };
    }

    const openOrdersOut = openOrdRows.map((o) => {
      const tk = String(o.ticker);
      const meta = universe.stocks[tk];
      const nativeCcy = meta?.currency || (tk.endsWith(".NS") || tk.endsWith(".BO") ? "INR" : "USD");
      const q = getQuoteSnapshot(universe, tk, liveQuotes);
      const curPx = roundTo(q.close_price, 2);
      const limPx = o.limit_price !== null ? roundTo(Number(o.limit_price), 2) : null;
      const distPct = limPx !== null && curPx > 0 ? roundTo(((limPx - curPx) / curPx) * 100, 2) : 0;

      return {
        id: String(o.id),
        portfolio_id: pfId,
        ticker: tk,
        name: meta?.name || tk,
        index_tag: meta?.index_tag || (nativeCcy === "INR" ? "NIFTY200" : "NASDAQ100"),
        native_currency: nativeCcy,
        side: String(o.side),
        order_type: String(o.order_type),
        shares: Number(o.shares),
        limit_price: limPx,
        live_price: curPx,
        current_price: curPx,
        distance_pct: distPct,
        reserved_amount: roundTo(Number(o.reserved_amount || 0), 2),
        status: String(o.status),
        score_at_order: o.score_at_order !== null ? roundTo(Number(o.score_at_order), 1) : null,
        rating_at_order: String(o.rating_at_order || ""),
        note: String(o.note || ""),
        created_at: String(o.created_at),
      };
    });

    const tradeRows = await db.sql<TradeWithOrderTypeRow>`
      SELECT t.id, t.portfolio_id, t.order_id, t.ticker, t.side, t.shares,
             t.exec_price_native, t.fx_rate, t.gross_amount, t.fee_amount,
             t.net_amount, t.realized_pnl, t.score_at_trade, t.rating_at_trade,
             t.executed_at, COALESCE(o.order_type, 'MARKET') AS order_type
      FROM paper_trades t
      LEFT JOIN paper_orders o ON o.id = t.order_id
      WHERE t.portfolio_id = ${pfId}
      ORDER BY t.executed_at DESC, t.id DESC
      LIMIT 100
    `;

    const recentTradesOut = tradeRows.map((tr) => {
      const tk = String(tr.ticker);
      const meta = universe.stocks[tk];
      const nativeCcy = meta?.currency || (tk.endsWith(".NS") || tk.endsWith(".BO") ? "INR" : "USD");
      return {
        id: String(tr.id),
        portfolio_id: pfId,
        order_id: tr.order_id ? String(tr.order_id) : null,
        ticker: tk,
        name: meta?.name || tk,
        index_tag: meta?.index_tag || (nativeCcy === "INR" ? "NIFTY200" : "NASDAQ100"),
        native_currency: nativeCcy,
        side: String(tr.side),
        order_type: String(tr.order_type || "MARKET"),
        shares: Number(tr.shares),
        exec_price_native: roundTo(Number(tr.exec_price_native), 2),
        fx_rate: roundTo(Number(tr.fx_rate), 6),
        gross_amount: roundTo(Number(tr.gross_amount), 2),
        fee_amount: roundTo(Number(tr.fee_amount), 2),
        net_amount: roundTo(Number(tr.net_amount), 2),
        realized_pnl: roundTo(Number(tr.realized_pnl), 2),
        score_at_trade: tr.score_at_trade !== null ? roundTo(Number(tr.score_at_trade), 1) : null,
        rating_at_trade: String(tr.rating_at_trade || ""),
        executed_at: String(tr.executed_at),
      };
    });

    const navHistoryOut = navRows.map((nr) => {
      const rPct = roundTo(Number(nr.return_pct), 2);
      const bPct = roundTo(Number(nr.benchmark_return_pct), 2);
      return {
        snap_date: String(nr.snap_date),
        cash_balance: roundTo(Number(nr.cash_balance), 2),
        holdings_value: roundTo(Number(nr.holdings_value), 2),
        total_nav: roundTo(Number(nr.total_nav), 2),
        total_deposited: roundTo(Number(nr.total_deposited), 2),
        return_pct: rPct,
        benchmark_close: roundTo(Number(nr.benchmark_close), 2),
        benchmark_return_pct: bPct,
        portfolio_indexed: roundTo(100 * (1 + rPct / 100), 2),
        benchmark_indexed: roundTo(100 * (1 + bPct / 100), 2),
      };
    });

    const bucketMap = new Map<string, { rating: string; count: number; invested: number; current_value: number }>();
    for (const rt of ATTRIBUTION_RATINGS) {
      bucketMap.set(rt, { rating: rt, count: 0, invested: 0, current_value: 0 });
    }
    for (const pos of positionsOut) {
      const rt = pos.entry_rating || "Hold";
      const bucket = bucketMap.get(rt) ?? { rating: rt, count: 0, invested: 0, current_value: 0 };
      bucket.count += 1;
      bucket.invested = roundTo(bucket.invested + pos.invested_value, 2);
      bucket.current_value = roundTo(bucket.current_value + pos.market_value, 2);
      bucketMap.set(rt, bucket);
    }

    const attributionOut = Array.from(bucketMap.values()).map((b) => {
      const pnl = roundTo(b.current_value - b.invested, 2);
      const rPct = b.invested > 0 ? roundTo((pnl / b.invested) * 100, 2) : 0;
      return {
        rating: b.rating,
        count: b.count,
        invested: b.invested,
        current_value: b.current_value,
        pnl_amount: pnl,
        unrealized_pnl: pnl,
        return_pct: rPct,
      };
    });

    activeDetail = {
      ...summaryCard,
      best_pick: bestPick,
      positions: positionsOut,
      open_orders: openOrdersOut,
      recent_trades: recentTradesOut,
      nav_history: navHistoryOut,
      attribution_by_rating: attributionOut,
    };
  }

  const displayEmail = user.email || user.id;
  return {
    authenticated: true,
    user: {
      id: user.id,
      email: user.email ?? null,
      username: displayEmail,
      email_or_username: displayEmail,
    },
    portfolios: portfoliosSummary,
    active_portfolio: activeDetail,
  };
}

// --- Public Transactional Mutations (`db.pool.connect()` + `BEGIN`/`FOR UPDATE`/`COMMIT`) ---

export async function createPaperPortfolio(
  user: VerifiedPaperUser,
  body: Record<string, unknown>,
  reqUrl?: string,
): Promise<Record<string, unknown>> {
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  if (rawName.length < 1 || rawName.length > 80) {
    throw new PaperServiceError("Portfolio name must be between 1 and 80 characters.", 400);
  }
  const ccy = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "INR";
  if (!ALLOWED_CURRENCIES.has(ccy)) {
    throw new PaperServiceError("Currency must be 'INR' or 'USD'.", 400);
  }
  const initCash = Number(body.initial_cash);
  if (!Number.isFinite(initCash) || initCash <= 0 || initCash > 1_000_000_000) {
    throw new PaperServiceError("initial_cash must be a positive number up to 1,000,000,000.", 400);
  }
  const rawPreset = typeof body.strategy_preset === "string" ? body.strategy_preset.trim().toLowerCase() : "qglp_compounder";
  const preset = ALLOWED_PRESETS.has(rawPreset) ? rawPreset : "qglp_compounder";
  const defaultBm = ccy === "INR" ? "^NSEI" : "^GSPC";
  const rawBm = typeof body.benchmark_ticker === "string" && body.benchmark_ticker.trim()
    ? body.benchmark_ticker.trim().toUpperCase()
    : defaultBm;
  const bmTk = ALLOWED_BENCHMARKS.has(rawBm) ? rawBm : defaultBm;
  const feeBps = body.fee_bps !== undefined ? Number(body.fee_bps) : 25;
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 500) {
    throw new PaperServiceError("fee_bps must be between 0 and 500.", 400);
  }

  const db = resolveDbConnection();
  const universe = await loadStockUniverse(reqUrl);
  const liveQuotes = await fetchLiveQuotesMap(db);
  const pfId = makeShortId("pf");
  const nowIso = utcNowIso();
  const cleanCash = roundTo(initCash, 2);
  const cleanFee = roundTo(feeBps, 2);

  const client = await connectPoolClient(db);
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO paper_portfolios (
         id, user_id, name, currency, strategy_preset, benchmark_ticker,
         cash_balance, reserved_cash, total_deposited, fee_bps, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11)`,
      [pfId, user.id, rawName, ccy, preset, bmTk, cleanCash, cleanCash, cleanFee, nowIso, nowIso],
    );
    const pfRow: PortfolioRow = {
      id: pfId,
      user_id: user.id,
      name: rawName,
      currency: ccy,
      strategy_preset: preset,
      benchmark_ticker: bmTk,
      cash_balance: cleanCash,
      reserved_cash: 0,
      total_deposited: cleanCash,
      fee_bps: cleanFee,
      created_at: nowIso,
      updated_at: nowIso,
    };
    await recordNavSnapshotInTx(client, universe, pfRow, liveQuotes);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const overview = await getPaperOverview(user, pfId, reqUrl);
  return {
    ...overview,
    status: "ok",
    created_portfolio_id: pfId,
    portfolio: overview.active_portfolio,
  };
}

export async function depositPaperCash(
  user: VerifiedPaperUser,
  portfolioId: string,
  body: Record<string, unknown>,
  reqUrl?: string,
): Promise<Record<string, unknown>> {
  const cleanPfId = portfolioId.trim();
  if (!cleanPfId) {
    throw new PaperServiceError("Missing portfolio_id.", 400);
  }
  const rawAmt = Number(body.amount);
  if (!Number.isFinite(rawAmt) || rawAmt <= 0 || rawAmt > 1_000_000_000) {
    throw new PaperServiceError("Deposit amount must be a positive number.", 400);
  }
  const cleanAmt = roundTo(rawAmt, 2);

  const db = resolveDbConnection();
  const universe = await loadStockUniverse(reqUrl);
  const liveQuotes = await fetchLiveQuotesMap(db);
  const nowIso = utcNowIso();

  const client = await connectPoolClient(db);
  try {
    await client.query("BEGIN");
    const pfRes = await client.query<PortfolioRow>(
      "SELECT * FROM paper_portfolios WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [cleanPfId, user.id],
    );
    const pf = pfRes.rows[0];
    if (!pf) {
      throw new PaperServiceError("Paper portfolio not found.", 404);
    }

    const newCash = roundTo(Number(pf.cash_balance) + cleanAmt, 2);
    const newDep = roundTo(Number(pf.total_deposited) + cleanAmt, 2);
    await client.query(
      `UPDATE paper_portfolios
       SET cash_balance = $1, total_deposited = $2, updated_at = $3
       WHERE id = $4 AND user_id = $5`,
      [newCash, newDep, nowIso, cleanPfId, user.id],
    );
    const updatedPf: PortfolioRow = {
      ...pf,
      cash_balance: newCash,
      total_deposited: newDep,
      updated_at: nowIso,
    };
    await recordNavSnapshotInTx(client, universe, updatedPf, liveQuotes);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const overview = await getPaperOverview(user, cleanPfId, reqUrl);
  return {
    ...overview,
    status: "ok",
    deposited_amount: cleanAmt,
    portfolio: overview.active_portfolio,
  };
}

export async function placePaperOrder(
  user: VerifiedPaperUser,
  body: Record<string, unknown>,
  reqUrl?: string,
): Promise<Record<string, unknown>> {
  const pfId = typeof body.portfolio_id === "string" ? body.portfolio_id.trim() : "";
  if (!pfId) {
    throw new PaperServiceError("portfolio_id is required.", 400);
  }
  const side = typeof body.side === "string" ? body.side.trim().toUpperCase() : "";
  if (side !== "BUY" && side !== "SELL") {
    throw new PaperServiceError("side must be 'BUY' or 'SELL'.", 400);
  }
  const orderType = typeof body.order_type === "string" ? body.order_type.trim().toUpperCase() : "";
  if (orderType !== "MARKET" && orderType !== "LIMIT") {
    throw new PaperServiceError("order_type must be 'MARKET' or 'LIMIT'.", 400);
  }
  const rawShares = Number(body.shares);
  if (!Number.isInteger(rawShares) || rawShares <= 0 || rawShares > 10_000_000) {
    throw new PaperServiceError("shares must be a positive integer.", 400);
  }
  let limitPrice: number | null = null;
  if (orderType === "LIMIT") {
    const rawLim = Number(body.limit_price);
    if (!Number.isFinite(rawLim) || rawLim <= 0) {
      throw new PaperServiceError("A positive limit_price is required for LIMIT orders.", 400);
    }
    limitPrice = roundTo(rawLim, 2);
  }
  const rawNote = typeof body.note === "string" ? body.note.trim().slice(0, 240) : "";

  const db = resolveDbConnection();
  const universe = await loadStockUniverse(reqUrl);
  const { ticker, entry } = resolveTradableCompany(universe, body.ticker);
  const nativeCcy = entry.currency || "INR";

  const liveQuotes = await fetchLiveQuotesMap(db);
  const quote = getQuoteSnapshot(universe, ticker, liveQuotes);
  const curPrice = roundTo(quote.close_price, 2);
  if (curPrice <= 0) {
    throw new PaperServiceError(`No valid market price available for ${ticker}.`, 400);
  }

  const nowIso = utcNowIso();
  let orderOut: Record<string, unknown> = {};
  let tradeOut: Record<string, unknown> | null = null;

  const client = await connectPoolClient(db);
  try {
    await client.query("BEGIN");
    const pfRes = await client.query<PortfolioRow>(
      "SELECT * FROM paper_portfolios WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [pfId, user.id],
    );
    let pf = pfRes.rows[0];
    if (!pf) {
      throw new PaperServiceError("Paper portfolio not found.", 404);
    }
    const preset = String(pf.strategy_preset || "qglp_compounder");
    const { score: scoreVal, rating: ratingVal } = getScoreAndRating(universe, ticker, preset);

    if (side === "BUY") {
      if (orderType === "MARKET") {
        const res = await executeBuyFillInTx({
          client,
          portfolio: pf,
          userId: user.id,
          ticker,
          nativeCurrency: nativeCcy,
          shares: rawShares,
          execPriceNative: curPrice,
          orderType: "MARKET",
          limitPrice: null,
          scoreVal,
          ratingVal,
          note: rawNote,
          nowIso,
        });
        pf = res.portfolio;
        orderOut = res.order;
        tradeOut = res.trade;
      } else if (limitPrice! >= curPrice) {
        const res = await executeBuyFillInTx({
          client,
          portfolio: pf,
          userId: user.id,
          ticker,
          nativeCurrency: nativeCcy,
          shares: rawShares,
          execPriceNative: curPrice,
          orderType: "LIMIT",
          limitPrice,
          scoreVal,
          ratingVal,
          note: rawNote,
          nowIso,
        });
        pf = res.portfolio;
        orderOut = res.order;
        tradeOut = res.trade;
      } else {
        const dipPctStr = (((limitPrice! - curPrice) / curPrice) * 100).toFixed(1);
        const res = await queueOpenLimitBuyInTx({
          client,
          portfolio: pf,
          userId: user.id,
          ticker,
          nativeCurrency: nativeCcy,
          shares: rawShares,
          limitPrice: limitPrice!,
          scoreVal,
          ratingVal,
          note: rawNote || `Buy-on-Dip (${dipPctStr}%)`,
          nowIso,
        });
        pf = res.portfolio;
        orderOut = res.order;
      }
    } else if (orderType === "MARKET") {
      const res = await executeSellFillInTx({
        client,
        portfolio: pf,
        userId: user.id,
        ticker,
        nativeCurrency: nativeCcy,
        shares: rawShares,
        execPriceNative: curPrice,
        orderType: "MARKET",
        limitPrice: null,
        scoreVal,
        ratingVal,
        note: rawNote,
        nowIso,
      });
      pf = res.portfolio;
      orderOut = res.order;
      tradeOut = res.trade;
    } else if (limitPrice! <= curPrice) {
      const res = await executeSellFillInTx({
        client,
        portfolio: pf,
        userId: user.id,
        ticker,
        nativeCurrency: nativeCcy,
        shares: rawShares,
        execPriceNative: curPrice,
        orderType: "LIMIT",
        limitPrice,
        scoreVal,
        ratingVal,
        note: rawNote,
        nowIso,
      });
      pf = res.portfolio;
      orderOut = res.order;
      tradeOut = res.trade;
    } else {
      const posRes = await client.query<{ shares: number }>(
        "SELECT shares FROM paper_positions WHERE portfolio_id = $1 AND ticker = $2 FOR UPDATE",
        [pf.id, ticker],
      );
      const ownedSh = Number(posRes.rows[0]?.shares ?? 0);
      const encRes = await client.query<{ locked: number }>(
        `SELECT COALESCE(SUM(shares), 0) AS locked
         FROM paper_orders
         WHERE portfolio_id = $1 AND ticker = $2 AND side = 'SELL' AND status = 'OPEN'`,
        [pf.id, ticker],
      );
      const lockedSh = Number(encRes.rows[0]?.locked ?? 0);
      if (rawShares > ownedSh - lockedSh) {
        throw new PaperServiceError(
          `Insufficient unencumbered shares to queue LIMIT SELL on ${ticker}.`,
          400,
        );
      }
      const ordId = makeShortId("ord");
      await client.query(
        `INSERT INTO paper_orders (
           id, portfolio_id, user_id, ticker, side, order_type, shares,
           limit_price, reserved_amount, status, score_at_order, rating_at_order,
           note, created_at, filled_at, filled_price
         ) VALUES ($1, $2, $3, $4, 'SELL', 'LIMIT', $5, $6, 0, 'OPEN', $7, $8, $9, $10, NULL, NULL)`,
        [ordId, pf.id, user.id, ticker, rawShares, limitPrice, scoreVal, ratingVal, rawNote, nowIso],
      );
      orderOut = {
        id: ordId,
        portfolio_id: String(pf.id),
        ticker,
        side: "SELL",
        order_type: "LIMIT",
        shares: rawShares,
        limit_price: limitPrice,
        reserved_amount: 0,
        status: "OPEN",
        score_at_order: scoreVal,
        rating_at_order: ratingVal,
        note: rawNote,
        created_at: nowIso,
        filled_at: null,
        filled_price: null,
      };
    }

    await recordNavSnapshotInTx(client, universe, pf, liveQuotes);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const overview = await getPaperOverview(user, pfId, reqUrl);
  return {
    ...overview,
    status: "ok",
    order: orderOut,
    trade: tradeOut,
  };
}

export async function cancelPaperOrder(
  user: VerifiedPaperUser,
  orderId: string,
  reqUrl?: string,
): Promise<Record<string, unknown>> {
  const cleanOrderId = orderId.trim();
  if (!cleanOrderId) {
    throw new PaperServiceError("order_id is required.", 400);
  }

  const db = resolveDbConnection();
  const nowIso = utcNowIso();
  let pfId = "";
  let cancelledOrder: Record<string, unknown> = {};

  const client = await connectPoolClient(db);
  try {
    await client.query("BEGIN");
    const ordRes = await client.query<OrderRow>(
      "SELECT * FROM paper_orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [cleanOrderId, user.id],
    );
    const ord = ordRes.rows[0];
    if (!ord) {
      throw new PaperServiceError("Order not found.", 404);
    }
    if (String(ord.status) !== "OPEN") {
      throw new PaperServiceError(
        `Only OPEN orders can be cancelled (current status: ${ord.status}).`,
        400,
      );
    }

    pfId = String(ord.portfolio_id);
    const pfRes = await client.query<PortfolioRow>(
      "SELECT * FROM paper_portfolios WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [pfId, user.id],
    );
    const pf = pfRes.rows[0];
    if (!pf) {
      throw new PaperServiceError("Paper portfolio not found.", 404);
    }

    const relAmt = roundTo(Number(ord.reserved_amount || 0), 2);
    if (String(ord.side) === "BUY" && relAmt > 0) {
      const newRes = Math.max(0, roundTo(Number(pf.reserved_cash) - relAmt, 2));
      await client.query(
        "UPDATE paper_portfolios SET reserved_cash = $1, updated_at = $2 WHERE id = $3 AND user_id = $4",
        [newRes, nowIso, pfId, user.id],
      );
    }

    await client.query(
      "UPDATE paper_orders SET status = 'CANCELLED', reserved_amount = 0 WHERE id = $1 AND user_id = $2",
      [cleanOrderId, user.id],
    );
    cancelledOrder = {
      ...ord,
      status: "CANCELLED",
      reserved_amount: 0,
    };
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const overview = await getPaperOverview(user, pfId, reqUrl);
  return {
    ...overview,
    status: "ok",
    cancelled_order_id: cleanOrderId,
    order: cancelledOrder,
  };
}

export async function deployPaperBasket(
  user: VerifiedPaperUser,
  body: Record<string, unknown>,
  reqUrl?: string,
): Promise<Record<string, unknown>> {
  const pfId = typeof body.portfolio_id === "string" ? body.portfolio_id.trim() : "";
  if (!pfId) {
    throw new PaperServiceError("portfolio_id is required.", 400);
  }
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 35) {
    throw new PaperServiceError("items must be a non-empty array of up to 35 basket entries.", 400);
  }

  const db = resolveDbConnection();
  const universe = await loadStockUniverse(reqUrl);

  interface ValidatedBasketItem {
    ticker: string;
    nativeCurrency: string;
    marketShares: number;
    dipShares: number;
    dipPct: number;
    note: string;
  }

  const actionable: ValidatedBasketItem[] = [];
  for (const rawItem of body.items) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const rec = rawItem as Record<string, unknown>;
    const mktShares = rec.market_shares !== undefined ? Number(rec.market_shares) : 0;
    const dipShares = rec.dip_shares !== undefined ? Number(rec.dip_shares) : 0;
    const dipPct = rec.dip_pct !== undefined ? Number(rec.dip_pct) : 7.0;

    if (!Number.isInteger(mktShares) || mktShares < 0 || !Number.isInteger(dipShares) || dipShares < 0) {
      throw new PaperServiceError("market_shares and dip_shares must be non-negative integers.", 400);
    }
    if (!Number.isFinite(dipPct) || dipPct < 0.5 || dipPct > 50) {
      throw new PaperServiceError("dip_pct must be between 0.5 and 50.", 400);
    }
    if (mktShares === 0 && dipShares === 0) continue;

    const { ticker, entry } = resolveTradableCompany(universe, rec.ticker);
    actionable.push({
      ticker,
      nativeCurrency: entry.currency || "INR",
      marketShares: mktShares,
      dipShares,
      dipPct,
      note: typeof rec.note === "string" ? rec.note.trim().slice(0, 240) : "",
    });
  }

  if (actionable.length === 0) {
    throw new PaperServiceError(
      "Basket must contain at least one item with market_shares > 0 or dip_shares > 0.",
      400,
    );
  }

  const liveQuotes = await fetchLiveQuotesMap(db);
  const nowIso = utcNowIso();
  const executedTrades: Record<string, unknown>[] = [];
  const queuedOrders: Record<string, unknown>[] = [];
  const allOrders: Record<string, unknown>[] = [];

  const client = await connectPoolClient(db);
  try {
    await client.query("BEGIN");
    const pfRes = await client.query<PortfolioRow>(
      "SELECT * FROM paper_portfolios WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [pfId, user.id],
    );
    let pf = pfRes.rows[0];
    if (!pf) {
      throw new PaperServiceError("Paper portfolio not found.", 404);
    }
    const preset = String(pf.strategy_preset || "qglp_compounder");

    for (const item of actionable) {
      const quote = getQuoteSnapshot(universe, item.ticker, liveQuotes);
      const curPrice = roundTo(quote.close_price, 2);
      if (curPrice <= 0) {
        throw new PaperServiceError(`No valid market price available for ${item.ticker}.`, 400);
      }
      const { score: scoreVal, rating: ratingVal } = getScoreAndRating(universe, item.ticker, preset);

      if (item.marketShares > 0) {
        const mRes = await executeBuyFillInTx({
          client,
          portfolio: pf,
          userId: user.id,
          ticker: item.ticker,
          nativeCurrency: item.nativeCurrency,
          shares: item.marketShares,
          execPriceNative: curPrice,
          orderType: "MARKET",
          limitPrice: null,
          scoreVal,
          ratingVal,
          note: item.note || "Planner Immediate Tranche",
          nowIso,
        });
        pf = mRes.portfolio;
        allOrders.push(mRes.order);
        executedTrades.push(mRes.trade);
      }

      if (item.dipShares > 0) {
        const limitPx = roundTo(curPrice * (1 - item.dipPct / 100), 2);
        if (limitPx <= 0) {
          throw new PaperServiceError(`Computed limit price for ${item.ticker} must be positive.`, 400);
        }
        const dipNote = item.note || `Blueprint Buy-on-Dip (-${item.dipPct}%)`;
        if (limitPx >= curPrice) {
          const lRes = await executeBuyFillInTx({
            client,
            portfolio: pf,
            userId: user.id,
            ticker: item.ticker,
            nativeCurrency: item.nativeCurrency,
            shares: item.dipShares,
            execPriceNative: curPrice,
            orderType: "LIMIT",
            limitPrice: limitPx,
            scoreVal,
            ratingVal,
            note: dipNote,
            nowIso,
          });
          pf = lRes.portfolio;
          allOrders.push(lRes.order);
          executedTrades.push(lRes.trade);
        } else {
          const lRes = await queueOpenLimitBuyInTx({
            client,
            portfolio: pf,
            userId: user.id,
            ticker: item.ticker,
            nativeCurrency: item.nativeCurrency,
            shares: item.dipShares,
            limitPrice: limitPx,
            scoreVal,
            ratingVal,
            note: dipNote,
            nowIso,
          });
          pf = lRes.portfolio;
          allOrders.push(lRes.order);
          queuedOrders.push(lRes.order);
        }
      }
    }

    await recordNavSnapshotInTx(client, universe, pf, liveQuotes);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const overview = await getPaperOverview(user, pfId, reqUrl);
  return {
    ...overview,
    status: "ok",
    executed_trades: executedTrades,
    queued_orders: queuedOrders,
    deployed: {
      market_fills_count: executedTrades.length,
      limit_orders_count: queuedOrders.length,
      orders: allOrders,
      trades: executedTrades,
    },
  };
}

// --- Live Yahoo Finance Chart Fetcher & Scheduled/On-Demand Refresh ---

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: { gmtoffset?: number };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>;
          low?: Array<number | null>;
          high?: Array<number | null>;
        }>;
      };
    }>;
  };
}

async function fetchSingleYahooOhlc(symbol: string): Promise<LiveQuoteRow | null> {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=5d&interval=1d`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as YahooChartResponse;
    const res0 = payload.chart?.result?.[0];
    if (!res0) return null;

    const gmtOffsetSec = Number(res0.meta?.gmtoffset ?? 0);
    const timestamps = res0.timestamp ?? [];
    const q = res0.indicators?.quote?.[0];
    const closes = q?.close ?? [];
    const lows = q?.low ?? [];
    const highs = q?.high ?? [];

    for (let idx = timestamps.length - 1; idx >= 0; idx -= 1) {
      const cRaw = closes[idx];
      if (cRaw === null || cRaw === undefined || !Number.isFinite(cRaw) || cRaw <= 0) continue;
      const loRaw = lows[idx];
      const hiRaw = highs[idx];
      let loVal = loRaw !== null && loRaw !== undefined && Number.isFinite(loRaw) && loRaw > 0 ? loRaw : cRaw;
      let hiVal = hiRaw !== null && hiRaw !== undefined && Number.isFinite(hiRaw) && hiRaw > 0 ? hiRaw : cRaw;
      loVal = Math.min(loVal, cRaw);
      hiVal = Math.max(hiVal, cRaw);

      const localEpochMs = (Number(timestamps[idx]) + gmtOffsetSec) * 1000;
      const tradeDate = new Date(localEpochMs).toISOString().slice(0, 10);

      return {
        ticker: symbol,
        close_price: roundTo(cRaw, 2),
        day_low: roundTo(loVal, 2),
        day_high: roundTo(hiVal, 2),
        trade_date: tradeDate,
      };
    }
  } catch {
    // Graceful skip on timeout or upstream failure
  }
  return null;
}

export async function fetchYahooChartQuotes(tickers: string[]): Promise<Map<string, LiveQuoteRow>> {
  const unique = Array.from(new Set(tickers.map((t) => t.trim()).filter(Boolean))).sort();
  const out = new Map<string, LiveQuoteRow>();
  if (unique.length === 0) return out;

  const concurrency = 10;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (cursor < unique.length) {
      const sym = unique[cursor];
      cursor += 1;
      const quote = await fetchSingleYahooOhlc(sym);
      if (quote && quote.close_price > 0) {
        out.set(sym, quote);
      }
    }
  });
  await Promise.allSettled(workers);
  return out;
}

export async function runGlobalDailyPaperRefresh(reqUrl?: string): Promise<{
  quotes_updated: number;
  orders_filled: number;
  portfolios_snapshotted: number;
  as_of_date: string;
}> {
  const db = resolveDbConnection();
  const universe = await loadStockUniverse(reqUrl);

  const [posTks, ordTks, bmTks] = await Promise.all([
    db.sql<{ ticker: string }>`SELECT DISTINCT ticker FROM paper_positions WHERE shares > 0`,
    db.sql<{ ticker: string }>`SELECT DISTINCT ticker FROM paper_orders WHERE status = 'OPEN'`,
    db.sql<{ benchmark_ticker: string }>`SELECT DISTINCT benchmark_ticker FROM paper_portfolios`,
  ]);

  const tracked = new Set<string>(BENCHMARK_SYMBOLS);
  for (const r of posTks) if (r.ticker) tracked.add(String(r.ticker));
  for (const r of ordTks) if (r.ticker) tracked.add(String(r.ticker));
  for (const r of bmTks) if (r.benchmark_ticker) tracked.add(String(r.benchmark_ticker));

  const sortedTickers = Array.from(tracked).sort();
  const fetched = await fetchYahooChartQuotes(sortedTickers);
  const existingLive = await fetchLiveQuotesMap(db);
  const nowIso = utcNowIso();

  const toUpsert: LiveQuoteRow[] = [];
  for (const sym of sortedTickers) {
    const hit = fetched.get(sym);
    if (hit) {
      toUpsert.push({ ...hit, updated_at: nowIso });
      continue;
    }
    if (!existingLive.has(sym)) {
      const base = getBaselinePrice(universe, sym);
      if (base.close_price > 0) {
        toUpsert.push({
          ticker: sym,
          close_price: base.close_price,
          day_low: base.close_price,
          day_high: base.close_price,
          trade_date: base.trade_date,
          updated_at: nowIso,
        });
      }
    }
  }

  let filledCount = 0;
  let snapshottedCount = 0;
  let refreshSnapDate = utcTodayStr();
  const fetchedDates = Array.from(fetched.values()).map((q) => q.trade_date).filter(Boolean).sort();
  if (fetchedDates.length > 0) {
    refreshSnapDate = fetchedDates[fetchedDates.length - 1];
  }

  const client = await connectPoolClient(db);
  try {
    await client.query("BEGIN");
    for (const q of toUpsert) {
      await client.query(
        `INSERT INTO paper_live_quotes (ticker, close_price, day_low, day_high, trade_date, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (ticker) DO UPDATE SET
           close_price = EXCLUDED.close_price,
           day_low = EXCLUDED.day_low,
           day_high = EXCLUDED.day_high,
           trade_date = EXCLUDED.trade_date,
           updated_at = EXCLUDED.updated_at`,
        [q.ticker, q.close_price, q.day_low, q.day_high, q.trade_date, nowIso],
      );
      existingLive.set(q.ticker, q);
    }

    const openRes = await client.query<OrderRow>(
      `SELECT * FROM paper_orders
       WHERE status = 'OPEN' AND order_type = 'LIMIT'
       ORDER BY created_at ASC, id ASC
       FOR UPDATE`,
    );

    for (const ord of openRes.rows) {
      const tk = String(ord.ticker);
      const limPx = Number(ord.limit_price || 0);
      if (limPx <= 0) continue;

      const q = getQuoteSnapshot(universe, tk, existingLive);
      if (q.close_price <= 0) continue;

      const pfRes = await client.query<PortfolioRow>(
        "SELECT * FROM paper_portfolios WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [ord.portfolio_id, ord.user_id],
      );
      const pf = pfRes.rows[0];
      if (!pf) continue;

      const meta = universe.stocks[tk];
      const nativeCcy = meta?.currency || (tk.endsWith(".NS") || tk.endsWith(".BO") ? "INR" : "USD");
      const preset = String(pf.strategy_preset || "qglp_compounder");
      const { score: curScore, rating: curRating } = getScoreAndRating(universe, tk, preset);
      const scoreVal = ord.score_at_order !== null ? Number(ord.score_at_order) : curScore;
      const ratingVal = String(ord.rating_at_order || curRating);

      if (String(ord.side) === "BUY" && q.day_low <= limPx + 1e-9) {
        const execPx = roundTo(Math.min(q.close_price, limPx), 2);
        await executeBuyFillInTx({
          client,
          portfolio: pf,
          userId: String(ord.user_id),
          ticker: tk,
          nativeCurrency: nativeCcy,
          shares: Number(ord.shares),
          execPriceNative: execPx,
          orderType: "LIMIT",
          limitPrice: limPx,
          scoreVal,
          ratingVal,
          note: String(ord.note || ""),
          nowIso,
          existingOrderId: String(ord.id),
          releasedReservation: Number(ord.reserved_amount || 0),
        });
        filledCount += 1;
      } else if (String(ord.side) === "SELL" && q.day_high + 1e-9 >= limPx) {
        const execPx = roundTo(Math.max(q.close_price, limPx), 2);
        try {
          await executeSellFillInTx({
            client,
            portfolio: pf,
            userId: String(ord.user_id),
            ticker: tk,
            nativeCurrency: nativeCcy,
            shares: Number(ord.shares),
            execPriceNative: execPx,
            orderType: "LIMIT",
            limitPrice: limPx,
            scoreVal,
            ratingVal,
            note: String(ord.note || ""),
            nowIso,
            existingOrderId: String(ord.id),
          });
          filledCount += 1;
        } catch {
          // Leave order OPEN if shares insufficient
        }
      }
    }

    const allPfsRes = await client.query<PortfolioRow>("SELECT * FROM paper_portfolios");
    for (const pf of allPfsRes.rows) {
      await recordNavSnapshotInTx(client, universe, pf, existingLive, refreshSnapDate);
      snapshottedCount += 1;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return {
    quotes_updated: toUpsert.length,
    orders_filled: filledCount,
    portfolios_snapshotted: snapshottedCount,
    as_of_date: refreshSnapDate,
  };
}

export async function refreshUserPaperQuotesAndOrders(
  user: VerifiedPaperUser,
  portfolioId?: string | null,
  reqUrl?: string,
): Promise<Record<string, unknown>> {
  const db = resolveDbConnection();
  const universe = await loadStockUniverse(reqUrl);
  const cleanPfId = (portfolioId ?? "").trim() || null;

  if (cleanPfId) {
    const owned = await db.sql<{ id: string }>`
      SELECT id FROM paper_portfolios
      WHERE id = ${cleanPfId} AND user_id = ${user.id}
    `;
    if (owned.length === 0) {
      throw new PaperServiceError("Paper portfolio not found.", 404);
    }
  }

  const userPfs = await db.sql<{ id: string; benchmark_ticker: string }>`
    SELECT id, benchmark_ticker FROM paper_portfolios WHERE user_id = ${user.id}
  `;
  const tracked = new Set<string>(BENCHMARK_SYMBOLS);
  for (const r of userPfs) {
    if (r.benchmark_ticker) tracked.add(String(r.benchmark_ticker));
  }

  if (userPfs.length > 0) {
    const [posTks, ordTks] = await Promise.all([
      db.sql<{ ticker: string }>`
        SELECT DISTINCT p.ticker
        FROM paper_positions p
        JOIN paper_portfolios pf ON pf.id = p.portfolio_id
        WHERE pf.user_id = ${user.id} AND p.shares > 0
      `,
      db.sql<{ ticker: string }>`
        SELECT DISTINCT ticker
        FROM paper_orders
        WHERE user_id = ${user.id} AND status = 'OPEN'
      `,
    ]);
    for (const r of posTks) if (r.ticker) tracked.add(String(r.ticker));
    for (const r of ordTks) if (r.ticker) tracked.add(String(r.ticker));
  }

  const sortedTickers = Array.from(tracked).sort();
  const fetched = await fetchYahooChartQuotes(sortedTickers);
  const existingLive = await fetchLiveQuotesMap(db);
  const nowIso = utcNowIso();

  const toUpsert: LiveQuoteRow[] = [];
  for (const sym of sortedTickers) {
    const hit = fetched.get(sym);
    if (hit) {
      toUpsert.push({ ...hit, updated_at: nowIso });
      continue;
    }
    if (!existingLive.has(sym)) {
      const base = getBaselinePrice(universe, sym);
      if (base.close_price > 0) {
        toUpsert.push({
          ticker: sym,
          close_price: base.close_price,
          day_low: base.close_price,
          day_high: base.close_price,
          trade_date: base.trade_date,
          updated_at: nowIso,
        });
      }
    }
  }

  let refreshSnapDate = utcTodayStr();
  const fetchedDates = Array.from(fetched.values()).map((q) => q.trade_date).filter(Boolean).sort();
  if (fetchedDates.length > 0) {
    refreshSnapDate = fetchedDates[fetchedDates.length - 1];
  }

  const filledOrders: Record<string, unknown>[] = [];
  const client = await connectPoolClient(db);
  try {
    await client.query("BEGIN");
    for (const q of toUpsert) {
      await client.query(
        `INSERT INTO paper_live_quotes (ticker, close_price, day_low, day_high, trade_date, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (ticker) DO UPDATE SET
           close_price = EXCLUDED.close_price,
           day_low = EXCLUDED.day_low,
           day_high = EXCLUDED.day_high,
           trade_date = EXCLUDED.trade_date,
           updated_at = EXCLUDED.updated_at`,
        [q.ticker, q.close_price, q.day_low, q.day_high, q.trade_date, nowIso],
      );
      existingLive.set(q.ticker, q);
    }

    const openRes = await client.query<OrderRow>(
      `SELECT * FROM paper_orders
       WHERE user_id = $1 AND status = 'OPEN' AND order_type = 'LIMIT'
       ORDER BY created_at ASC, id ASC
       FOR UPDATE`,
      [user.id],
    );

    for (const ord of openRes.rows) {
      const tk = String(ord.ticker);
      const limPx = Number(ord.limit_price || 0);
      if (limPx <= 0) continue;

      const q = getQuoteSnapshot(universe, tk, existingLive);
      if (q.close_price <= 0) continue;

      const pfRes = await client.query<PortfolioRow>(
        "SELECT * FROM paper_portfolios WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [ord.portfolio_id, user.id],
      );
      const pf = pfRes.rows[0];
      if (!pf) continue;

      const meta = universe.stocks[tk];
      const nativeCcy = meta?.currency || (tk.endsWith(".NS") || tk.endsWith(".BO") ? "INR" : "USD");
      const preset = String(pf.strategy_preset || "qglp_compounder");
      const { score: curScore, rating: curRating } = getScoreAndRating(universe, tk, preset);
      const scoreVal = ord.score_at_order !== null ? Number(ord.score_at_order) : curScore;
      const ratingVal = String(ord.rating_at_order || curRating);

      if (String(ord.side) === "BUY" && q.day_low <= limPx + 1e-9) {
        const execPx = roundTo(Math.min(q.close_price, limPx), 2);
        const res = await executeBuyFillInTx({
          client,
          portfolio: pf,
          userId: user.id,
          ticker: tk,
          nativeCurrency: nativeCcy,
          shares: Number(ord.shares),
          execPriceNative: execPx,
          orderType: "LIMIT",
          limitPrice: limPx,
          scoreVal,
          ratingVal,
          note: String(ord.note || ""),
          nowIso,
          existingOrderId: String(ord.id),
          releasedReservation: Number(ord.reserved_amount || 0),
        });
        filledOrders.push(res.order);
      } else if (String(ord.side) === "SELL" && q.day_high + 1e-9 >= limPx) {
        const execPx = roundTo(Math.max(q.close_price, limPx), 2);
        try {
          const res = await executeSellFillInTx({
            client,
            portfolio: pf,
            userId: user.id,
            ticker: tk,
            nativeCurrency: nativeCcy,
            shares: Number(ord.shares),
            execPriceNative: execPx,
            orderType: "LIMIT",
            limitPrice: limPx,
            scoreVal,
            ratingVal,
            note: String(ord.note || ""),
            nowIso,
            existingOrderId: String(ord.id),
          });
          filledOrders.push(res.order);
        } catch {
          // Leave order OPEN if shares insufficient
        }
      }
    }

    const userPfRows = await client.query<PortfolioRow>(
      "SELECT * FROM paper_portfolios WHERE user_id = $1",
      [user.id],
    );
    for (const pf of userPfRows.rows) {
      await recordNavSnapshotInTx(client, universe, pf, existingLive, refreshSnapDate);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const overview = await getPaperOverview(user, cleanPfId, reqUrl);
  return {
    ...overview,
    status: "ok",
    quotes_updated: toUpsert.length,
    orders_filled: filledOrders.length,
    filled_orders: filledOrders,
    as_of_date: refreshSnapDate,
    refresh_summary: {
      quotes_updated: toUpsert.length,
      orders_filled: filledOrders.length,
      filled_orders: filledOrders,
      as_of_date: refreshSnapDate,
    },
  };
}
