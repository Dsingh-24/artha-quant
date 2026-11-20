import { getStore } from "@netlify/blobs";
import {
  BENCHMARK_SYMBOLS,
  computeMarketSessionStatus,
  fetchYahooChartQuotes,
  FX_USD_INR_SYMBOL,
  isIndianTicker,
  loadStockUniverse,
  matchesMarketScope,
  normalizeMarketScope,
  type PaperMarketScope,
  USD_INR_FX,
} from "./paper-pg-service.mts";

export const MARKET_PRICES_STORE_NAME = "arthaquant-market-prices";
export const MARKET_PRICES_BLOB_KEY = "latest-v1";

const SPARK_CHUNK_SIZE = 20;
const SPARK_CONCURRENCY = 8;
const SPARK_TIMEOUT_MS = 8_000;
const MAX_CHART_FALLBACK_SYMBOLS = 40;
const FORCE_REFRESH_COOLDOWN_SECONDS = 60;
const OPEN_SESSION_STALE_SECONDS = 900;
const WEEKDAY_IDLE_STALE_SECONDS = 43_200;

export interface LiveUniversePricesPayload {
  schema: "arthaquant.live_prices.v1";
  as_of_date: string;
  in_as_of: string;
  us_as_of: string;
  updated_at: string;
  stock_count: number;
  prices: Record<string, number>;
}

export interface SparkQuoteSummary {
  close_price: number;
  trade_date: string;
}

interface YahooSparkResponse {
  spark?: {
    result?: Array<{
      symbol?: string;
      response?: Array<{
        meta?: {
          symbol?: string;
          regularMarketPrice?: number;
          regularMarketTime?: number;
          gmtoffset?: number;
        };
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            close?: Array<number | null>;
          }>;
        };
      }>;
    }>;
  };
}

let inMemoryPricesCache: LiveUniversePricesPayload | null = null;

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

function isIsoDate(val: unknown): val is string {
  return typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

function isValidPricesPayload(raw: unknown): raw is LiveUniversePricesPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const candidate = raw as Partial<LiveUniversePricesPayload>;
  return (
    candidate.schema === "arthaquant.live_prices.v1" &&
    typeof candidate.as_of_date === "string" &&
    typeof candidate.updated_at === "string" &&
    Boolean(candidate.prices) &&
    typeof candidate.prices === "object" &&
    !Array.isArray(candidate.prices) &&
    Object.keys(candidate.prices).length > 0
  );
}

async function readPricesBlob(): Promise<LiveUniversePricesPayload | null> {
  try {
    const store = getStore(MARKET_PRICES_STORE_NAME);
    const hit = (await store.get(MARKET_PRICES_BLOB_KEY, { type: "json" })) as unknown;
    if (isValidPricesPayload(hit)) {
      inMemoryPricesCache = hit;
      return hit;
    }
    return null;
  } catch {
    return inMemoryPricesCache;
  }
}

async function writePricesBlob(payload: LiveUniversePricesPayload): Promise<void> {
  inMemoryPricesCache = payload;
  try {
    const store = getStore(MARKET_PRICES_STORE_NAME);
    await store.setJSON(MARKET_PRICES_BLOB_KEY, payload);
  } catch {
    // Graceful fallback to in-memory cache when running outside Netlify Blobs runtime
  }
}

async function fetchSparkChunkWithFallback(chunk: string[]): Promise<YahooSparkResponse | null> {
  const encoded = chunk.map((sym) => encodeURIComponent(sym)).join(",");
  const hosts = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

  for (const host of hosts) {
    const url = `${host}/v7/finance/spark?symbols=${encoded}&range=5d&interval=1d`;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(SPARK_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const parsed = (await res.json()) as YahooSparkResponse;
      if (parsed && parsed.spark && Array.isArray(parsed.spark.result)) {
        return parsed;
      }
    } catch {
      // Try fallback host
    }
  }

  return null;
}

export async function fetchYahooSparkBatchPrices(
  tickers: string[],
): Promise<Map<string, SparkQuoteSummary>> {
  const unique = Array.from(
    new Set(tickers.map((t) => String(t || "").trim()).filter(Boolean)),
  );
  const out = new Map<string, SparkQuoteSummary>();
  if (unique.length === 0) return out;

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += SPARK_CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + SPARK_CHUNK_SIZE));
  }

  let cursor = 0;
  const workerCount = Math.min(SPARK_CONCURRENCY, chunks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor];
      cursor += 1;
      const sparkPayload = await fetchSparkChunkWithFallback(chunk);
      const results = sparkPayload?.spark?.result ?? [];

      for (const item of results) {
        const r0 = item?.response?.[0];
        const sym = String(item?.symbol || r0?.meta?.symbol || "").trim();
        if (!sym || !r0) continue;

        const gmtOffsetSec = Number(r0.meta?.gmtoffset ?? 0);
        const timestamps = r0.timestamp ?? [];
        const closes = r0.indicators?.quote?.[0]?.close ?? [];

        let barClose = 0;
        let barTs: number | null = null;
        let barTradeDate = "";
        for (let idx = timestamps.length - 1; idx >= 0; idx -= 1) {
          const cRaw = closes[idx];
          const tsRaw = Number(timestamps[idx]);
          if (
            cRaw === null ||
            cRaw === undefined ||
            !Number.isFinite(cRaw) ||
            cRaw <= 0 ||
            !Number.isFinite(tsRaw)
          ) {
            continue;
          }
          barClose = cRaw;
          barTs = tsRaw;
          barTradeDate = new Date((tsRaw + gmtOffsetSec) * 1000).toISOString().slice(0, 10);
          break;
        }

        const regPx = Number(r0.meta?.regularMarketPrice ?? 0);
        const regTs = Number(r0.meta?.regularMarketTime ?? 0);

        if (
          Number.isFinite(regPx) &&
          regPx > 0 &&
          (barTs === null || regTs === 0 || regTs >= barTs - 3600)
        ) {
          const baseEpochSec =
            regTs > 0 && Number.isFinite(regTs)
              ? regTs
              : barTs !== null
                ? barTs
                : Math.floor(Date.now() / 1000);
          const regTradeDate = new Date((baseEpochSec + gmtOffsetSec) * 1000)
            .toISOString()
            .slice(0, 10);
          out.set(sym, {
            close_price: roundTo(regPx, 2),
            trade_date: regTradeDate,
          });
        } else if (barTs !== null && barClose > 0) {
          out.set(sym, {
            close_price: roundTo(barClose, 2),
            trade_date: barTradeDate,
          });
        }
      }
    }
  });

  await Promise.allSettled(workers);

  const missingAll = unique.filter((tk) => !out.has(tk));
  if (missingAll.length > 0) {
    const priorityBenchmarks = new Set<string>(BENCHMARK_SYMBOLS);
    const missingSymbols = [
      ...missingAll.filter((tk) => priorityBenchmarks.has(tk)),
      ...missingAll.filter((tk) => !priorityBenchmarks.has(tk)),
    ].slice(0, MAX_CHART_FALLBACK_SYMBOLS);

    const fallbackQuotes = await fetchYahooChartQuotes(missingSymbols);
    for (const [sym, q] of fallbackQuotes.entries()) {
      if (q && Number.isFinite(q.close_price) && q.close_price > 0) {
        out.set(sym, {
          close_price: roundTo(q.close_price, 2),
          trade_date: q.trade_date,
        });
      }
    }
  }

  return out;
}

export async function refreshUniversePricesBlob(
  scope: PaperMarketScope = "ALL",
  reqUrl?: string,
): Promise<LiveUniversePricesPayload> {
  const effScope = normalizeMarketScope(scope);
  const universe = await loadStockUniverse(reqUrl);

  const targetTickersSet = new Set<string>();
  for (const tk of Object.keys(universe.stocks)) {
    if (matchesMarketScope(tk, effScope)) {
      targetTickersSet.add(tk);
    }
  }
  for (const bm of BENCHMARK_SYMBOLS) {
    if (bm === FX_USD_INR_SYMBOL || matchesMarketScope(bm, effScope)) {
      targetTickersSet.add(bm);
    }
  }
  targetTickersSet.add(FX_USD_INR_SYMBOL);

  const fetched = await fetchYahooSparkBatchPrices(Array.from(targetTickersSet));
  const existing = await readPricesBlob();

  const prices: Record<string, number> = {};
  for (const [tk, entry] of Object.entries(universe.stocks)) {
    if (typeof entry.last_price === "number" && Number.isFinite(entry.last_price) && entry.last_price > 0) {
      prices[tk] = roundTo(entry.last_price, 2);
    }
  }
  if (universe.benchmarks) {
    for (const [bm, px] of Object.entries(universe.benchmarks)) {
      if (typeof px === "number" && Number.isFinite(px) && px > 0) {
        prices[bm] = roundTo(px, 2);
      }
    }
  }
  if (!prices[FX_USD_INR_SYMBOL]) {
    prices[FX_USD_INR_SYMBOL] = roundTo(USD_INR_FX, 2);
  }

  if (existing && isValidPricesPayload(existing)) {
    for (const [tk, px] of Object.entries(existing.prices)) {
      const numPx = Number(px);
      if (Number.isFinite(numPx) && numPx > 0) {
        prices[tk] = roundTo(numPx, 2);
      }
    }
  }

  const baseAsOf = isIsoDate(universe.as_of_date) ? universe.as_of_date : utcTodayStr();
  let inAsOf = isIsoDate(existing?.in_as_of)
    ? existing.in_as_of
    : isIsoDate(existing?.as_of_date)
      ? existing.as_of_date
      : baseAsOf;
  let usAsOf = isIsoDate(existing?.us_as_of)
    ? existing.us_as_of
    : isIsoDate(existing?.as_of_date)
      ? existing.as_of_date
      : baseAsOf;

  let maxInDate = "";
  let maxUsDate = "";
  for (const [tk, quote] of fetched.entries()) {
    if (!Number.isFinite(quote.close_price) || quote.close_price <= 0) continue;
    prices[tk] = roundTo(quote.close_price, 2);
    if (!isIsoDate(quote.trade_date)) continue;
    if (tk === FX_USD_INR_SYMBOL) continue;

    if (isIndianTicker(tk)) {
      if (quote.trade_date > maxInDate) maxInDate = quote.trade_date;
    } else if (quote.trade_date > maxUsDate) {
      maxUsDate = quote.trade_date;
    }
  }

  if (maxInDate && maxInDate > inAsOf) {
    inAsOf = maxInDate;
  } else if (maxInDate && !existing?.in_as_of) {
    inAsOf = maxInDate;
  }

  if (maxUsDate && maxUsDate > usAsOf) {
    usAsOf = maxUsDate;
  } else if (maxUsDate && !existing?.us_as_of) {
    usAsOf = maxUsDate;
  }

  const asOfDate = inAsOf >= usAsOf ? inAsOf : usAsOf;
  const payload: LiveUniversePricesPayload = {
    schema: "arthaquant.live_prices.v1",
    as_of_date: asOfDate,
    in_as_of: inAsOf,
    us_as_of: usAsOf,
    updated_at: utcNowIso(),
    stock_count: Object.keys(prices).length,
    prices,
  };

  await writePricesBlob(payload);
  return payload;
}

export async function getOrRefreshUniversePricesBlob(opts?: {
  reqUrl?: string;
  forceRefresh?: boolean;
}): Promise<LiveUniversePricesPayload> {
  const existing = await readPricesBlob();
  if (!existing || existing.schema !== "arthaquant.live_prices.v1") {
    return await refreshUniversePricesBlob("ALL", opts?.reqUrl);
  }

  const nowUtc = new Date();
  const updatedMs = Date.parse(String(existing.updated_at || ""));
  const ageSeconds = Number.isFinite(updatedMs)
    ? Math.max(0, (nowUtc.getTime() - updatedMs) / 1000)
    : Number.POSITIVE_INFINITY;

  if (opts?.forceRefresh) {
    if (ageSeconds < FORCE_REFRESH_COOLDOWN_SECONDS) {
      return existing;
    }
    return await refreshUniversePricesBlob("ALL", opts?.reqUrl);
  }

  const session = computeMarketSessionStatus(nowUtc);
  const utcDay = nowUtc.getUTCDay();
  const isWeekday = utcDay >= 1 && utcDay <= 5;

  try {
    if (session.in_market_open && ageSeconds >= OPEN_SESSION_STALE_SECONDS) {
      return await refreshUniversePricesBlob("IN", opts?.reqUrl);
    }
    if (session.us_market_open && ageSeconds >= OPEN_SESSION_STALE_SECONDS) {
      return await refreshUniversePricesBlob("US", opts?.reqUrl);
    }
    if (isWeekday && ageSeconds >= WEEKDAY_IDLE_STALE_SECONDS) {
      return await refreshUniversePricesBlob("ALL", opts?.reqUrl);
    }
  } catch (err) {
    console.warn("[market-prices-service] Background staleness refresh failed, serving cached blob:", err);
  }

  return existing;
}
