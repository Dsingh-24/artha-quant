import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";
import OpenAI from "openai";

interface CompactFiscalYear {
  fy: number;
  rev: number | null;
  ebitda: number | null;
  pat: number | null;
  cfo: number | null;
  fcf: number | null;
  debt: number | null;
  equity: number | null;
  shares: number | null;
  roce_pct: number | null;
  roe_pct: number | null;
  opm_pct: number | null;
  de: number | null;
  cfo_ebitda_pct: number | null;
}

interface CompactQuarterlySignal {
  latest_qtr_label: string;
  ttm_rev: number | null;
  ttm_pat: number | null;
  qtr_rev_yoy_pct: number | null;
  qtr_pat_yoy_pct: number | null;
  qtr_opm_delta_pct: number | null;
  gnpa_pct: number | null;
  nnpa_pct: number | null;
}

interface CompactStreetSignal {
  analyst_count: number;
  consensus_buy_pct: number | null;
  recommendation_key: string;
  target_mean_price: number | null;
  target_high_price: number | null;
  target_low_price: number | null;
  forward_pe: number | null;
  fwd_eps_growth_fy1_pct: number | null;
  fwd_eps_growth_fy2_pct: number | null;
  rev_breadth_pct: number | null;
  inst_held_pct: number | null;
}

interface StockContextEntry {
  name: string;
  sector: string;
  industry: string;
  market: string;
  index_tag: string;
  currency: string;
  is_financial?: boolean;
  business_summary: string;
  last_price: number | null;
  latest_fundamentals: CompactFiscalYear[];
  quarterly_signal: CompactQuarterlySignal | null;
  street_signal: CompactStreetSignal | null;
}

interface StockAiContextPayload {
  as_of_date: string;
  stock_count: number;
  stocks: Record<string, StockContextEntry>;
}

interface ValidatedScoreSummary {
  preset: string;
  composite_score?: number;
  quality_score?: number;
  growth_score?: number;
  value_score?: number;
  momentum_score?: number;
  rank?: number;
}

interface AiMemoPayload {
  available: true;
  cached: boolean;
  ticker: string;
  company_name: string;
  as_of_date: string;
  model_used: string;
  headline: string;
  business_overview: string;
  why_score_lands_here: string;
  key_risks_to_watch: string;
  bottom_line_for_investor: string;
}

interface DetailedProvidersResponse {
  providers?: Record<
    string,
    {
      token_env_var?: string;
      url_env_var?: string;
      models?: Record<string, unknown>;
    }
  >;
}

const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

const ALLOWED_PRESETS = new Set<string>([
  "qglp_compounder",
  "coffee_can",
  "magic_formula",
  "artha_blend",
  "value_momentum",
  "street_quant",
]);

const TICKER_FORMAT_RE = /^[A-Z0-9.^&-]{1,20}$/;
const MAX_REQUEST_BYTES = 16_384;
const PROVIDERS_ENDPOINT = "https://api.netlify.com/api/v1/ai-gateway/providers/detailed";
const PROVIDERS_CACHE_TTL_MS = 10 * 60 * 1000;

let cachedStockContext: StockAiContextPayload | null = null;
let cachedProviderCatalog: { fetchedAt: number; geminiModels: string[]; openaiModels: string[] } | null = null;

function readEnv(key: string): string | undefined {
  if (typeof Netlify !== "undefined" && Netlify?.env?.get) {
    const val = Netlify.env.get(key);
    if (val) return val;
  }
  return undefined;
}

function roundNum(val: unknown, digits = 2): number | null {
  if (val === null || val === undefined || val === "") return null;
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function clampFinite(val: unknown, min: number, max: number): number | undefined {
  if (val === null || val === undefined || val === "") return undefined;
  const num = Number(val);
  if (!Number.isFinite(num)) return undefined;
  return Math.min(max, Math.max(min, Math.round(num * 10) / 10));
}

function transformRawMarketSnapshot(snap: Record<string, unknown>): StockAiContextPayload {
  const asOfDate = typeof snap.as_of_date === "string" ? snap.as_of_date : "";
  const stage1Map: Record<string, Record<string, unknown>> = {};
  if (Array.isArray(snap.stage1_funnel)) {
    for (const row of snap.stage1_funnel) {
      if (row && typeof row === "object" && typeof (row as Record<string, unknown>).ticker === "string") {
        const rec = row as Record<string, unknown>;
        stage1Map[rec.ticker as string] = rec;
      }
    }
  }

  const fundByTicker: Record<string, Record<string, unknown>[]> = {};
  if (Array.isArray(snap.fundamentals)) {
    for (const row of snap.fundamentals) {
      if (row && typeof row === "object" && typeof (row as Record<string, unknown>).ticker === "string") {
        const rec = row as Record<string, unknown>;
        const sym = rec.ticker as string;
        if (!fundByTicker[sym]) fundByTicker[sym] = [];
        fundByTicker[sym].push(rec);
      }
    }
  }

  const qtrMap = (snap.quarterly_signals && typeof snap.quarterly_signals === "object"
    ? snap.quarterly_signals
    : {}) as Record<string, Record<string, unknown>>;
  const streetMap = (snap.street_signals && typeof snap.street_signals === "object"
    ? snap.street_signals
    : {}) as Record<string, Record<string, unknown>>;
  const pricesMap = (snap.prices && typeof snap.prices === "object" ? snap.prices : {}) as Record<
    string,
    Array<number | null>
  >;

  const stocks: Record<string, StockContextEntry> = {};
  const companies = Array.isArray(snap.companies) ? snap.companies : [];
  for (const rawComp of companies) {
    if (!rawComp || typeof rawComp !== "object") continue;
    const comp = rawComp as Record<string, unknown>;
    const ticker = typeof comp.ticker === "string" ? comp.ticker : "";
    if (!ticker) continue;

    const s1 = stage1Map[ticker] ?? {};
    let lastPrice = roundNum(s1.last_price, 2);
    if (lastPrice === null && Array.isArray(pricesMap[ticker])) {
      const series = pricesMap[ticker];
      for (let idx = series.length - 1; idx >= 0; idx -= 1) {
        if (series[idx] !== null && series[idx] !== undefined) {
          lastPrice = roundNum(series[idx], 2);
          break;
        }
      }
    }

    const frows = (fundByTicker[ticker] ?? [])
      .slice()
      .sort((a, b) => Number(a.fiscal_year ?? 0) - Number(b.fiscal_year ?? 0))
      .slice(-5)
      .map((r) => ({
        fy: Number(r.fiscal_year ?? 0),
        rev: roundNum(r.revenue_cr, 1),
        ebitda: roundNum(r.ebitda_cr, 1),
        pat: roundNum(r.net_profit_cr, 1),
        cfo: roundNum(r.cfo_cr, 1),
        fcf: roundNum(r.fcf_cr, 1),
        debt: roundNum(r.total_debt_cr, 1),
        equity: roundNum(r.total_equity_cr, 1),
        shares: roundNum(r.shares_cr, 3),
        roce_pct: roundNum(r.roce_pct, 1),
        roe_pct: roundNum(r.roe_pct, 1),
        opm_pct: roundNum(r.op_margin_pct, 1),
        de: roundNum(r.debt_to_equity, 2),
        cfo_ebitda_pct: roundNum(r.cfo_to_ebitda_pct, 1),
      }));

    const qraw = qtrMap[ticker];
    const sraw = streetMap[ticker];

    stocks[ticker] = {
      name: typeof comp.name === "string" ? comp.name : ticker,
      sector: typeof comp.sector === "string" ? comp.sector : String(s1.sector ?? ""),
      industry:
        typeof comp.industry === "string" && comp.industry
          ? comp.industry
          : String(s1.industry ?? comp.sector ?? ""),
      market: typeof comp.market === "string" ? comp.market : String(s1.market ?? "IN"),
      index_tag: typeof comp.index_tag === "string" ? comp.index_tag : String(s1.index_tag ?? ""),
      currency: typeof comp.currency === "string" ? comp.currency : String(s1.currency ?? "INR"),
      is_financial: Boolean(comp.is_financial),
      business_summary: typeof comp.business_summary === "string" ? comp.business_summary : "",
      last_price: lastPrice,
      latest_fundamentals: frows,
      quarterly_signal: qraw
        ? {
            latest_qtr_label: String(qraw.latest_qtr_label ?? ""),
            ttm_rev: roundNum(qraw.ttm_rev_cr, 1),
            ttm_pat: roundNum(qraw.ttm_pat_cr, 1),
            qtr_rev_yoy_pct: roundNum(qraw.qtr_rev_yoy_pct, 1),
            qtr_pat_yoy_pct: roundNum(qraw.qtr_pat_yoy_pct, 1),
            qtr_opm_delta_pct: roundNum(qraw.qtr_opm_delta_pct, 1),
            gnpa_pct: roundNum(qraw.gnpa_pct, 2),
            nnpa_pct: roundNum(qraw.nnpa_pct, 2),
          }
        : null,
      street_signal: sraw
        ? {
            analyst_count: Number(sraw.analyst_count ?? 0),
            consensus_buy_pct: roundNum(sraw.consensus_buy_pct, 1),
            recommendation_key: String(sraw.recommendation_key ?? ""),
            target_mean_price: roundNum(sraw.target_mean_price, 2),
            target_high_price: roundNum(sraw.target_high_price, 2),
            target_low_price: roundNum(sraw.target_low_price, 2),
            forward_pe: roundNum(sraw.forward_pe, 1),
            fwd_eps_growth_fy1_pct: roundNum(sraw.fwd_eps_growth_fy1_pct, 1),
            fwd_eps_growth_fy2_pct: roundNum(sraw.fwd_eps_growth_fy2_pct, 1),
            rev_breadth_pct: roundNum(sraw.rev_breadth_pct, 1),
            inst_held_pct: roundNum(sraw.inst_held_pct, 1),
          }
        : null,
    };
  }

  return {
    as_of_date: asOfDate,
    stock_count: Object.keys(stocks).length,
    stocks,
  };
}

async function loadStockContext(reqUrl: string): Promise<StockAiContextPayload> {
  if (cachedStockContext && cachedStockContext.stock_count > 0) {
    return cachedStockContext;
  }

  const candidatePaths: string[] = [
    path.resolve(process.cwd(), "netlify/functions/data/stock_ai_context.json"),
  ];
  try {
    candidatePaths.push(fileURLToPath(new URL("./data/stock_ai_context.json", import.meta.url)));
  } catch {
    // Ignore URL resolution differences under bundlers
  }

  for (const filePath of candidatePaths) {
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as StockAiContextPayload;
      if (parsed && parsed.stocks && Object.keys(parsed.stocks).length > 0) {
        cachedStockContext = parsed;
        return parsed;
      }
    } catch {
      // Try next candidate path
    }
  }

  // Fallback: fetch static market_snapshot.json over same-origin CDN
  const snapshotUrl = new URL("/static/data/market_snapshot.json", reqUrl);
  const res = await fetch(snapshotUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Unable to load stock universe context (status ${res.status}).`);
  }
  const rawSnap = (await res.json()) as Record<string, unknown>;
  cachedStockContext = transformRawMarketSnapshot(rawSnap);
  return cachedStockContext;
}

function isNonTextModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("image") ||
    lower.includes("banana") ||
    lower.includes("customtools") ||
    lower.includes("codex") ||
    lower.includes("embedding") ||
    lower.includes("audio") ||
    lower.includes("tts") ||
    lower.includes("whisper") ||
    lower.includes("realtime") ||
    lower.includes("imagen") ||
    lower.includes("veo")
  );
}

function rankGeminiCandidates(liveIds: string[]): string[] {
  const textModels = liveIds.filter((id) => !isNonTextModel(id));
  const preferredOrder = [
    "gemini-3-flash-preview",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
  ];
  const ranked: string[] = [];
  for (const pref of preferredOrder) {
    if (textModels.includes(pref)) ranked.push(pref);
  }
  for (const id of textModels) {
    if (id.includes("flash") && !ranked.includes(id)) {
      ranked.push(id);
    }
  }
  for (const id of textModels) {
    if (!ranked.includes(id)) ranked.push(id);
  }
  return ranked;
}

function rankOpenAiCandidates(liveIds: string[]): string[] {
  const textModels = liveIds.filter((id) => !isNonTextModel(id));
  const preferredOrder = [
    "gpt-5-mini",
    "gpt-5.4-mini",
    "gpt-4.1-mini",
    "gpt-4o-mini",
    "gpt-5-nano",
    "chat-latest",
  ];
  const ranked: string[] = [];
  for (const pref of preferredOrder) {
    if (textModels.includes(pref)) ranked.push(pref);
  }
  for (const id of textModels) {
    if (id.includes("mini") && !ranked.includes(id)) {
      ranked.push(id);
    }
  }
  for (const id of textModels) {
    if (!ranked.includes(id)) ranked.push(id);
  }
  return ranked;
}

async function resolveLiveGatewayModels(): Promise<{ geminiModels: string[]; openaiModels: string[] }> {
  const now = Date.now();
  if (cachedProviderCatalog && now - cachedProviderCatalog.fetchedAt < PROVIDERS_CACHE_TTL_MS) {
    return cachedProviderCatalog;
  }

  try {
    const res = await fetch(PROVIDERS_ENDPOINT, {
      headers: {
        Accept: "application/json",
        "User-Agent": "ArthaQuant-AI-Analyst/3.0",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = (await res.json()) as DetailedProvidersResponse;
      const geminiRaw = Object.keys(data.providers?.gemini?.models ?? {});
      const openaiRaw = Object.keys(data.providers?.openai?.models ?? {});
      const resolved = {
        fetchedAt: now,
        geminiModels: rankGeminiCandidates(geminiRaw),
        openaiModels: rankOpenAiCandidates(openaiRaw),
      };
      if (resolved.geminiModels.length > 0 || resolved.openaiModels.length > 0) {
        cachedProviderCatalog = resolved;
        return resolved;
      }
    }
  } catch (err) {
    console.warn("Live AI Gateway provider lookup failed; falling back to default candidates:", err);
  }

  return {
    geminiModels: ["gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-flash-latest"],
    openaiModels: ["gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"],
  };
}

function buildFactPacketAndPrompt(
  ticker: string,
  entry: StockContextEntry,
  asOfDate: string,
  scoreSummary: ValidatedScoreSummary,
): { systemInstruction: string; userPrompt: string } {
  const isUsd = entry.currency === "USD" || entry.market === "US";
  const currSymbol = isUsd ? "$" : "₹";
  const amountUnit = isUsd ? "USD Millions ($M)" : "INR Crores (₹ Cr)";
  const latestFy =
    entry.latest_fundamentals.length > 0
      ? entry.latest_fundamentals[entry.latest_fundamentals.length - 1]
      : null;

  const latestPat = latestFy?.pat ?? null;
  const latestShares = latestFy?.shares ?? null;
  const marketCap =
    entry.last_price !== null && latestShares !== null && latestShares > 0
      ? roundNum(entry.last_price * latestShares, 1)
      : null;
  const ttmPat = entry.quarterly_signal?.ttm_pat ?? latestPat;
  const trailingPe =
    marketCap !== null && ttmPat !== null && ttmPat > 0 ? roundNum(marketCap / ttmPat, 1) : null;

  const cfoToDebtPct =
    latestFy?.cfo !== null &&
    latestFy?.cfo !== undefined &&
    latestFy?.debt !== null &&
    latestFy?.debt !== undefined &&
    latestFy.debt > 0
      ? roundNum((latestFy.cfo / Math.max(1, latestFy.debt)) * 100, 1)
      : null;

  const buybackAccountingNote =
    !entry.is_financial &&
    latestFy &&
    ((latestFy.equity !== null && latestFy.equity <= 0) || (latestFy.de !== null && latestFy.de > 1.8)) &&
    (latestFy.pat ?? 0) > 0 &&
    (latestFy.cfo ?? 0) > 0 &&
    (cfoToDebtPct ?? 0) >= 35 &&
    (latestFy.roce_pct ?? 0) >= 18
      ? "Shareholder equity on paper is low/negative mainly because of years of share buybacks, NOT financial distress — annual operating cash flow comfortably covers debt."
      : null;

  const verifiedFacts = {
    ticker,
    company_name: entry.name,
    as_of_date: asOfDate,
    market_origin: isUsd ? `US Stock (${entry.index_tag || "US"})` : `Indian Stock (${entry.index_tag || "NSE"})`,
    sector: entry.sector,
    industry: entry.industry,
    is_financial_institution: Boolean(entry.is_financial),
    business_description: entry.business_summary || `${entry.name} operates in ${entry.industry || entry.sector}.`,
    currency_symbol: currSymbol,
    financial_statement_unit: amountUnit,
    current_share_price: entry.last_price !== null ? `${currSymbol}${entry.last_price}` : "Unavailable",
    estimated_market_value: marketCap !== null ? `${marketCap} ${amountUnit}` : "Unavailable",
    price_to_annual_profit_multiple:
      trailingPe !== null
        ? `${trailingPe}x trailing annual profit`
        : ttmPat !== null && ttmPat <= 0
          ? "Currently unprofitable (cannot be valued on current profits)"
          : "Unavailable",
    accounting_context_note: buybackAccountingNote,
    annual_financial_history_5y: entry.latest_fundamentals.map((fy) => ({
      fiscal_year: fy.fy,
      annual_sales: fy.rev,
      net_profit: fy.pat,
      operating_cash_flow: fy.cfo,
      free_cash_flow: fy.fcf,
      total_debt: fy.debt,
      book_equity: fy.equity,
      profit_per_100_invested_pct: entry.is_financial ? fy.roe_pct : fy.roce_pct,
      operating_profit_margin_pct: fy.opm_pct,
    })),
    latest_quarterly_update: entry.quarterly_signal,
    covering_analyst_consensus: entry.street_signal,
    screener_score_snapshot: scoreSummary,
  };

  const systemInstruction = [
    "You are ArthaQuant's Plain-English Investment Educator writing a custom deep-dive memo for an everyday long-term investor.",
    "STRICT WRITING RULES:",
    "1. ZERO unexplained Wall Street acronyms: NEVER write raw jargon like 'ROCE', 'EBITDA', 'PAT', 'CFO/EBITDA', 'PEG', 'GARP', 'EV/EBITDA', 'Piotroski', 'NNPA', or 'EPS breadth'. Translate every metric into clear everyday money terms (for example: 'earns $28 in annual profit for every $100 invested in the business', 'turns most of its reported profit into real cash in the bank', 'trades at 31 times annual profit').",
    "2. STRICT FACTUALITY: Use ONLY the verified numbers in the provided JSON packet. Never invent revenue numbers, dates, or ratios. If a company is unprofitable, explicitly say it is currently unprofitable and never cite a fake P/E number.",
    "3. ARCHETYPE AWARENESS: For banks/lenders, discuss return on shareholder equity and loan quality rather than corporate debt-to-equity or operating cash conversion. If accounting_context_note mentions share buybacks, explain clearly why book equity looks small on paper.",
    "4. EDUCATIONAL TONE: Be balanced, objective, and calm — highlight both genuine strengths and honest valuation/business risks without giving personalized financial advice.",
    "5. OUTPUT FORMAT: Return ONLY a valid JSON object with exact string keys: headline, business_overview, why_score_lands_here, key_risks_to_watch, bottom_line_for_investor.",
  ].join("\n");

  const userPrompt = [
    `Write a plain-English analyst memo for ${entry.name} (${ticker}) using ONLY these verified facts:`,
    JSON.stringify(verifiedFacts),
    "",
    "Return strict JSON matching this exact shape (every value must be a single plain-English string):",
    JSON.stringify({
      headline: "One crisp plain-English sentence (under 140 chars) summarizing business quality and current stock price.",
      business_overview: "2 to 3 plain-English sentences explaining how the company makes money and how healthy its cash flow and balance sheet are.",
      why_score_lands_here: "2 to 3 plain-English sentences using the verified numbers to explain what drives its score up and what holds it back (especially valuation vs growth).",
      key_risks_to_watch: "2 to 3 plain-English sentences on realistic valuation, competition, debt, or industry-cycle risks to monitor.",
      bottom_line_for_investor: "1 to 2 plain-English takeaway sentences for a patient everyday investor.",
    }),
  ].join("\n");

  return { systemInstruction, userPrompt };
}

function parseModelJsonMemo(rawText: string): {
  headline: string;
  business_overview: string;
  why_score_lands_here: string;
  key_risks_to_watch: string;
  bottom_line_for_investor: string;
} | null {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const coerceField = (val: unknown): string => {
    if (typeof val === "string") return val.trim();
    if (Array.isArray(val)) return val.map((item) => String(item).trim()).filter(Boolean).join(" ");
    return "";
  };

  const headline = coerceField(parsed.headline);
  const business_overview = coerceField(parsed.business_overview);
  const why_score_lands_here = coerceField(parsed.why_score_lands_here);
  const key_risks_to_watch = coerceField(parsed.key_risks_to_watch);
  const bottom_line_for_investor = coerceField(parsed.bottom_line_for_investor);

  if (
    !headline ||
    !business_overview ||
    !why_score_lands_here ||
    !key_risks_to_watch ||
    !bottom_line_for_investor
  ) {
    return null;
  }

  return {
    headline,
    business_overview,
    why_score_lands_here,
    key_risks_to_watch,
    bottom_line_for_investor,
  };
}

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method !== "POST") {
    return Response.json(
      { available: false, error: "Method not allowed. Use POST.", reason: "Method not allowed." },
      { status: 405, headers: RESPONSE_HEADERS },
    );
  }

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    return Response.json(
      { available: false, error: "Unable to read request body.", reason: "Unable to read request body." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  if (!rawBody || rawBody.length > MAX_REQUEST_BYTES) {
    return Response.json(
      { available: false, error: "Invalid or oversized request payload.", reason: "Invalid request payload." },
      { status: rawBody.length > MAX_REQUEST_BYTES ? 413 : 400, headers: RESPONSE_HEADERS },
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Body must be a JSON object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json(
      { available: false, error: "Request body must be valid JSON.", reason: "Request body must be valid JSON." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  const ticker = typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
  if (!ticker || !TICKER_FORMAT_RE.test(ticker)) {
    return Response.json(
      { available: false, error: "Invalid ticker symbol format.", reason: "Invalid ticker symbol format." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  let stockContext: StockAiContextPayload;
  try {
    stockContext = await loadStockContext(req.url);
  } catch (err) {
    console.error("Failed to load stock context:", err);
    return Response.json(
      {
        available: false,
        ticker,
        reason: "Stock universe data could not be loaded on the server.",
      },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }

  if (!Object.prototype.hasOwnProperty.call(stockContext.stocks, ticker)) {
    return Response.json(
      {
        available: false,
        ticker,
        error: "Ticker is not in the verified ArthaQuant 707-stock universe.",
        reason: "Ticker is not in the verified ArthaQuant 707-stock universe.",
      },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  const stockEntry = stockContext.stocks[ticker];
  const asOfDate = stockContext.as_of_date || "latest";

  // Extract strictly validated numeric/enum fields only — ignore all arbitrary client text
  const rawPreset = typeof body.preset === "string" ? body.preset.trim().toLowerCase() : "";
  const preset = ALLOWED_PRESETS.has(rawPreset) ? rawPreset : "qglp_compounder";
  const rawSummary =
    body.score_summary && typeof body.score_summary === "object" && !Array.isArray(body.score_summary)
      ? (body.score_summary as Record<string, unknown>)
      : {};
  const validatedSummary: ValidatedScoreSummary = {
    preset,
    composite_score: clampFinite(rawSummary.composite_score, 0, 100),
    quality_score: clampFinite(rawSummary.quality_score, 0, 100),
    growth_score: clampFinite(rawSummary.growth_score, 0, 100),
    value_score: clampFinite(rawSummary.value_score, 0, 100),
    momentum_score: clampFinite(rawSummary.momentum_score, 0, 100),
    rank:
      clampFinite(rawSummary.rank, 1, 1000) !== undefined
        ? Math.round(clampFinite(rawSummary.rank, 1, 1000)!)
        : undefined,
  };

  // 1. Check Netlify Blobs cache isolated by deploy context
  const storeName =
    context?.deploy?.context === "production" ? "artha-ai-memos-prod" : "artha-ai-memos-preview";
  const cacheKey = `v3/${asOfDate}/${ticker}.json`;
  let blobsStore: ReturnType<typeof getStore> | null = null;

  try {
    blobsStore = getStore({ name: storeName, consistency: "strong" });
    const hit = (await blobsStore.get(cacheKey, { type: "json" })) as Partial<AiMemoPayload> | null;
    if (
      hit !== null &&
      typeof hit === "object" &&
      typeof hit.headline === "string" &&
      typeof hit.business_overview === "string" &&
      typeof hit.why_score_lands_here === "string" &&
      typeof hit.key_risks_to_watch === "string" &&
      typeof hit.bottom_line_for_investor === "string"
    ) {
      return Response.json(
        {
          available: true,
          cached: true,
          ticker,
          company_name: hit.company_name || stockEntry.name,
          as_of_date: hit.as_of_date || asOfDate,
          model_used: hit.model_used || "cached",
          headline: hit.headline,
          business_overview: hit.business_overview,
          why_score_lands_here: hit.why_score_lands_here,
          key_risks_to_watch: hit.key_risks_to_watch,
          bottom_line_for_investor: hit.bottom_line_for_investor,
        } satisfies AiMemoPayload,
        { status: 200, headers: RESPONSE_HEADERS },
      );
    }
  } catch (blobErr) {
    console.warn("Netlify Blobs cache read unavailable:", blobErr);
  }

  // 2. Check Netlify AI Gateway injected provider credentials
  const hasGeminiGateway = Boolean(readEnv("GOOGLE_GEMINI_BASE_URL") || readEnv("GEMINI_API_KEY"));
  const hasOpenAiGateway = Boolean(readEnv("OPENAI_BASE_URL") || readEnv("OPENAI_API_KEY"));

  if (!hasGeminiGateway && !hasOpenAiGateway) {
    return Response.json(
      {
        available: false,
        ticker,
        reason:
          "AI Analyst Gateway is not active in this environment — deploy once to Netlify production on a credit-based plan (or run via `netlify dev`).",
      },
      { status: 200, headers: RESPONSE_HEADERS },
    );
  }

  // 3. Dynamically select live fast text models from Netlify AI Gateway catalog
  const { geminiModels, openaiModels } = await resolveLiveGatewayModels();
  const { systemInstruction, userPrompt } = buildFactPacketAndPrompt(
    ticker,
    stockEntry,
    asOfDate,
    validatedSummary,
  );

  let generatedMemo: ReturnType<typeof parseModelJsonMemo> = null;
  let modelUsed = "";
  const errorsEncountered: string[] = [];

  if (hasGeminiGateway && geminiModels.length > 0) {
    // Instantiate official Google GenAI SDK with no args — uses injected GEMINI_API_KEY & GOOGLE_GEMINI_BASE_URL
    const genAI = new GoogleGenAI({});
    for (const candidateModel of geminiModels.slice(0, 2)) {
      try {
        const result = await genAI.models.generateContent({
          model: candidateModel,
          contents: userPrompt,
          config: {
            systemInstruction,
            responseMimeType: "application/json",
            temperature: 0.25,
            maxOutputTokens: 900,
          },
        });
        const text = result.text ?? "";
        const parsed = parseModelJsonMemo(text);
        if (parsed) {
          generatedMemo = parsed;
          modelUsed = candidateModel;
          break;
        }
      } catch (err) {
        errorsEncountered.push(`gemini(${candidateModel}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!generatedMemo && hasOpenAiGateway && openaiModels.length > 0) {
    // Instantiate official OpenAI SDK with no args — uses injected OPENAI_API_KEY & OPENAI_BASE_URL
    const openai = new OpenAI();
    for (const candidateModel of openaiModels.slice(0, 2)) {
      try {
        const completion = await openai.chat.completions.create({
          model: candidateModel,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          max_completion_tokens: 900,
        });
        const text = completion.choices?.[0]?.message?.content ?? "";
        const parsed = parseModelJsonMemo(text);
        if (parsed) {
          generatedMemo = parsed;
          modelUsed = candidateModel;
          break;
        }
      } catch (err) {
        errorsEncountered.push(`openai(${candidateModel}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!generatedMemo) {
    console.error(`AI memo generation failed for ${ticker}:`, errorsEncountered.join(" | "));
    return Response.json(
      {
        available: false,
        ticker,
        reason: "Live AI Analyst memo generation is temporarily unavailable — please try again in a moment.",
      },
      { status: 200, headers: RESPONSE_HEADERS },
    );
  }

  const payload: AiMemoPayload = {
    available: true,
    cached: false,
    ticker,
    company_name: stockEntry.name,
    as_of_date: asOfDate,
    model_used: modelUsed,
    headline: generatedMemo.headline,
    business_overview: generatedMemo.business_overview,
    why_score_lands_here: generatedMemo.why_score_lands_here,
    key_risks_to_watch: generatedMemo.key_risks_to_watch,
    bottom_line_for_investor: generatedMemo.bottom_line_for_investor,
  };

  if (blobsStore) {
    try {
      await blobsStore.setJSON(cacheKey, payload);
    } catch (blobWriteErr) {
      console.warn("Netlify Blobs cache write failed:", blobWriteErr);
    }
  }

  return Response.json(payload, { status: 200, headers: RESPONSE_HEADERS });
};

export const config: Config = {
  path: "/api/ai-memo",
  method: "POST",
  rateLimit: {
    action: "rate_limit",
    aggregateBy: ["ip", "domain"],
    windowSize: 60,
    windowLimit: 8,
  },
};
