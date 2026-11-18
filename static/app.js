// ArthaQuant V4.0 Frontend Controller — Everyday-Investor Plain-English UI,
// Simple / Pro Ratios Toggle, AI Analyst Memo, Multi-Strategy Paper Trading & Installable PWA
// Built exclusively with safe DOM creation (createElement, createElementNS, textContent)
// and CSS class toggling.

import {
  closePaperAuthModal,
  initPaperAuthClient,
  maskUserIdentity,
} from "/static/auth_client.js";
import {
  createConsensusBarSvg,
  createContributionBarSvg,
  createProgressSvg,
  createScoreRingSvg,
  formatCurrencyCompact,
  formatMarketCap,
  formatStockPrice,
  renderMultiLineChart,
} from "/static/charts.js";
import {
  closeAllPaperModals,
  initPaperTradingUI,
  loadPaperOverview,
  openDeployBlueprintModal,
  openPaperOrderTicket,
} from "/static/paper_ui.js";
import {
  getCompanyDetailSnapshot,
  importCsvInMemory,
  runBacktestSnapshot,
  runPlannerSnapshot,
  runScreenerSnapshot,
} from "/static/standalone_engine.js";

const DEFAULT_PRESET_WEIGHTS = {
  qglp_compounder: { quality: 45.0, value: 20.0, growth: 25.0, momentum: 10.0 },
  street_quant: { quality: 35.0, value: 20.0, growth: 25.0, momentum: 20.0 },
  coffee_can: { quality: 55.0, value: 10.0, growth: 30.0, momentum: 5.0 },
  magic_formula: { quality: 45.0, value: 45.0, growth: 5.0, momentum: 5.0 },
  artha_blend: { quality: 35.0, value: 25.0, growth: 20.0, momentum: 20.0 },
  value_momentum: { quality: 10.0, value: 45.0, growth: 5.0, momentum: 40.0 },
};

const PRESET_NAMES = {
  qglp_compounder: "Long-Term QGLP Compounder",
  street_quant: "Street EPS Revisions + Quant Compounder",
  coffee_can: "Marcellus Coffee-Can",
  magic_formula: "Greenblatt Magic Formula",
  artha_blend: "Balanced 4-Factor Blend",
  value_momentum: "AQR Tactical Value + Momentum",
  custom: "Custom Pillar Formula",
};

const state = {
  staticMode: false,
  csrfToken: null,
  needsSetup: false,
  username: null,
  activeTab: "screener",
  proMode: false,
  funnelView: "stage2",
  screenerMarket: "ALL",
  plannerMarket: "ALL",
  backtestMarket: "IN",
  ratingFilter: "ALL",
  stocks: [],
  visibleStocks: [],
  stage1Funnel: [],
  marketCounts: { ALL: 0, IN: 0, US: 0, NASDAQ100: 0, SP500: 0 },
  presetWeightsMap: DEFAULT_PRESET_WEIGHTS,
  selectedTicker: null,
  currentDetail: null,
  currentPlan: null,
  drawerOpen: false,
  backtestLoaded: false,
  plannerLoaded: false,
  deferredInstallPrompt: null,
  iosSafariInstallable: false,
  aiMemoCache: new Map(),
  aiMemoInFlight: new Set(),
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function showToast(message, isError = false) {
  const container = document.getElementById("toast-container");
  const toast = el("div", isError ? "toast toast-error" : "toast", message);
  container.appendChild(toast);
  window.setTimeout(() => {
    toast.remove();
  }, 4600);
}

async function apiRequest(path, options = {}) {
  const method = options.method || "GET";
  const headers = Object.assign({}, options.headers || {});
  if (method === "POST" && state.csrfToken) {
    headers["X-CSRF-Token"] = state.csrfToken;
  }
  if (options.jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const resp = await window.fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: options.jsonBody !== undefined ? JSON.stringify(options.jsonBody) : options.rawBody,
  });

  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("STATIC_HOST_MODE");
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.detail || `Request failed (${resp.status})`);
  }
  return data;
}

function isUsdMarketMode(market) {
  return market === "US" || market === "NASDAQ100" || market === "SP500";
}

function isUSStock(item) {
  if (!item) return false;
  const tag = String(item.index_tag || "").toUpperCase();
  if (tag === "NASDAQ100" || tag === "SP500") return true;
  if (tag === "NIFTY200") return false;
  if (item.market) return item.market === "US";
  if (item.currency) return item.currency === "USD";
  return false;
}

function resolveIndexTag(item) {
  if (!item) return "NIFTY200";
  const tag = String(item.index_tag || "").toUpperCase();
  if (tag === "NASDAQ100" || tag === "SP500" || tag === "NIFTY200") {
    return tag;
  }
  const lbl = String(item.market_label || "").toUpperCase();
  if (lbl.includes("S&P") || lbl.includes("SP500")) return "SP500";
  if (lbl.includes("NASDAQ")) return "NASDAQ100";
  return isUSStock(item) ? "NASDAQ100" : "NIFTY200";
}

function stockCurrency(item) {
  return isUSStock(item) ? "USD" : "INR";
}

function displaySymbol(ticker) {
  return String(ticker || "").replace(".NS", "").replace(".BO", "");
}

function createMarketTag(item) {
  const tag = resolveIndexTag(item);
  if (tag === "NASDAQ100") {
    return el("span", "tag-market tag-market-nasdaq", "US Stock · NASDAQ 100");
  }
  if (tag === "SP500") {
    return el("span", "tag-market tag-market-sp500", "US Stock · S&P 500");
  }
  return el("span", "tag-market tag-market-in", "Indian Stock · NIFTY 200");
}

function formatExactAmount(amount, currency = "INR") {
  const num = Math.round(Number(amount || 0));
  if (currency === "USD") {
    return `$${num.toLocaleString("en-US")}`;
  }
  return `₹${num.toLocaleString("en-IN")}`;
}

function fmtSigned(val, decimals = 1) {
  const n = Number(val || 0);
  const s = n.toFixed(decimals);
  return n > 0 ? `+${s}` : s;
}

function formatPeVsFair(metrics) {
  if (!metrics) return "—";
  const pe = Number(metrics.pe_ratio || 0);
  const fair = Math.round(Number(metrics.fair_pe || 0));
  if (pe >= 99 || pe <= 0) return fair > 0 ? `N/M (Fair ~${fair}x)` : "N/M (Unprofitable)";
  return `${pe.toFixed(1)}x (Fair ~${fair}x)`;
}

function ratingBadgeClass(rating) {
  if (rating === "Strong Buy") return "badge badge-strong-buy";
  if (rating === "Buy") return "badge badge-buy";
  if (rating === "Hold") return "badge badge-hold";
  return "badge badge-avoid";
}

function createValZonePill(zone) {
  const z = String(zone || "Fair GARP Price");
  let cls = "val-zone-pill zone-fair";
  if (z.includes("Undervalued")) cls = "val-zone-pill zone-good";
  else if (z.includes("Overvalued") || z.includes("Unprofitable") || z.includes("Loss")) {
    cls = "val-zone-pill zone-over";
  } else if (z.includes("Rich")) {
    cls = "val-zone-pill zone-rich";
  }
  return el("span", cls, z);
}

function createFriendlyValZonePill(stock, proMode = false) {
  const rawZone = String((stock && stock.valuation_zone) || "Fair GARP Price");
  if (proMode) {
    return createValZonePill(rawZone);
  }
  const m = (stock && stock.metrics) || {};
  const pe = Number(m.pe_ratio || 0);
  const archCode = stock && stock.plain_english ? stock.plain_english.archetype_code : "";
  if (archCode === "loss_turnaround" || pe >= 99 || pe <= 0) {
    return el("span", "val-zone-pill zone-over", "Currently Unprofitable");
  }
  if (rawZone.includes("Undervalued")) {
    return el("span", "val-zone-pill zone-good", "Attractive Bargain Price");
  }
  if (rawZone.includes("Overvalued")) {
    return el("span", "val-zone-pill zone-over", "Expensive Today");
  }
  if (rawZone.includes("Rich")) {
    return el("span", "val-zone-pill zone-rich", "Slightly Expensive");
  }
  return el("span", "val-zone-pill zone-fair", "Fairly Priced Today");
}

function archetypeClass(code) {
  const c = String(code || "");
  if (c === "loss_turnaround") return "archetype-pill arch-turnaround";
  if (c === "financial_lender") return "archetype-pill arch-financial";
  if (c === "buyback_compounder") return "archetype-pill arch-buyback";
  if (c === "regulated_infra") return "archetype-pill arch-infra";
  if (c === "cyclical_commodity") return "archetype-pill arch-cyclical";
  return "archetype-pill arch-secular";
}

function createArchetypePill(pe) {
  const label = (pe && pe.archetype_label) || "Steady Operating Business";
  return el("span", archetypeClass(pe && pe.archetype_code), label);
}

function verdictTagClass(tag) {
  const t = String(tag || "").toLowerCase();
  if (t.includes("standout")) return "verdict-tag-pill vtag-standout";
  if (t.includes("solid")) return "verdict-tag-pill vtag-solid";
  if (t.includes("mixed") || t.includes("fair")) return "verdict-tag-pill vtag-mixed";
  return "verdict-tag-pill vtag-weak";
}

function toneClass(tone) {
  const t = String(tone || "neutral");
  if (t === "good") return "tone-good";
  if (t === "warn") return "tone-warn";
  if (t === "bad") return "tone-bad";
  return "tone-neutral";
}

function formatPlainPenaltyReason(rawReason) {
  const r = String(rawReason || "").trim();
  if (!r) return "Safety caution triggered on recent financial check";

  if (r.includes("Loss-making") || r.includes("PAT <= 0")) {
    return "Unprofitable in the latest year (company reported a net loss)";
  }
  if (r.includes("Inconsistent profitability")) {
    const m = r.match(/\((\d+\/\d+)\s+profitable/);
    return m
      ? `Inconsistent profits — made money in only ${m[1]} recent years`
      : "Inconsistent year-to-year profit track record";
  }
  if (r.includes("sell-side EPS cuts")) {
    const m = r.match(/\((\d+)\s+down\s+vs\s+(\d+)\s+up/);
    return m
      ? `Covering bank analysts recently cut profit forecasts (${m[1]} cuts vs ${m[2]} upgrades)`
      : "Covering bank analysts recently cut their profit forecasts";
  }
  if (r.includes("Negative net worth") || r.includes("eroded book equity")) {
    return "Total liabilities exceed company assets on the balance sheet";
  }
  if (r.includes("High corporate debt load")) {
    const m = r.match(/D\/E\s+([\d.]+)x/);
    return m
      ? `Heavy debt load — total borrowings are ${m[1]}x shareholder equity`
      : "Heavy corporate debt load relative to shareholder equity";
  }
  if (r.includes("cash conversion") || r.includes("CFO/EBITDA")) {
    const m = r.match(/\((\d+%)\s+CFO\/EBITDA\)/);
    return m
      ? `Weak cash collection — only ${m[1]} of operating profit turned into real bank cash`
      : "Weak conversion of reported profits into real bank cash";
  }
  if (r.includes("profit contraction") || r.includes("PAT CAGR")) {
    const m = r.match(/\(([+-]?[\d.]+%)\s+3Y/);
    return m
      ? `Multi-year profit decline (${m[1]} per year over the last 3 years)`
      : "Profits have declined over the past several years";
  }
  if (r.includes("2Q earnings slowdown")) {
    const m = r.match(/\(([+-]?[\d.]+%)\s+YoY PAT,\s*([+-]?[\d.]+%)\s+YoY Sales/);
    return m
      ? `Recent quarterly slowdown (profits ${m[1]}, sales ${m[2]} vs last year)`
      : "Recent quarterly profits slowed down compared to last year";
  }
  if (r.includes("Promoter/Institutional exit")) {
    return "Founders or large institutional funds reduced their stake over the past year";
  }
  if (r.includes("Elevated banking NPAs")) {
    const m = r.match(/Net NPA\s+([\d.]+%)/);
    return m
      ? `Higher unpaid bad loans in the lending book (${m[1]} net bad loans)`
      : "Higher unpaid bad loans in the bank's lending portfolio";
  }
  if (r.includes("Commodity cyclicality risk")) {
    const m = r.match(/swung\s+([^)]+)\)/);
    return m
      ? `Profits swing sharply with commodity prices (returns ranged ${m[1]})`
      : "Profits move up and down sharply with commodity price cycles";
  }
  if (r.includes("Piotroski")) {
    const m = r.match(/\((\d+\/\d+)\)/);
    return m
      ? `Low annual financial safety score (passed only ${m[1]} safety checks)`
      : "Low score on the 9-point annual financial safety checklist";
  }
  if (r.includes("Valuation rich")) {
    if (r.includes("99.9")) {
      return "Currently unprofitable — stock cannot be valued on current profits yet";
    }
    const m = r.match(/at\s+([\d.]+x)\s+P\/E\s+\(Fair\s+~([\d.]+)x/);
    return m
      ? `Stock price looks expensive today at ${m[1]} profits (fair range ~${Math.round(
          Number(m[2])
        )}x) — consider waiting for a dip`
      : "Stock price looks expensive today relative to company growth — consider waiting for a dip";
  }

  return r
    .replace(/\bPAT\b/g, "Net Profit")
    .replace(/\bTTM\b/g, "last 12 months")
    .replace(/\bCFO\/EBITDA\b/g, "cash conversion")
    .replace(/\bROCE\b/g, "return on capital")
    .replace(/\bPiotroski\b/g, "financial safety")
    .replace(/\bD\/E\b/g, "debt-to-equity");
}

function buildFallbackPlainEnglish(sc, comp = {}) {
  const m = (sc && sc.metrics) || {};
  const bd = resolveScoreBreakdown(sc);
  const ccySym = stockCurrency(sc) === "USD" ? "$" : "₹";
  const pe = Number(m.pe_ratio || 0);
  const fairPe = Math.max(8, Math.round(Number(m.fair_pe || 20)));
  const isLoss = pe >= 99 || pe <= 0;
  const isFin = Boolean(sc && sc.is_financial);
  const isBuyback = Boolean(m.buyback_equity);
  const sec = String((sc && sc.sector) || comp.sector || "Operating");

  let archetypeCode = "secular_compounder";
  let archetypeLabel = "Cash-Rich Compounder";
  if (isLoss) {
    archetypeCode = "loss_turnaround";
    archetypeLabel = "Unprofitable / Turnaround";
  } else if (isFin) {
    archetypeCode = "financial_lender";
    archetypeLabel = "Banking & Financial Leader";
  } else if (isBuyback) {
    archetypeCode = "buyback_compounder";
    archetypeLabel = "Share-Buyback Cash Cow";
  } else if (sec === "Power & Energy") {
    archetypeCode = "regulated_infra";
    archetypeLabel = "Regulated Infrastructure";
  } else if (sec.includes("Metals") || sec.includes("Commodit") || sec.includes("Oil")) {
    archetypeCode = "cyclical_commodity";
    archetypeLabel = "Cyclical / Commodity Business";
  }

  const medRet = Math.round(
    Number(m.med_5y_roce_pct !== undefined ? m.med_5y_roce_pct : m.roce_pct || 0)
  );
  const scoreNum = Number((sc && sc.composite_score) || 0);
  let oneLine = "Steady business trading near a reasonable price";
  if (isLoss) {
    oneLine = "Currently unprofitable — waiting for sustainable profit recovery";
  } else if (sc && sc.rating === "Strong Buy") {
    oneLine = isFin
      ? "Consistent financial leader at an attractive valuation"
      : "Strong, cash-generating business at an attractive price";
  } else if (sc && sc.rating === "Buy") {
    oneLine = "Solid business quality with steady growth at a reasonable price";
  } else if (sc && sc.rating === "Hold" && (sc.pillars?.quality || 0) >= 70 && pe > fairPe * 1.25) {
    oneLine = "High-quality business, but the stock price is expensive today";
  } else if (sc && sc.rating === "Avoid") {
    oneLine = "Caution advised — weak profit track record or elevated risk";
  }

  const whatItDoes =
    (comp && comp.business_summary) ||
    `${(sc && sc.name) || "This company"} operates in the ${sec} sector (${
      isUSStock(sc) ? "US equity market" : "Indian NSE market"
    }).`;

  const s1 = isFin
    ? `${sc.name} earns about ${ccySym}${medRet} in annual profit for every ${ccySym}100 of shareholder equity.`
    : isBuyback
    ? `${sc.name} earns ${ccySym}${medRet} per ${ccySym}100 invested; book equity looks small only because of years of share buybacks backed by strong cash flow.`
    : `${sc.name} earns about ${ccySym}${medRet} per ${ccySym}100 invested in the business over a 5-year cycle.`;

  const s2 = isLoss
    ? `Its overall score of ${scoreNum.toFixed(1)} / 100 is held back because the business is currently unprofitable and cannot be valued on current earnings yet.`
    : pe > fairPe * 1.3
    ? `It scored ${scoreNum.toFixed(1)} / 100 mainly because the stock trades at ${pe.toFixed(
        1
      )}x profits versus a fair range near ~${fairPe}x, holding back the price score.`
    : `It earned ${scoreNum.toFixed(1)} / 100 thanks to a balanced mix of business strength and a stock price trading at ${pe.toFixed(
        1
      )}x profits (fair range ~${fairPe}x).`;

  const revCagr = Number(m.rev_cagr_5y_pct || 0).toFixed(1);
  const patCagr = Number(m.pat_cagr_5y_pct || 0).toFixed(1);
  const s3 = `Sales have compounded at ${revCagr}% per year and net profits at ${patCagr}% per year over the last 5 audited years.`;

  const p = (sc && sc.pillars) || { quality: 50, growth: 50, value: 50, momentum: 50 };
  const tagFor = (v) =>
    v >= 75 ? "Standout" : v >= 58 ? "Solid" : v >= 42 ? "Mixed" : "Weak / Expensive";

  const qualRows = isFin
    ? [
        {
          simple_label: `Profit on shareholder equity`,
          pro_label: "5Y Median ROE (Latest)",
          simple_value: `Earns ${ccySym}${medRet} per ${ccySym}100 of equity`,
          pro_value: `${m.med_5y_roce_pct ?? m.roce_pct ?? 0}% 5Y Med (${m.roce_pct ?? 0}% Latest)`,
          target_hint: "15%+ signals strong banking returns",
          tone: medRet >= 15 ? "good" : medRet >= 10 ? "neutral" : "warn",
        },
        {
          simple_label: "Loan book & asset return",
          pro_label: "ROA & Asset Quality",
          simple_value:
            Number(m.gnpa_pct || 0) > 0
              ? `Net bad loans at ${m.nnpa_pct}%`
              : `Earns ${m.roa_pct || 0}% on total banking assets`,
          pro_value:
            Number(m.gnpa_pct || 0) > 0
              ? `GNPA ${m.gnpa_pct}% / NNPA ${m.nnpa_pct}%`
              : `ROA ${m.roa_pct || 0}% (${m.profit_consistency || "5/5"} yrs PAT > 0)`,
          target_hint: "Healthy lending cushion across cycles",
          tone: Number(m.roa_pct || 0) >= 1.2 ? "good" : "neutral",
        },
      ]
    : [
        {
          simple_label: `Profit per ${ccySym}100 invested`,
          pro_label: "5Y Median ROCE (Latest)",
          simple_value: `Earns ${ccySym}${medRet} per ${ccySym}100 invested`,
          pro_value: `${m.med_5y_roce_pct ?? m.roce_pct ?? 0}% 5Y Med (${m.roce_pct ?? 0}% Latest)`,
          target_hint: "18%+ signals a durable business moat",
          tone: medRet >= 18 ? "good" : medRet >= 12 ? "neutral" : "warn",
        },
        {
          simple_label: "Real cash collected from profits",
          pro_label: "5Y Cumulative CFO / EBITDA",
          simple_value: `${Math.round(Number(m.cfo_to_ebitda_pct || 0))}% converted into bank cash`,
          pro_value: `${m.cfo_to_ebitda_pct || 0}% CFO/EBITDA`,
          target_hint: "80%+ means profits turn into real cash",
          tone: Number(m.cfo_to_ebitda_pct || 0) >= 80 ? "good" : "neutral",
        },
        {
          simple_label: isBuyback ? "Cash coverage of debt (buybacks)" : "Debt safety & profit margin",
          pro_label: isBuyback ? "CFO / Total Debt & OPM" : "Debt / Equity & Operating Margin",
          simple_value: isBuyback
            ? "Strong cash flow covers debt (buyback equity)"
            : Number(m.debt_to_equity || 0) <= 0.5
            ? `Low debt • ${m.op_margin_pct || 0}% operating margin`
            : `Moderate/higher debt • ${m.op_margin_pct || 0}% margin`,
          pro_value: isBuyback
            ? `CFO/Debt ${m.cfo_to_debt_pct || 50}% • OPM ${m.op_margin_pct || 0}%`
            : `D/E ${m.debt_to_equity || 0}x • OPM ${m.op_margin_pct || 0}%`,
          target_hint: "Low debt keeps the business safe in downturns",
          tone: isBuyback || Number(m.debt_to_equity || 0) <= 0.5 ? "good" : "warn",
        },
      ];

  const valSimple = isLoss
    ? "Currently unprofitable — cannot be valued on current profits yet"
    : `Trades at ${pe.toFixed(1)}x annual profits (Fair ~${fairPe}x)`;

  const steps = [
    {
      key: "quality",
      simple_title: "1. Is it a strong, safe business?",
      pro_title: "1. Business Quality & 8Y Moat",
      score_100: Number(p.quality || 0),
      weight_pct: Number(bd.weights_pct.quality || 45),
      points_added: Number(bd.contributions.quality || 0),
      verdict_tag: tagFor(Number(p.quality || 0)),
      plain_why: s1,
      rows: qualRows,
    },
    {
      key: "growth",
      simple_title: "2. Are sales & profits growing?",
      pro_title: "2. Multi-Year & Quarterly Growth",
      score_100: Number(p.growth || 0),
      weight_pct: Number(bd.weights_pct.growth || 25),
      points_added: Number(bd.contributions.growth || 0),
      verdict_tag: tagFor(Number(p.growth || 0)),
      plain_why: s3,
      rows: [
        {
          simple_label: "5-Year yearly sales growth",
          pro_label: "Sales CAGR (5Y / 3Y)",
          simple_value: `${fmtSigned(m.rev_cagr_5y_pct || 0)}% per year`,
          pro_value: `${m.rev_cagr_5y_pct || 0}% (5Y) • ${m.rev_cagr_3y_pct || 0}% (3Y)`,
          target_hint: "12%+ yearly sales growth is strong",
          tone: Number(m.rev_cagr_5y_pct || 0) >= 12 ? "good" : "neutral",
        },
        {
          simple_label: "5-Year yearly profit growth",
          pro_label: "Net Profit CAGR (5Y / 3Y)",
          simple_value: `${fmtSigned(m.pat_cagr_5y_pct || 0)}% per year`,
          pro_value: `${m.pat_cagr_5y_pct || 0}% (5Y) • ${m.pat_cagr_3y_pct || 0}% (3Y)`,
          target_hint: "15%+ yearly profit compounding is ideal",
          tone:
            Number(m.pat_cagr_5y_pct || 0) >= 15
              ? "good"
              : Number(m.pat_cagr_3y_pct || 0) < 0
              ? "bad"
              : "neutral",
        },
        {
          simple_label: "Recent quarterly profit trend",
          pro_label: "Latest 2Q Sales & PAT YoY",
          simple_value: `Sales ${fmtSigned(m.qtr_rev_yoy_pct || 0)}% • Profit ${fmtSigned(
            m.qtr_pat_yoy_pct || 0
          )}%`,
          pro_value: `Sales ${fmtSigned(m.qtr_rev_yoy_pct || 0)}% • PAT ${fmtSigned(
            m.qtr_pat_yoy_pct || 0
          )}%`,
          target_hint: "Recent quarters vs same period last year",
          tone:
            Number(m.qtr_pat_yoy_pct || 0) >= 10
              ? "good"
              : Number(m.qtr_pat_yoy_pct || 0) < 0
              ? "bad"
              : "neutral",
        },
      ],
    },
    {
      key: "value",
      simple_title: "3. Is the stock fairly priced today?",
      pro_title: "3. GARP Valuation & Fair P/E",
      score_100: Number(p.value || 0),
      weight_pct: Number(bd.weights_pct.value || 20),
      points_added: Number(bd.contributions.value || 0),
      verdict_tag: tagFor(Number(p.value || 0)),
      plain_why: valSimple,
      rows: [
        {
          simple_label: "Stock price vs company profits",
          pro_label: "Trailing P/E vs Fair GARP P/E",
          simple_value: valSimple,
          pro_value: formatPeVsFair(m),
          target_hint: "Lower or near fair range offers better value",
          tone: isLoss
            ? "bad"
            : pe <= fairPe * 1.1
            ? "good"
            : pe > fairPe * 1.45
            ? "warn"
            : "neutral",
        },
        {
          simple_label: "Annual cash & profit yield on price",
          pro_label: "Earnings Yield & FCF Yield",
          simple_value: `${m.earnings_yield_pct || 0}% profit yield on share price`,
          pro_value: `EY ${m.earnings_yield_pct || 0}% • FCF ${m.fcf_yield_pct || 0}%`,
          target_hint: "4.5%+ annual profit yield is attractive",
          tone: Number(m.earnings_yield_pct || 0) >= 4.5 ? "good" : "neutral",
        },
      ],
    },
    {
      key: "momentum",
      simple_title: "4. Financial health & expert view",
      pro_title: "4. Piotroski Health, Revisions & Ownership",
      score_100: Number(p.momentum || 0),
      weight_pct: Number(bd.weights_pct.momentum || 10),
      points_added: Number(bd.contributions.momentum || 0),
      verdict_tag: tagFor(Number(p.momentum || 0)),
      plain_why: `Passes ${m.piotroski_f_score || 0} out of 9 annual financial safety checks.`,
      rows: [
        {
          simple_label: "9-Point financial safety checklist",
          pro_label: "Piotroski F-Score",
          simple_value: `Passed ${m.piotroski_f_score || 0} of 9 safety checks`,
          pro_value: `${m.piotroski_f_score || 0} / 9 F-Score`,
          target_hint: "7+ out of 9 indicates strong financial health",
          tone:
            Number(m.piotroski_f_score || 0) >= 7
              ? "good"
              : Number(m.piotroski_f_score || 0) <= 4
              ? "bad"
              : "neutral",
        },
        {
          simple_label: "1-Year share price trend",
          pro_label: "12M-1M Momentum & Volatility",
          simple_value: `${fmtSigned(m.mom_12_1_pct || 0)}% price trend over past year`,
          pro_value: `${fmtSigned(m.mom_12_1_pct || 0)}% Mom • ${m.volatility_pct || 0}% Vol`,
          target_hint: "Steady upward trend with manageable swings",
          tone: Number(m.mom_12_1_pct || 0) >= 0 ? "good" : "warn",
        },
      ],
    },
  ];

  return {
    archetype_code: archetypeCode,
    archetype_label: archetypeLabel,
    one_line_verdict: oneLine,
    what_it_does: whatItDoes,
    bottom_line_summary: [s1, s2, s3],
    receipt_steps: steps,
    safety_checks_plain: [
      `Passed ${m.piotroski_f_score || 0} of 9 annual financial health checks`,
      `Profitable in ${m.profit_consistency || "5/5"} recent audited years`,
    ],
  };
}

function resolvePlainEnglish(sc, comp = {}) {
  const fb = buildFallbackPlainEnglish(sc, comp);
  const raw = sc && sc.plain_english;
  if (!raw || typeof raw !== "object") {
    return fb;
  }
  return {
    archetype_code: raw.archetype_code || fb.archetype_code,
    archetype_label: raw.archetype_label || fb.archetype_label,
    one_line_verdict: raw.one_line_verdict || fb.one_line_verdict,
    what_it_does: raw.what_it_does || comp.business_summary || fb.what_it_does,
    bottom_line_summary:
      Array.isArray(raw.bottom_line_summary) && raw.bottom_line_summary.length > 0
        ? raw.bottom_line_summary
        : fb.bottom_line_summary,
    receipt_steps:
      Array.isArray(raw.receipt_steps) && raw.receipt_steps.length === 4
        ? raw.receipt_steps
        : fb.receipt_steps,
    safety_checks_plain:
      Array.isArray(raw.safety_checks_plain) && raw.safety_checks_plain.length > 0
        ? raw.safety_checks_plain
        : fb.safety_checks_plain,
  };
}

function formatFriendlyPriceSub(stock, pe, proMode = false) {
  const m = (stock && stock.metrics) || {};
  const peVal = Number(m.pe_ratio || 0);
  const fairVal = Math.round(Number(m.fair_pe || 0));
  const isLoss = pe.archetype_code === "loss_turnaround" || peVal >= 99 || peVal <= 0;

  if (proMode) {
    if (isLoss) {
      return fairVal > 0 ? `P/E N/M (Unprofitable • Fair ~${fairVal}x)` : "P/E N/M (Unprofitable)";
    }
    const peg = Number(m.peg_ratio || 0);
    const pegPart = peg > 0 && peg < 50 ? ` • PEG ${peg}x` : "";
    return `P/E ${formatPeVsFair(m)}${pegPart}`;
  }

  if (isLoss) {
    return "Unprofitable today (cannot value on profits)";
  }
  return fairVal > 0
    ? `Trades at ${peVal.toFixed(1)}x profits (Fair ~${fairVal}x)`
    : `Trades at ${peVal.toFixed(1)}x annual profits`;
}

function syncModeButtons() {
  const simpleIds = ["dd-mode-simple-btn", "screener-mode-simple-btn"];
  const proIds = ["dd-mode-pro-btn", "screener-mode-pro-btn"];
  for (const id of simpleIds) {
    const node = document.getElementById(id);
    if (node) node.classList.toggle("active", !state.proMode);
  }
  for (const id of proIds) {
    const node = document.getElementById(id);
    if (node) node.classList.toggle("active", state.proMode);
  }
}

function setProMode(isPro) {
  const next = Boolean(isPro);
  if (state.proMode === next) return;
  state.proMode = next;
  syncModeButtons();
  renderFormulaBar();
  applyClientFiltersAndRender();

  if (state.drawerOpen && state.currentDetail) {
    const scrollEl = document.getElementById("company-detail-content");
    const savedScroll = scrollEl ? scrollEl.scrollTop : 0;
    renderCompanyDetail(state.currentDetail);
    if (scrollEl) {
      scrollEl.scrollTop = savedScroll;
    }
  }
}

async function fetchAiAnalystMemo(sc) {
  const ticker = sc.ticker;
  const rawPreset = document.getElementById("screener-preset").value;
  const presetForMemo = rawPreset === "custom" ? "qglp_compounder" : rawPreset;
  const headers = { "Content-Type": "application/json" };
  if (!state.staticMode && state.csrfToken) {
    headers["X-CSRF-Token"] = state.csrfToken;
  }

  const bodyPayload = {
    ticker,
    preset: presetForMemo,
    score_summary: {
      composite_score: Number(sc.composite_score || 0),
      quality_score: Number((sc.pillars && sc.pillars.quality) || 0),
      growth_score: Number((sc.pillars && sc.pillars.growth) || 0),
      value_score: Number((sc.pillars && sc.pillars.value) || 0),
      momentum_score: Number((sc.pillars && sc.pillars.momentum) || 0),
      rank: Number(sc.rank || 0),
    },
  };

  let resp;
  try {
    resp = await window.fetch("/api/ai-memo", {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(bodyPayload),
    });
  } catch (_netErr) {
    return {
      available: false,
      reason:
        "Could not reach /api/ai-memo. Open the live Netlify deployment or run the local FastAPI server to generate AI memos.",
    };
  }

  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return {
      available: false,
      reason:
        "On-demand AI Analyst Memos run on our live Netlify AI Gateway deployment or local FastAPI server (not available on a plain static file server).",
    };
  }

  const data = await resp.json().catch(() => ({}));
  if (resp.status === 429) {
    return {
      available: false,
      reason:
        data.reason ||
        "AI Analyst rate limit reached (max 8 memos per minute). Please wait a moment and try again.",
    };
  }
  if (!resp.ok) {
    return {
      available: false,
      reason: data.reason || data.detail || `AI Memo request returned status ${resp.status}.`,
    };
  }
  return data;
}

function buildKpiCard(label, value, sub, valueColorClass = "") {
  const card = el("div", "kpi-card");
  card.appendChild(el("div", "kpi-label", label));
  card.appendChild(el("div", `kpi-value ${valueColorClass}`.trim(), value));
  if (sub) card.appendChild(el("div", "kpi-sub", sub));
  return card;
}

function getActiveCustomWeights() {
  return {
    quality: Math.max(0, Number(document.getElementById("w-quality").value || 45)),
    growth: Math.max(0, Number(document.getElementById("w-growth").value || 25)),
    value: Math.max(0, Number(document.getElementById("w-value").value || 20)),
    momentum: Math.max(0, Number(document.getElementById("w-momentum").value || 10)),
  };
}

function getNormalizedActiveWeightsPct() {
  const preset = document.getElementById("screener-preset").value;
  const raw =
    preset === "custom"
      ? getActiveCustomWeights()
      : state.presetWeightsMap[preset] || DEFAULT_PRESET_WEIGHTS.qglp_compounder;
  const sum =
    Number(raw.quality || 0) +
    Number(raw.growth || 0) +
    Number(raw.value || 0) +
    Number(raw.momentum || 0);
  if (sum <= 0) {
    return { quality: 45, growth: 25, value: 20, momentum: 10 };
  }
  return {
    quality: (Number(raw.quality || 0) / sum) * 100,
    growth: (Number(raw.growth || 0) / sum) * 100,
    value: (Number(raw.value || 0) / sum) * 100,
    momentum: (Number(raw.momentum || 0) / sum) * 100,
  };
}

function resolveScoreBreakdown(sc) {
  if (sc && sc.score_breakdown && sc.score_breakdown.contributions) {
    return sc.score_breakdown;
  }
  const wPct = getNormalizedActiveWeightsPct();
  const p = (sc && sc.pillars) || { quality: 0, growth: 0, value: 0, momentum: 0 };
  const cQual = (wPct.quality / 100) * Number(p.quality || 0);
  const cGrow = (wPct.growth / 100) * Number(p.growth || 0);
  const cVal = (wPct.value / 100) * Number(p.value || 0);
  const cMom = (wPct.momentum / 100) * Number(p.momentum || 0);
  const rawComp = cQual + cGrow + cVal + cMom;
  const finalScore = Number((sc && sc.composite_score) || rawComp);
  const totalPen = Math.max(0, rawComp - finalScore);
  return {
    preset_used: document.getElementById("screener-preset").value,
    weights_pct: wPct,
    contributions: {
      quality: cQual,
      growth: cGrow,
      value: cVal,
      momentum: cMom,
    },
    raw_composite: rawComp,
    total_penalty: totalPen,
    penalty_items: ((sc && sc.red_flags) || []).map((r) => ({ reason: r, points: -5.0 })),
    final_score: finalScore,
    rating_rule: (sc && sc.conviction) || "",
  };
}

// --- Auth & Session Bootstrapping ---

function findStockInUniverse(rawSym) {
  const sym = String(rawSym || "").trim().toUpperCase();
  if (!sym) return null;
  for (const s of state.stocks) {
    if (s.ticker.toUpperCase() === sym || displaySymbol(s.ticker).toUpperCase() === sym) {
      return s;
    }
  }
  return null;
}

function wirePaperBridge() {
  initPaperTradingUI({
    getStaticMode: () => state.staticMode,
    getCsrfToken: () => state.csrfToken,
    getAllStocks: () => state.stocks,
    findStockByTicker: findStockInUniverse,
    openDeepDive: (tk) => openDeepDive(tk),
    switchTab: (tab) => switchTab(tab),
    showToast: (msg, isErr) => showToast(msg, isErr),
  });
}

async function bootstrapPaperAuth() {
  wirePaperBridge();
  await initPaperAuthClient({
    staticMode: state.staticMode,
    getLocalUsername: () => state.username,
    getCsrfToken: () => state.csrfToken,
    showToast: (msg, isErr) => showToast(msg, isErr),
    onAuthChanged: (_user, meta) => {
      if (meta && meta.openPaperTab) {
        switchTab("paper");
      } else if (state.activeTab === "paper") {
        loadPaperOverview();
      }
    },
  });
}

async function initAuth() {
  try {
    const status = await apiRequest("/api/auth/status");
    state.csrfToken = status.csrf_token;
    state.needsSetup = Boolean(status.needs_setup);

    if (status.authenticated) {
      state.username = status.username;
      await bootstrapPaperAuth();
      await enterWorkspace();
    } else {
      showAuthGate();
    }
  } catch (_err) {
    state.staticMode = true;
    state.username = "Cloud Snapshot";
    document.getElementById("logout-btn").classList.add("hidden");
    await bootstrapPaperAuth();
    await enterWorkspace();
  }
}

function showAuthGate() {
  document.getElementById("app-shell").classList.add("hidden");
  const authScreen = document.getElementById("auth-screen");
  authScreen.classList.remove("hidden");

  const sub = document.getElementById("auth-subtitle");
  const btn = document.getElementById("auth-submit-btn");
  if (state.needsSetup) {
    sub.textContent =
      "First-time setup: Create your local Advisor Workspace passphrase to protect saved plans and screener models.";
    btn.textContent = "Initialize Advisor Workspace";
  } else {
    sub.textContent = "Sign in to your local ArthaQuant Advisor Workspace.";
    btn.textContent = "Unlock Workspace";
  }
}

async function handleAuthSubmit(ev) {
  ev.preventDefault();
  const errBox = document.getElementById("auth-error");
  errBox.classList.add("hidden");

  const username = document.getElementById("auth-username").value.trim();
  const password = document.getElementById("auth-password").value;
  const endpoint = state.needsSetup ? "/api/auth/setup" : "/api/auth/login";

  try {
    const res = await apiRequest(endpoint, {
      method: "POST",
      jsonBody: { username, password },
    });
    state.csrfToken = res.csrf_token;
    state.username = res.username;
    document.getElementById("auth-password").value = "";
    await bootstrapPaperAuth();
    await enterWorkspace();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  }
}

async function handleLogout() {
  try {
    await apiRequest("/api/auth/logout", { method: "POST", jsonBody: {} });
  } catch (_e) {
    // Proceed with client state wipe
  }
  state.csrfToken = null;
  state.username = null;
  state.stocks = [];
  state.visibleStocks = [];
  window.location.href = "/";
}

async function enterWorkspace() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("user-badge").textContent = state.staticMode
    ? "Mode: Cloud Snapshot (Nifty 200 + Nasdaq 100 + S&P 500)"
    : `Advisor: ${maskUserIdentity(state.username)}`;
  await loadScreener(true);
}

// --- Navigation & Market Switchers ---

function switchTab(tabName) {
  state.activeTab = tabName;
  for (const btn of document.querySelectorAll(".nav-tab, .mobile-nav-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.classList.toggle("hidden", panel.id !== `tab-${tabName}`);
  }
  if (tabName === "backtest" && !state.backtestLoaded) {
    runBacktest();
  }
  if (tabName === "planner" && !state.plannerLoaded) {
    runPlanner();
  }
  if (tabName === "paper") {
    loadPaperOverview();
  }
}

function updateSwitcherActiveButtons(containerId, activeMarket) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  for (const btn of wrap.querySelectorAll(".market-btn")) {
    btn.classList.toggle("active", btn.dataset.market === activeMarket);
  }
}

async function setScreenerMarket(market) {
  if (state.screenerMarket === market) return;
  state.screenerMarket = market;
  updateSwitcherActiveButtons("screener-market-switcher", market);

  const searchEl = document.getElementById("screener-search");
  const secLabel = document.getElementById("screener-sector-label");
  const mktSub = document.getElementById("screener-market-sub");

  if (market === "IN") {
    searchEl.placeholder =
      "Search India Nifty 200 stocks (e.g. Muthoot, ICICI, Polycab, TCS, Dixon)...";
    secLabel.textContent = "Nifty 200 Sector";
    mktSub.textContent =
      "Showing Indian Stock · NIFTY 200 compounders in native ₹ INR";
  } else if (market === "NASDAQ100") {
    searchEl.placeholder =
      "Search US Nasdaq 100 stocks (e.g. NVDA, MSFT, AAPL, COST, META, AVGO)...";
    secLabel.textContent = "Nasdaq 100 Sector";
    mktSub.textContent =
      "Showing US Stock · NASDAQ 100 constituents (takes tag priority over S&P 500 overlap)";
  } else if (market === "SP500") {
    searchEl.placeholder =
      "Search US S&P 500 non-Nasdaq stocks (e.g. JPM, LLY, V, MA, WMT, GS, BRK-B)...";
    secLabel.textContent = "S&P 500 Sector";
    mktSub.textContent =
      "Showing US Stock · S&P 500 non-Nasdaq stocks • Overlap mega-caps (AAPL, MSFT, NVDA) carry the NASDAQ 100 tag";
  } else if (market === "US") {
    searchEl.placeholder =
      "Search all US stocks — Nasdaq 100 & S&P 500 (e.g. NVDA, JPM, MSFT, LLY, V, COST)...";
    secLabel.textContent = "US Sector";
    mktSub.textContent =
      "Showing combined US universe (Nasdaq 100 + S&P 500) • Overlap names carry the NASDAQ 100 priority tag";
  } else {
    searchEl.placeholder =
      "Search Nifty 200, Nasdaq 100 & S&P 500 stocks (e.g. NVDA, JPM, LLY, MSFT, Muthoot, ICICI)...";
    secLabel.textContent = "Sector Filter";
    mktSub.textContent =
      "Index tag priority: NASDAQ 100 > S&P 500 > NIFTY 200 • Dual-listed US overlap names carry the NASDAQ 100 tag";
  }

  document.getElementById("screener-sector").value = "ALL";
  await loadScreener(true);
}

async function setPlannerMarket(market) {
  const prevMarket = state.plannerMarket;
  const wasUsd = isUsdMarketMode(prevMarket);
  const nowUsd = isUsdMarketMode(market);
  state.plannerMarket = market;
  updateSwitcherActiveButtons("planner-market-switcher", market);

  const lumpInput = document.getElementById("pl-lumpsum");
  const sipInput = document.getElementById("pl-sip");
  const targetInput = document.getElementById("pl-target");
  const lumpLbl = document.getElementById("pl-lumpsum-label");
  const sipLbl = document.getElementById("pl-sip-label");
  const targetLbl = document.getElementById("pl-target-label");
  const runBtn = document.getElementById("run-planner-btn");
  const coneTitle = document.getElementById("pl-cone-title");
  const navTab = document.getElementById("nav-planner-tab");
  const marketSub = document.getElementById("pl-market-sub");

  if (nowUsd) {
    lumpLbl.textContent = "Capital to Deploy Today ($ USD)";
    sipLbl.textContent = "Optional Monthly SIP ($ USD)";
    targetLbl.textContent = "Target Corpus Goal ($ USD)";
    runBtn.textContent = "Build $ Blueprint";
    coneTitle.textContent = "1,000-Path Wealth Projection Cone ($ USD)";
    navTab.textContent = "$10K Investment Planner";

    if (market === "NASDAQ100") {
      marketSub.textContent =
        "Deploying USD directly into whole Nasdaq 100 US compounder shares";
    } else if (market === "SP500") {
      marketSub.textContent =
        "Deploying USD into S&P 500 (non-Nasdaq) compounders • Overlap names carry the NASDAQ 100 tag";
    } else {
      marketSub.textContent =
        "Deploying USD across combined US Nasdaq 100 & S&P 500 compounder shares";
    }

    if (!wasUsd || Number(lumpInput.value) >= 100000) {
      lumpInput.step = "1000";
      lumpInput.value = "10000";
      sipInput.step = "250";
      if (Number(sipInput.value) >= 5000) sipInput.value = "0";
      targetInput.step = "2000";
      targetInput.value = "26000";
    }
  } else {
    lumpLbl.textContent = "Capital to Deploy Today (₹ INR)";
    sipLbl.textContent = "Optional Monthly SIP (₹ INR)";
    targetLbl.textContent = "Target Corpus Goal (₹ INR)";
    runBtn.textContent = "Build ₹ Blueprint";
    coneTitle.textContent = "1,000-Path Wealth Projection Cone (₹ INR)";
    navTab.textContent = "₹5L Investment Planner";
    marketSub.textContent =
      market === "IN"
        ? "Deploying ₹ INR across audited Indian NSE Nifty 200 compounders"
        : "Deploying ₹ INR across Global All-Market leaders (US prices sized at ₹84.5/$)";

    if (wasUsd || Number(lumpInput.value) <= 50000) {
      lumpInput.step = "50000";
      lumpInput.value = "500000";
      sipInput.step = "5000";
      targetInput.step = "100000";
      targetInput.value = "1300000";
    }
  }

  await runPlanner();
}

async function setBacktestMarket(market) {
  if (state.backtestMarket === market && state.backtestLoaded) return;
  state.backtestMarket = market;
  updateSwitcherActiveButtons("bt-market-switcher", market);
  await runBacktest();
}

// --- Tab 1: Stock Rankings, Formula Legend, Filter Cards, Podium & Leaderboard ---

function currentScreenerPayload() {
  const preset = document.getElementById("screener-preset").value;
  const sector = document.getElementById("screener-sector").value || "ALL";
  const payload = {
    preset,
    sector,
    min_score: 0,
    market: state.screenerMarket,
  };
  if (preset === "custom") {
    payload.weights = getActiveCustomWeights();
  }
  return payload;
}

async function loadScreener(populateSectors = false) {
  try {
    const payload = currentScreenerPayload();
    const data = state.staticMode
      ? await runScreenerSnapshot(payload)
      : await apiRequest("/api/screener", {
          method: "POST",
          jsonBody: payload,
        });

    state.stocks = data.stocks || [];
    state.stage1Funnel = data.stage1_funnel || [];
    if (data.preset_weights) {
      state.presetWeightsMap = data.preset_weights;
    }

    const fallbackIn = state.stocks.filter((s) => !isUSStock(s)).length;
    const fallbackUs = state.stocks.filter((s) => isUSStock(s)).length;
    const fallbackNasdaq = state.stocks.filter((s) => resolveIndexTag(s) === "NASDAQ100").length;
    const fallbackSp500 = state.stocks.filter((s) => resolveIndexTag(s) === "SP500").length;

    const rawMc = data.market_counts || {};
    const mc = {
      ALL: rawMc.ALL !== undefined ? rawMc.ALL : data.total_deep_scored || state.stocks.length,
      IN: rawMc.IN !== undefined ? rawMc.IN : fallbackIn,
      US: rawMc.US !== undefined ? rawMc.US : fallbackUs,
      NASDAQ100:
        rawMc.NASDAQ100 !== undefined ? rawMc.NASDAQ100 : fallbackNasdaq || fallbackUs,
      SP500: rawMc.SP500 !== undefined ? rawMc.SP500 : fallbackSp500,
    };
    state.marketCounts = mc;

    document.getElementById("mkt-count-all").textContent = String(mc.ALL || 0);
    document.getElementById("mkt-count-in").textContent = String(mc.IN || 0);
    document.getElementById("mkt-count-us").textContent = String(mc.US || 0);
    document.getElementById("mkt-count-nasdaq").textContent = String(mc.NASDAQ100 || 0);
    document.getElementById("mkt-count-sp500").textContent = String(mc.SP500 || 0);

    const niftyVal = Number(data.benchmark_nifty50 || 0);
    const sp500Val = Number(data.benchmark_sp500 || 0);
    const ndxVal = Number(data.benchmark_nasdaq100 || 0);
    const niftyPart =
      niftyVal > 0
        ? `Nifty 50 (^NSEI): ${niftyVal.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
        : "";
    const sp500Part =
      sp500Val > 0
        ? `S&P 500 (^GSPC): ${sp500Val.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
        : "";
    const ndxPart =
      ndxVal > 0
        ? `Nasdaq 100 (^NDX): ${ndxVal.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
        : "";
    const idxJoined = [niftyPart, sp500Part, ndxPart].filter(Boolean).join("  •  ");
    const countPart =
      mc.SP500 > 0
        ? `Universe: ${mc.IN} Nifty 200 + ${mc.NASDAQ100} Nasdaq 100 + ${mc.SP500} S&P 500`
        : mc.US > 0
        ? `Universe: ${mc.IN} Nifty 200 + ${mc.US} US`
        : `Audited Universe: ${data.total_deep_scored} Stocks`;
    document.getElementById("market-status-line").textContent = [
      idxJoined,
      countPart,
      `As of ${data.as_of_date}`,
    ]
      .filter(Boolean)
      .join("  •  ");

    if (state.staticMode) {
      document.getElementById("user-badge").textContent =
        mc.SP500 > 0
          ? `Cloud Snapshot (${mc.IN} IN + ${mc.US} US)`
          : mc.US > 0
          ? `Cloud Snapshot (${mc.IN} NSE + ${mc.US} Nasdaq)`
          : `Cloud Snapshot (${data.total_deep_scored} Audited)`;
    }

    document.getElementById("funnel-summary-note").textContent =
      `${data.total_stage1_scanned} liquid stocks scanned → ${data.total_deep_scored} deep-scored in current market view.`;
    document.getElementById("view-stage2-btn").textContent = `Audited Rankings (${data.total_deep_scored})`;
    document.getElementById("view-stage1-btn").textContent = `Raw Stage-1 Price Scan (${state.stage1Funnel.length})`;

    const expandBtn = document.getElementById("expand-funnel-btn");
    if (data.unscored_funnel_remaining > 0) {
      expandBtn.textContent = `+ Deep-Score Next ${Math.min(30, data.unscored_funnel_remaining)} (${data.unscored_funnel_remaining} left)`;
      expandBtn.disabled = false;
    } else {
      expandBtn.textContent = "All Stocks Deep-Scored ✓";
      expandBtn.disabled = true;
    }

    if (populateSectors) {
      const sel = document.getElementById("screener-sector");
      const prevVal = sel.value;
      const allLabel =
        state.screenerMarket === "IN"
          ? "All Nifty 200 Sectors"
          : state.screenerMarket === "NASDAQ100"
          ? "All Nasdaq 100 Sectors"
          : state.screenerMarket === "SP500"
          ? "All S&P 500 Sectors"
          : state.screenerMarket === "US"
          ? "All US Sectors"
          : "All Global Sectors";
      const defaultOpt = el("option", "", allLabel);
      defaultOpt.value = "ALL";
      sel.replaceChildren(defaultOpt);
      for (const sec of data.sectors || []) {
        const opt = el("option", "", sec);
        opt.value = sec;
        sel.appendChild(opt);
      }
      if (prevVal && (data.sectors || []).includes(prevVal)) {
        sel.value = prevVal;
      } else {
        sel.value = "ALL";
      }
    }

    renderFormulaBar();
    applyClientFiltersAndRender();

    if (state.drawerOpen && state.selectedTicker) {
      await openDeepDive(state.selectedTicker);
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderFormulaBar() {
  const bar = document.getElementById("active-formula-bar");
  bar.replaceChildren();
  const preset = document.getElementById("screener-preset").value;
  const w = getNormalizedActiveWeightsPct();

  bar.appendChild(
    el(
      "span",
      "muted-note",
      state.proMode
        ? `${PRESET_NAMES[preset] || "Model"} Formula:`
        : "How Every Stock Score Is Built:"
    )
  );

  const items = state.proMode
    ? [
        ["dot-emerald", `Quality & 8Y Moat ${w.quality.toFixed(0)}%`],
        ["dot-indigo", `5Y + 2Q + Street Growth ${w.growth.toFixed(0)}%`],
        ["dot-cyan", `GARP Valuation ${w.value.toFixed(0)}%`],
        ["dot-amber", `Piotroski, Revisions & Smart Money ${w.momentum.toFixed(0)}%`],
      ]
    : [
        ["dot-emerald", `Strong & Safe Business ${w.quality.toFixed(0)}%`],
        ["dot-indigo", `Sales & Profit Growth ${w.growth.toFixed(0)}%`],
        ["dot-cyan", `Fair Stock Price ${w.value.toFixed(0)}%`],
        ["dot-amber", `Financial Health & Analyst View ${w.momentum.toFixed(0)}%`],
      ];

  items.forEach(([dotCls, label], idx) => {
    if (idx > 0) bar.appendChild(el("span", "muted-note", "+"));
    const chip = el("span", "formula-chip");
    chip.appendChild(el("span", `legend-dot ${dotCls}`));
    chip.appendChild(el("span", "", label));
    bar.appendChild(chip);
  });

  bar.appendChild(el("span", "muted-note", "−"));
  const penChip = el("span", "formula-chip text-neg");
  penChip.appendChild(el("span", "legend-dot dot-rose"));
  penChip.appendChild(
    el("span", "", state.proMode ? "Guardrail Penalties" : "Red-Flag Deductions")
  );
  bar.appendChild(penChip);
}

function setFunnelView(mode) {
  state.funnelView = mode;
  const s2Btn = document.getElementById("view-stage2-btn");
  const s1Btn = document.getElementById("view-stage1-btn");
  s2Btn.className = mode === "stage2" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm";
  s1Btn.className = mode === "stage1" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm";
  applyClientFiltersAndRender();
}

function matchesSearch(item, q) {
  if (!q) return true;
  const tag = resolveIndexTag(item);
  const canonicalBadge =
    tag === "NASDAQ100"
      ? "US Stock NASDAQ 100"
      : tag === "SP500"
      ? "US Stock S&P 500 SP500"
      : "Indian Stock NIFTY 200 NSE";
  const pe = item && item.plain_english ? item.plain_english : {};
  const hay = [
    item.name || "",
    item.ticker || "",
    item.sector || "",
    item.index_tag || "",
    item.market_label || "",
    pe.archetype_label || "",
    pe.one_line_verdict || "",
    pe.what_it_does || "",
    canonicalBadge,
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function mcapSortableInrCr(stock) {
  const raw = Number(stock.market_cap_cr || 0);
  return isUSStock(stock) ? raw * 8.45 : raw;
}

function sortStocksList(list, sortBy) {
  const copy = [...list];
  if (sortBy === "quality") {
    copy.sort((a, b) => Number(b.pillars.quality) - Number(a.pillars.quality));
  } else if (sortBy === "growth") {
    copy.sort((a, b) => Number(b.pillars.growth) - Number(a.pillars.growth));
  } else if (sortBy === "value") {
    copy.sort((a, b) => Number(b.pillars.value) - Number(a.pillars.value));
  } else if (sortBy === "mcap") {
    copy.sort((a, b) => mcapSortableInrCr(b) - mcapSortableInrCr(a));
  } else {
    copy.sort((a, b) => Number(b.composite_score) - Number(a.composite_score));
  }
  return copy;
}

function renderRatingFilterStrip(searchFilteredStocks) {
  const strip = document.getElementById("rating-filter-strip");
  strip.replaceChildren();

  const counts = {
    ALL: searchFilteredStocks.length,
    "Strong Buy": 0,
    Buy: 0,
    Hold: 0,
    Avoid: 0,
  };
  for (const s of searchFilteredStocks) {
    counts[s.rating] = (counts[s.rating] || 0) + 1;
  }

  const cards = [
    {
      key: "ALL",
      title: "All Ranked",
      count: counts.ALL,
      sub: state.proMode ? "Complete filtered universe" : "Every company in current view",
      colorCls: "",
    },
    {
      key: "Strong Buy",
      title: "Strong Buy",
      count: counts["Strong Buy"],
      sub: state.proMode
        ? "Score ≥ 68 • Zero Red Flags"
        : "Score 68+ • Strong business & fair price",
      colorCls: "text-pos",
    },
    {
      key: "Buy",
      title: "Buy",
      count: counts.Buy,
      sub: state.proMode
        ? "Score ≥ 57 • Accumulate 3-5Y+"
        : "Score 57+ • Good long-term candidate",
      colorCls: "text-cyan",
    },
    {
      key: "Hold",
      title: "Hold / Buy on Dip",
      count: counts.Hold,
      sub: state.proMode
        ? "Watchlist or Valuation Cap"
        : "Wait for a better price or watch closely",
      colorCls: "text-warn",
    },
    {
      key: "Avoid",
      title: "Avoid",
      count: counts.Avoid,
      sub: state.proMode
        ? "Forensic or Balance-Sheet Caution"
        : "Unprofitable, high risk, or overpriced",
      colorCls: "text-neg",
    },
  ];

  for (const c of cards) {
    const btn = el(
      "button",
      `rating-filter-card ${state.ratingFilter === c.key ? "active" : ""}`.trim()
    );
    btn.type = "button";
    const top = el("div", "rf-top");
    top.appendChild(el("span", "rf-title", c.title));
    top.appendChild(el("span", `rf-count ${c.colorCls}`.trim(), String(c.count)));
    btn.appendChild(top);
    btn.appendChild(el("div", "rf-sub", c.sub));
    btn.addEventListener("click", () => {
      state.ratingFilter = state.ratingFilter === c.key && c.key !== "ALL" ? "ALL" : c.key;
      applyClientFiltersAndRender();
    });
    strip.appendChild(btn);
  }
}

function renderTopPodium(visibleStocks) {
  const podiumSection = document.getElementById("podium-section");
  const grid = document.getElementById("top-podium-grid");
  grid.replaceChildren();

  if (state.funnelView !== "stage2" || visibleStocks.length === 0) {
    podiumSection.classList.add("hidden");
    return;
  }
  podiumSection.classList.remove("hidden");

  const marketTitle =
    state.screenerMarket === "IN"
      ? "Top India · Nifty 200 Conviction Leaders"
      : state.screenerMarket === "NASDAQ100"
      ? "Top US · Nasdaq 100 Conviction Leaders"
      : state.screenerMarket === "SP500"
      ? "Top US · S&P 500 (Non-Nasdaq) Conviction Leaders"
      : state.screenerMarket === "US"
      ? "Top All-US (Nasdaq 100 + S&P 500) Conviction Leaders"
      : "Top Global Conviction Leaders";
  document.getElementById("podium-heading").textContent = marketTitle;

  const top3 = visibleStocks.slice(0, 3);
  top3.forEach((s, idx) => {
    const pe = resolvePlainEnglish(s);
    const card = el("div", `podium-card ${idx === 0 ? "rank-1" : ""}`.trim());

    const top = el("div", "podium-top");
    const left = document.createElement("div");

    const badgeRow = el("div", "podium-badge-row");
    badgeRow.appendChild(el("span", `rank-medal medal-${idx + 1}`, `#${s.rank}`));
    badgeRow.appendChild(createMarketTag(s));
    left.appendChild(badgeRow);

    left.appendChild(el("div", "podium-name", s.name));
    left.appendChild(
      el(
        "div",
        "podium-meta",
        `${displaySymbol(s.ticker)} • ${s.sector} • ${formatMarketCap(
          s.market_cap_cr,
          s.market,
          s.currency
        )}`
      )
    );

    top.appendChild(left);
    top.appendChild(createScoreRingSvg(s.composite_score, s.rating, 60));
    card.appendChild(top);

    if (pe.what_it_does) {
      card.appendChild(el("div", "podium-what-sub", pe.what_it_does));
    }

    const metricsRow = el("div", "podium-metrics-row");
    metricsRow.appendChild(el("span", ratingBadgeClass(s.rating), s.rating));
    metricsRow.appendChild(createArchetypePill(pe));
    metricsRow.appendChild(
      el(
        "span",
        "mini-stat-pill",
        `${state.proMode ? "CMP" : "Price"} ${formatStockPrice(s.price, stockCurrency(s))}`
      )
    );
    if (state.proMode) {
      metricsRow.appendChild(
        el("span", "mini-stat-pill", `P/E ${formatPeVsFair(s.metrics)}`)
      );
      const medRet =
        s.metrics.med_5y_roce_pct !== undefined ? s.metrics.med_5y_roce_pct : s.metrics.roce_pct;
      metricsRow.appendChild(
        el(
          "span",
          "mini-stat-pill",
          `${s.is_financial ? "5Y ROE" : "5Y ROCE"} ${medRet}%`
        )
      );
    } else {
      const qualStep = pe.receipt_steps && pe.receipt_steps[0];
      const qualRow0 = qualStep && qualStep.rows && qualStep.rows[0];
      if (qualRow0 && qualRow0.simple_value) {
        metricsRow.appendChild(el("span", "mini-stat-pill", qualRow0.simple_value));
      }
    }
    card.appendChild(metricsRow);

    const verdictToneCls =
      s.rating === "Buy"
        ? "verdict-buy"
        : s.rating === "Hold"
        ? "verdict-hold"
        : s.rating === "Avoid"
        ? "verdict-avoid"
        : "";
    card.appendChild(
      el("div", `podium-verdict-box ${verdictToneCls}`.trim(), pe.one_line_verdict)
    );

    const footer = el("div", "podium-footer");
    footer.appendChild(createFriendlyValZonePill(s, state.proMode));
    const ctaWrap = el("div", "inline-group wrap-group");
    const ptBtn = el("button", "btn-paper-trade-xs", "Paper Trade");
    ptBtn.type = "button";
    ptBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openPaperOrderTicket(s, { side: "BUY", orderType: "LIMIT" });
    });
    const btn = el(
      "button",
      "btn-deep-dive",
      state.proMode ? "Score Math →" : "Breakdown →"
    );
    btn.type = "button";
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openDeepDive(s.ticker);
    });
    ctaWrap.appendChild(ptBtn);
    ctaWrap.appendChild(btn);
    footer.appendChild(ctaWrap);
    card.appendChild(footer);

    card.addEventListener("click", () => openDeepDive(s.ticker));
    grid.appendChild(card);
  });
}

function setTableHeaders(cols) {
  const thead = document.getElementById("screener-thead");
  thead.replaceChildren();
  const tr = document.createElement("tr");
  for (const c of cols) {
    tr.appendChild(el("th", "", c));
  }
  thead.appendChild(tr);
}

function applyClientFiltersAndRender() {
  const q = document.getElementById("screener-search").value.trim().toLowerCase();
  const sortBy = document.getElementById("screener-sort").value;

  const searchFiltered = state.stocks.filter((s) => matchesSearch(s, q));
  renderRatingFilterStrip(searchFiltered);

  const tierFiltered =
    state.ratingFilter === "ALL"
      ? searchFiltered
      : searchFiltered.filter((s) => s.rating === state.ratingFilter);

  const sorted = sortStocksList(tierFiltered, sortBy);
  state.visibleStocks = sorted;

  if (state.funnelView === "stage1") {
    document.getElementById("podium-section").classList.add("hidden");
    const s1Filtered = state.stage1Funnel.filter((r) => matchesSearch(r, q));
    renderStage1Table(s1Filtered);
  } else {
    renderTopPodium(sorted);
    renderStage2Table(sorted);
  }
}

function renderStage2Table(stocks) {
  const marketHeadline =
    state.screenerMarket === "IN"
      ? "India · Nifty 200 — Plain-English Stock Rankings"
      : state.screenerMarket === "NASDAQ100"
      ? "US · Nasdaq 100 — Plain-English Stock Rankings"
      : state.screenerMarket === "SP500"
      ? "US · S&P 500 (Non-Nasdaq) — Stock Rankings (Overlap Names Carry NASDAQ 100 Tag)"
      : state.screenerMarket === "US"
      ? "All US Stocks (Nasdaq 100 + S&P 500) — Plain-English Stock Rankings"
      : "Global Multi-Market Stock Rankings (Nifty 200 + Nasdaq 100 + S&P 500)";
  document.getElementById("table-panel-title").textContent = marketHeadline;
  document.getElementById("table-panel-sub").textContent = state.proMode
    ? "Pro Mode: Showing ROCE, CFO/EBITDA, Fair P/E, PEG & Piotroski F-Score — click any row for full score math & AI Analyst Memo"
    : "Everyday English Mode: Showing 1-line verdicts, price fairness & business snapshots — click any stock for its 30-second breakdown & AI Analyst Memo";
  document.getElementById("visible-count-badge").textContent =
    `Showing ${stocks.length} of ${state.stocks.length} Ranked`;

  if (state.proMode) {
    setTableHeaders([
      "Rank",
      "Company & Market Tag",
      "Verdict & Plain Takeaway",
      "Composite Score & Pillar Contribution",
      "Price vs Fair P/E",
      "Business Snapshot & Pro Ratios",
      "Score Reasoning",
    ]);
  } else {
    setTableHeaders([
      "Rank",
      "Company & Market",
      "Verdict & Plain Takeaway",
      "Score (Out of 100)",
      "Price vs Fair Value",
      "Business Snapshot",
      "Why This Rank?",
    ]);
  }

  const tbody = document.getElementById("screener-tbody");
  tbody.replaceChildren();

  if (stocks.length === 0) {
    const tr = document.createElement("tr");
    const td = el(
      "td",
      "empty-state-box",
      "No ranked companies match your current search or rating tier filter."
    );
    td.colSpan = 7;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const s of stocks) {
    const pe = resolvePlainEnglish(s);
    const tr = document.createElement("tr");
    tr.dataset.ticker = s.ticker;
    if (s.ticker === state.selectedTicker && state.drawerOpen) {
      tr.classList.add("selected-row");
    }

    // 1. Rank
    const rankTd = document.createElement("td");
    rankTd.appendChild(
      el("span", `rank-num ${s.rank <= 10 ? "top-rank" : ""}`.trim(), `#${s.rank}`)
    );
    tr.appendChild(rankTd);

    // 2. Company & Market
    const compTd = document.createElement("td");
    const primaryLine = el("div", "company-primary");
    primaryLine.appendChild(el("span", "", s.name));
    primaryLine.appendChild(el("span", "ticker-tag", displaySymbol(s.ticker)));
    primaryLine.appendChild(createMarketTag(s));
    compTd.appendChild(primaryLine);
    compTd.appendChild(
      el(
        "span",
        "sector-sub",
        `${s.sector} • ${state.proMode ? "MCap" : "Market Size"} ${formatMarketCap(
          s.market_cap_cr,
          s.market,
          s.currency
        )}`
      )
    );
    tr.appendChild(compTd);

    // 3. Verdict & Plain-English One-Line Takeaway
    const rateTd = document.createElement("td");
    const verdictWrap = el("div", "verdict-cell-wrap");
    verdictWrap.appendChild(el("span", ratingBadgeClass(s.rating), s.rating));
    verdictWrap.appendChild(el("span", "verdict-plain-line", pe.one_line_verdict));
    if (state.proMode && s.conviction) {
      verdictWrap.appendChild(el("span", "verdict-pro-sub", s.conviction));
    }
    rateTd.appendChild(verdictWrap);
    tr.appendChild(rateTd);

    // 4. Score & Pillar Contribution Bar
    const bd = resolveScoreBreakdown(s);
    const scoreTd = document.createElement("td");
    const scoreWrap = el("div", "score-cell-wrap");
    const topLine = el("div", "score-top-line");
    const bigSpan = el("span", "score-big", `${s.composite_score.toFixed(1)}`);
    topLine.appendChild(bigSpan);
    if (Number(bd.total_penalty || 0) > 0) {
      topLine.appendChild(
        el(
          "span",
          "penalty-tag",
          state.proMode
            ? `−${Number(bd.total_penalty).toFixed(1)} Guardrail`
            : `−${Number(bd.total_penalty).toFixed(1)} Red-Flag`
        )
      );
    } else {
      topLine.appendChild(el("span", "muted-note", "/ 100"));
    }
    scoreWrap.appendChild(topLine);
    scoreWrap.appendChild(createContributionBarSvg(bd.contributions, 8));

    const miniBreak = el("div", "score-mini-breakdown");
    miniBreak.appendChild(
      el(
        "span",
        "text-pos",
        `${state.proMode ? "Q" : "Biz"} +${Number(bd.contributions.quality).toFixed(1)}`
      )
    );
    miniBreak.appendChild(
      el(
        "span",
        "text-indigo",
        `${state.proMode ? "G" : "Grow"} +${Number(bd.contributions.growth).toFixed(1)}`
      )
    );
    miniBreak.appendChild(
      el(
        "span",
        "text-cyan",
        `${state.proMode ? "V" : "Price"} +${Number(bd.contributions.value).toFixed(1)}`
      )
    );
    miniBreak.appendChild(
      el(
        "span",
        "text-warn",
        `${state.proMode ? "H" : "Health"} +${Number(bd.contributions.momentum).toFixed(1)}`
      )
    );
    scoreWrap.appendChild(miniBreak);
    scoreTd.appendChild(scoreWrap);
    tr.appendChild(scoreTd);

    // 5. Price vs Fair Value
    const valTd = document.createElement("td");
    valTd.appendChild(
      el("div", "company-primary", formatStockPrice(s.price, stockCurrency(s)))
    );
    valTd.appendChild(
      el("span", "sector-sub", formatFriendlyPriceSub(s, pe, state.proMode))
    );
    valTd.appendChild(createFriendlyValZonePill(s, state.proMode));
    tr.appendChild(valTd);

    // 6. Business Snapshot (Simple View: Archetype + Plain English; Pro View: Archetype + Pro Ratios)
    const fundTd = document.createElement("td");
    const snapWrap = el("div", "snapshot-cell-wrap");
    snapWrap.appendChild(createArchetypePill(pe));

    if (state.proMode) {
      const fundList = el("div", "fund-snapshot-list");
      const medRoce =
        s.metrics.med_5y_roce_pct !== undefined
          ? s.metrics.med_5y_roce_pct
          : s.metrics.roce_pct;
      const stab =
        s.metrics.moat_stability_score !== undefined ? s.metrics.moat_stability_score : 70;
      const qPat =
        s.metrics.qtr_pat_yoy_pct !== undefined
          ? s.metrics.qtr_pat_yoy_pct
          : s.metrics.pat_cagr_3y_pct;

      fundList.appendChild(
        el(
          "span",
          medRoce >= (s.is_financial ? 15 : 18) ? "text-pos" : "",
          `5Y Med ${s.is_financial ? "ROE" : "ROCE"}: ${medRoce}%`
        )
      );
      fundList.appendChild(
        el(
          "span",
          stab >= 68 ? "text-cyan" : stab < 45 ? "text-warn" : "",
          s.metrics.buyback_equity
            ? `CFO/Debt: ${s.metrics.cfo_to_debt_pct}% (Buyback Eq)`
            : `8Y Moat Stability: ${stab}/100`
        )
      );
      fundList.appendChild(
        el(
          "span",
          qPat >= 12 ? "text-pos" : qPat < 0 ? "text-neg" : "",
          `2Q PAT YoY: ${fmtSigned(qPat)}% • F-Score ${s.metrics.piotroski_f_score}/9`
        )
      );
      snapWrap.appendChild(fundList);
    } else {
      const qStep = pe.receipt_steps && pe.receipt_steps[0];
      const gStep = pe.receipt_steps && pe.receipt_steps[1];
      const qRow0 = qStep && qStep.rows && qStep.rows[0];
      const gRow0 = gStep && gStep.rows && gStep.rows[0];
      if (qRow0 && qRow0.simple_value) {
        snapWrap.appendChild(
          el("span", `snapshot-plain-line ${toneClass(qRow0.tone)}`.trim(), qRow0.simple_value)
        );
      }
      if (gRow0 && gRow0.simple_value) {
        snapWrap.appendChild(
          el("span", "snapshot-plain-line", `5Y Sales: ${gRow0.simple_value}`)
        );
      }
    }
    fundTd.appendChild(snapWrap);
    tr.appendChild(fundTd);

    // 7. Breakdown / Deep Dive + Paper Trade Buttons
    const actionTd = document.createElement("td");
    const actStack = el("div", "action-cell-group");
    const ddBtn = el(
      "button",
      "btn-deep-dive",
      state.proMode ? "Deep Dive →" : "See Why →"
    );
    ddBtn.type = "button";
    ddBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openDeepDive(s.ticker);
    });
    const ptBtn = el("button", "btn-paper-trade-xs", "Paper Trade");
    ptBtn.type = "button";
    ptBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openPaperOrderTicket(s, { side: "BUY", orderType: "LIMIT" });
    });
    actStack.appendChild(ddBtn);
    actStack.appendChild(ptBtn);
    actionTd.appendChild(actStack);
    tr.appendChild(actionTd);

    tr.addEventListener("click", () => openDeepDive(s.ticker));
    tbody.appendChild(tr);
  }
}

function renderStage1Table(rows) {
  document.getElementById("table-panel-title").textContent =
    `Stage 1: Raw Price & Momentum Funnel (${rows.length} Liquid Stocks)`;
  document.getElementById("table-panel-sub").textContent =
    "Ranked on 12M-1M Momentum, 6M Relative Strength, 200-DMA Trend & Liquidity";
  document.getElementById("visible-count-badge").textContent =
    `${rows.length} Stage-1 Candidates`;

  setTableHeaders([
    "S1 #",
    "Company & Market Tag",
    "S1 Quant Score",
    "Audit Status",
    "CMP",
    "12M-1M Mom",
    "6M Ret",
    "vs 52W High",
    "200-DMA",
    "Annual Vol",
  ]);

  const tbody = document.getElementById("screener-tbody");
  tbody.replaceChildren();

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.dataset.ticker = r.ticker;

    tr.appendChild(el("td", "", `#${r.stage1_rank}`));

    const compTd = document.createElement("td");
    const line = el("div", "company-primary");
    line.appendChild(el("span", "", r.name));
    line.appendChild(el("span", "ticker-tag", displaySymbol(r.ticker)));
    line.appendChild(createMarketTag(r));
    compTd.appendChild(line);
    compTd.appendChild(el("span", "sector-sub", r.sector));
    tr.appendChild(compTd);

    tr.appendChild(el("td", "score-big text-cyan", Number(r.stage1_score || 0).toFixed(1)));

    const statusTd = document.createElement("td");
    if (r.deep_scored) {
      statusTd.appendChild(el("span", "badge badge-strong-buy", "Deep Scored ✓"));
      tr.addEventListener("click", () => openDeepDive(r.ticker));
    } else {
      const btn = el("button", "btn btn-secondary btn-xs", "Deep Score →");
      btn.type = "button";
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        btn.textContent = "Scoring...";
        btn.disabled = true;
        await syncSpecificTicker(r.ticker);
      });
      statusTd.appendChild(btn);
    }
    tr.appendChild(statusTd);

    tr.appendChild(el("td", "", formatStockPrice(r.last_price, stockCurrency(r))));
    tr.appendChild(
      el(
        "td",
        r.mom_12_1_pct >= 0 ? "text-pos" : "text-neg",
        `${fmtSigned(r.mom_12_1_pct)}%`
      )
    );
    tr.appendChild(
      el(
        "td",
        r.ret_6m_pct >= 0 ? "text-pos" : "text-neg",
        `${fmtSigned(r.ret_6m_pct)}%`
      )
    );
    tr.appendChild(el("td", "", `${r.dist_52w_high_pct}%`));
    tr.appendChild(
      el("td", r.above_200dma ? "text-pos" : "text-warn", r.above_200dma ? "Above ✓" : "Below")
    );
    tr.appendChild(el("td", "", `${r.volatility_pct}%`));

    tbody.appendChild(tr);
  }
}

// --- Slide-Over Stock Score Reasoning & Forensic Deep Dive Drawer ---

function getDrawerNavList() {
  return state.visibleStocks && state.visibleStocks.length > 0
    ? state.visibleStocks
    : state.stocks;
}

function updateDrawerNavButtons(ticker) {
  const list = getDrawerNavList();
  const idx = list.findIndex((s) => s.ticker === ticker);
  const prevBtn = document.getElementById("dd-prev-btn");
  const nextBtn = document.getElementById("dd-next-btn");
  const navLbl = document.getElementById("dd-nav-label");

  if (idx >= 0) {
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= list.length - 1;
    navLbl.textContent = `Viewing #${idx + 1} of ${list.length} in current view`;
  } else {
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    navLbl.textContent = `Inspecting ${displaySymbol(ticker)}`;
  }
}

async function stepDeepDive(delta) {
  const list = getDrawerNavList();
  const idx = list.findIndex((s) => s.ticker === state.selectedTicker);
  const nextIdx = idx + delta;
  if (idx >= 0 && nextIdx >= 0 && nextIdx < list.length) {
    await openDeepDive(list[nextIdx].ticker);
  }
}

function closeDeepDive() {
  state.drawerOpen = false;
  document.getElementById("deep-dive-backdrop").classList.add("hidden");
  document.getElementById("deep-dive-drawer").classList.add("hidden");
  document.body.classList.remove("drawer-open");
  for (const row of document.querySelectorAll("#screener-tbody tr")) {
    row.classList.remove("selected-row");
  }
}

async function openDeepDive(ticker) {
  const isSameTicker =
    state.currentDetail &&
    state.currentDetail.scorecard &&
    state.currentDetail.scorecard.ticker === ticker;

  state.selectedTicker = ticker;
  state.drawerOpen = true;
  syncModeButtons();

  document.getElementById("deep-dive-backdrop").classList.remove("hidden");
  document.getElementById("deep-dive-drawer").classList.remove("hidden");
  document.body.classList.add("drawer-open");

  for (const row of document.querySelectorAll("#screener-tbody tr")) {
    row.classList.toggle("selected-row", row.dataset.ticker === ticker);
  }
  updateDrawerNavButtons(ticker);

  const preset = document.getElementById("screener-preset").value;
  const customWeights = preset === "custom" ? getActiveCustomWeights() : null;

  try {
    let detail;
    if (state.staticMode) {
      detail = await getCompanyDetailSnapshot(ticker, preset, customWeights);
    } else {
      let url = `/api/company/${encodeURIComponent(ticker)}?preset=${encodeURIComponent(preset)}`;
      if (preset === "custom" && customWeights) {
        url += `&w_q=${encodeURIComponent(customWeights.quality)}&w_v=${encodeURIComponent(
          customWeights.value
        )}&w_g=${encodeURIComponent(customWeights.growth)}&w_m=${encodeURIComponent(
          customWeights.momentum
        )}`;
      }
      detail = await apiRequest(url);
    }
    state.currentDetail = detail;
    renderCompanyDetail(detail);
    if (!isSameTicker) {
      const scrollBody = document.getElementById("company-detail-content");
      if (scrollBody) scrollBody.scrollTop = 0;
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

function normalizeBankAction(rawAction) {
  const raw = String(rawAction || "").trim();
  const low = raw.toLowerCase();
  if (low === "up" || low.includes("upgrade")) {
    return { label: "Upgrade", cls: "action-upgrade" };
  }
  if (low === "down" || low.includes("downgrade")) {
    return { label: "Downgrade", cls: "action-downgrade" };
  }
  if (low === "init" || low.includes("initiat")) {
    return { label: "Initiated", cls: "action-init" };
  }
  if (low === "reit" || low.includes("reiterat")) {
    return { label: "Reiterated", cls: "action-main" };
  }
  if (low === "main" || low.includes("maintain")) {
    return { label: "Maintained", cls: "action-main" };
  }
  const fallback = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Maintained";
  return { label: fallback, cls: "action-main" };
}

function buildStreetMetricBox(label, primaryText, subtitleText, colorCls = "") {
  const box = el("div", "street-metric-box");
  box.appendChild(el("div", "street-m-label", label));
  box.appendChild(el("div", `street-m-val ${colorCls}`.trim(), primaryText));
  if (subtitleText) {
    box.appendChild(el("div", "street-m-sub", subtitleText));
  }
  return box;
}

function buildStreetConsensusCard(sc, mergedMarketObj, ccy, proMode = false) {
  const st = sc.street || {};
  const m = sc.metrics || {};
  const us = isUSStock(mergedMarketObj);

  const card = el("div", "street-card");

  // 1. Header + Coverage Badge
  const header = el("div", "street-header");
  const headLeft = document.createElement("div");
  headLeft.appendChild(
    el(
      "div",
      "dd-section-title",
      proMode
        ? "Wall Street & Dalal Street Institutional Consensus"
        : "What Professional Bank Analysts Think"
    )
  );
  headLeft.appendChild(
    el(
      "div",
      "muted-note",
      proMode
        ? "Sell-side analyst targets, 30d/90d EPS revision breadth & verified long-only institutional holdings"
        : "Ratings, 12-month price targets & profit forecast changes from covering bank analysts"
    )
  );
  header.appendChild(headLeft);

  const covRow = el("div", "street-coverage-row");
  const analystCount = Math.max(0, Math.round(Number(st.analyst_count || 0)));
  const buyPct = Math.max(0, Math.min(100, Number(st.consensus_buy_pct || 0)));
  covRow.appendChild(
    el(
      "span",
      `street-coverage-badge ${buyPct < 50 ? "street-neutral" : ""}`.trim(),
      `${analystCount} Covering Analysts • ${Math.round(buyPct)}% Recommend Buy`
    )
  );
  header.appendChild(covRow);
  card.appendChild(header);

  // 2. Analyst Consensus Stacked Bar (SVG + Count Legend)
  const barWrap = el("div", "street-consensus-bar-wrap");
  barWrap.appendChild(createConsensusBarSvg(st));
  card.appendChild(barWrap);

  // 3. 4 Key Street Metrics Strip
  const strip = el("div", "street-metrics-grid");

  // Metric 1: 12M Mean Target & Implied Upside
  const targetMean = Number(st.target_mean ?? st.target_mean_price ?? 0);
  const targetLow = Number(st.target_low ?? st.target_low_price ?? 0);
  const targetHigh = Number(st.target_high ?? st.target_high_price ?? 0);
  const cmp = Number(sc.price || 0);
  const upsidePct =
    st.target_upside_pct !== undefined && st.target_upside_pct !== null
      ? Number(st.target_upside_pct)
      : targetMean > 0 && cmp > 0
      ? ((targetMean - cmp) / cmp) * 100
      : 0;

  if (targetMean > 0) {
    const tgtCls = upsidePct >= 10 ? "text-pos" : upsidePct <= -5 ? "text-neg" : "text-cyan";
    const rangeSub =
      targetLow > 0 && targetHigh > 0
        ? `${formatStockPrice(targetLow, ccy)} — ${formatStockPrice(targetHigh, ccy)} analyst range`
        : "Average 12-month analyst price target";
    strip.appendChild(
      buildStreetMetricBox(
        proMode ? "12M Mean Target & Upside" : "Average 12-Month Target",
        `${formatStockPrice(targetMean, ccy)} (${fmtSigned(upsidePct, 1)}%)`,
        rangeSub,
        tgtCls
      )
    );
  } else {
    strip.appendChild(
      buildStreetMetricBox(
        proMode ? "12M Mean Target & Upside" : "Average 12-Month Target",
        "Target Not Published",
        "Analyst ratings active; price target undisclosed"
      )
    );
  }

  // Metric 2: EPS Revision Momentum (30d/90d)
  const up30 = Math.max(0, Math.round(Number(st.eps_rev_up_30d || 0)));
  const dn30 = Math.max(0, Math.round(Number(st.eps_rev_down_30d || 0)));
  const up90 = Math.max(0, Math.round(Number(st.eps_rev_up_90d || 0)));
  const dn90 = Math.max(0, Math.round(Number(st.eps_rev_down_90d || 0)));
  const use30d = up30 + dn30 >= 3 || up90 + dn90 === 0;
  const upShow = use30d ? up30 : up90;
  const dnShow = use30d ? dn30 : dn90;
  const winTag = use30d ? "30d" : "90d";
  const revBreadth = Number(st.rev_breadth_pct || 0);

  if (upShow + dnShow > 0) {
    const revCls = revBreadth >= 15 ? "text-pos" : revBreadth <= -15 ? "text-neg" : "text-warn";
    if (proMode) {
      const revSub =
        use30d && up90 + dn90 > 0
          ? `${winTag} window • 90d: ${up90} Up vs ${dn90} Down`
          : `${winTag} consensus EPS revision window`;
      strip.appendChild(
        buildStreetMetricBox(
          "EPS Revision Momentum",
          `${upShow} Up vs ${dnShow} Down (${fmtSigned(revBreadth, 0)}% Breadth)`,
          revSub,
          revCls
        )
      );
    } else {
      strip.appendChild(
        buildStreetMetricBox(
          "Profit Forecast Changes",
          `${upShow} Raised vs ${dnShow} Cut`,
          `Analysts updating profit forecasts over the past ${use30d ? "30 days" : "90 days"}`,
          revCls
        )
      );
    }
  } else {
    strip.appendChild(
      buildStreetMetricBox(
        proMode ? "EPS Revision Momentum" : "Profit Forecast Changes",
        proMode ? "0 Up vs 0 Down (Steady)" : "Forecasts Steady",
        proMode
          ? "Unchanged FY1 consensus EPS over 30d/90d"
          : "Analysts kept profit estimates unchanged recently",
        "text-cyan"
      )
    );
  }

  // Metric 3: Forward Consensus Growth + Forward P/E
  const fy1 = Number(st.fwd_eps_growth_fy1_pct || 0);
  const fy2 = Number(st.fwd_eps_growth_fy2_pct || 0);
  const fwdPe = Number(st.forward_pe || 0);
  const fwdGrowthText =
    fy1 !== 0 || fy2 !== 0
      ? proMode
        ? `FY1 ${fmtSigned(fy1, 1)}% • FY2 ${fmtSigned(fy2, 1)}%`
        : `Next Yr ${fmtSigned(fy1, 1)}% • Yr 2 ${fmtSigned(fy2, 1)}%`
      : "Forecast Pending";
  const fwdCls = fy1 >= 12 ? "text-pos" : fy1 < 0 ? "text-neg" : "text-indigo";
  const trailingValid = m.pe_ratio > 0 && m.pe_ratio < 99;
  const fwdPeSub = proMode
    ? fwdPe > 0 && fwdPe < 99
      ? `Forward P/E: ${fwdPe.toFixed(1)}x${
          trailingValid ? ` (Trailing ${Number(m.pe_ratio).toFixed(1)}x)` : ""
        }`
      : `Trailing P/E: ${trailingValid ? `${Number(m.pe_ratio).toFixed(1)}x` : "N/M"}`
    : fwdPe > 0 && fwdPe < 99
    ? `Trades at ${fwdPe.toFixed(1)}x expected next-year profits`
    : trailingValid
    ? `Trades at ${Number(m.pe_ratio).toFixed(1)}x current profits`
    : "Profit recovery watched by analysts";
  strip.appendChild(
    buildStreetMetricBox(
      proMode ? "Forward Consensus Growth" : "Expected Profit Growth",
      fwdGrowthText,
      fwdPeSub,
      fwdCls
    )
  );

  // Metric 4: Long-Only Institutional Ownership
  const instHeld = Number(st.inst_held_pct || m.inst_pct || 0);
  const promPct = Number(m.promoter_pct || 0);
  const holders = Array.isArray(st.top_holders)
    ? st.top_holders
        .map((h) => (typeof h === "string" ? h : (h && (h.name || h.organization)) || ""))
        .filter(Boolean)
    : [];
  const ownPrimary = us
    ? `${instHeld.toFixed(1)}% Held by Big Funds`
    : promPct > 0
    ? proMode
      ? `${instHeld.toFixed(1)}% FII/DII • ${promPct.toFixed(1)}% Promoter`
      : `${instHeld.toFixed(1)}% Mutual/Global Funds • ${promPct.toFixed(1)}% Founders`
    : `${instHeld.toFixed(1)}% Held by Big Funds`;
  const ownSub =
    holders.length > 0
      ? holders.slice(0, 3).join(", ")
      : us
      ? "Verified long-term institutional investors"
      : "Founders + long-term mutual & pension funds";
  strip.appendChild(
    buildStreetMetricBox(
      proMode ? "Long-Only Institutional Ownership" : "Long-Term Fund & Founder Backing",
      ownPrimary,
      ownSub,
      "text-cyan"
    )
  );

  card.appendChild(strip);

  card.appendChild(
    el(
      "div",
      "street-footnote",
      proMode
        ? "Options market-maker 13F noise (e.g. Jane Street/Citadel hedges) excluded."
        : "Short-term options trading firms are filtered out so only real long-term investors are shown."
    )
  );

  // 4. Recent Tier-1 Bank Rating Actions
  const actions = Array.isArray(st.recent_bank_actions) ? st.recent_bank_actions : [];
  if (actions.length > 0) {
    const actWrap = el("div", "street-actions-wrap");
    actWrap.appendChild(
      el(
        "div",
        "street-actions-title",
        proMode
          ? "Recent Tier-1 Bank & Institutional Rating Actions"
          : "Recent Bank Analyst Upgrades & Rating Calls"
      )
    );
    const actList = el("div", "bank-actions-list");
    for (const item of actions.slice(0, 5)) {
      const pill = el("div", "bank-action-pill");
      pill.appendChild(el("span", "bank-firm", item.firm || "Research Desk"));

      const toG = String(item.to_grade || "").trim();
      const fromG = String(item.from_grade || "").trim();
      const gradeLabel =
        fromG && toG && fromG !== toG ? `${fromG} → ${toG}` : toG || fromG || "Rated";
      pill.appendChild(el("span", "bank-grade", gradeLabel));

      const normAct = normalizeBankAction(item.action);
      pill.appendChild(el("span", `bank-action-tag ${normAct.cls}`, normAct.label));

      if (item.date) {
        pill.appendChild(el("span", "bank-date", String(item.date)));
      }
      actList.appendChild(pill);
    }
    actWrap.appendChild(actList);
    card.appendChild(actWrap);
  }

  return card;
}

function renderAiMemoResultIntoMount(mountEl, aiBtn, memoData) {
  mountEl.replaceChildren();
  if (!memoData) return;

  if (memoData.available === false) {
    const note = el(
      "div",
      "ai-memo-unavailable",
      memoData.reason ||
        "AI Analyst Memo is unavailable right now. Open the live Netlify deployment where Netlify AI Gateway is active out-of-the-box."
    );
    mountEl.appendChild(note);
    if (aiBtn) {
      aiBtn.textContent = "✨ Ask AI Analyst (Custom Deep-Dive Memo)";
      aiBtn.disabled = false;
    }
    return;
  }

  const card = el("div", "ai-memo-card");
  const top = el("div", "ai-memo-top");
  const topLeft = el("div", "inline-group wrap-group");
  topLeft.appendChild(el("span", "ai-memo-badge", "✨ AI Investment Educator Memo"));
  if (memoData.as_of_date) {
    topLeft.appendChild(el("span", "muted-note", `Data as of ${memoData.as_of_date}`));
  }
  top.appendChild(topLeft);

  const topRight = el("div", "inline-group wrap-group");
  if (memoData.model_used) {
    topRight.appendChild(el("span", "ai-memo-badge", String(memoData.model_used)));
  }
  topRight.appendChild(
    el(
      "span",
      memoData.cached
        ? "ai-memo-badge ai-memo-badge-cached"
        : "ai-memo-badge ai-memo-badge-live",
      memoData.cached ? "Cached" : "Live AI"
    )
  );
  top.appendChild(topRight);
  card.appendChild(top);

  if (memoData.headline) {
    card.appendChild(el("div", "ai-memo-headline", memoData.headline));
  }

  const grid = el("div", "ai-memo-grid");

  if (memoData.business_overview) {
    const b1 = el("div", "ai-memo-block");
    b1.appendChild(el("div", "ai-memo-block-title", "What the Business Does"));
    b1.appendChild(el("div", "ai-memo-block-body", memoData.business_overview));
    grid.appendChild(b1);
  }

  if (memoData.why_score_lands_here) {
    const b2 = el("div", "ai-memo-block");
    b2.appendChild(el("div", "ai-memo-block-title", "Why the Score Lands Here"));
    b2.appendChild(el("div", "ai-memo-block-body", memoData.why_score_lands_here));
    grid.appendChild(b2);
  }

  if (memoData.key_risks_to_watch) {
    const riskText = Array.isArray(memoData.key_risks_to_watch)
      ? memoData.key_risks_to_watch.join(" ")
      : String(memoData.key_risks_to_watch);
    const b3 = el("div", "ai-memo-block block-risk block-full");
    b3.appendChild(el("div", "ai-memo-block-title text-warn", "Key Risks to Watch"));
    b3.appendChild(el("div", "ai-memo-block-body", riskText));
    grid.appendChild(b3);
  }

  if (memoData.bottom_line_for_investor) {
    const b4 = el("div", "ai-memo-block block-bottom block-full");
    b4.appendChild(
      el("div", "ai-memo-block-title text-pos", "Bottom Line for an Everyday Investor")
    );
    b4.appendChild(el("div", "ai-memo-block-body", memoData.bottom_line_for_investor));
    grid.appendChild(b4);
  }

  card.appendChild(grid);
  mountEl.appendChild(card);

  if (aiBtn) {
    aiBtn.textContent = "✓ AI Analyst Memo Ready";
    aiBtn.disabled = false;
  }
}

function renderCompanyDetail(detail) {
  const container = document.getElementById("company-detail-content");
  container.replaceChildren();
  const sc = detail && detail.scorecard;
  if (!sc) {
    container.appendChild(
      el("div", "empty-state-box", "Scorecard unavailable for this company.")
    );
    return;
  }

  const comp = (detail && detail.company) || {};
  const mergedMarketObj = {
    market: sc.market || comp.market || "IN",
    currency: sc.currency || comp.currency || "INR",
    index_tag: sc.index_tag || comp.index_tag || "",
    market_label: sc.market_label || comp.market_label || "",
  };
  const us = isUSStock(mergedMarketObj);
  const idxTag = resolveIndexTag(mergedMarketObj);
  const ccy = stockCurrency(mergedMarketObj);
  const m = sc.metrics || {};
  const bd = resolveScoreBreakdown(sc);
  const pe = resolvePlainEnglish(sc, comp);
  const pro = Boolean(state.proMode);

  // =========================================================================
  // SECTION 1 — Hero + "What This Company Does"
  // =========================================================================
  const hero = el("div", "dd-hero-card");
  const heroTop = el("div", "dd-hero-top");

  const heroLeft = el("div", "dd-hero-left");
  heroLeft.appendChild(createScoreRingSvg(sc.composite_score, sc.rating, 74));

  const heroMetaWrap = document.createElement("div");
  const heroBadges = el("div", "dd-hero-badges");
  heroBadges.appendChild(el("span", "ticker-tag", sc.ticker));
  heroBadges.appendChild(createMarketTag(mergedMarketObj));
  heroBadges.appendChild(createArchetypePill(pe));
  heroBadges.appendChild(el("span", "pill", sc.sector));
  heroMetaWrap.appendChild(heroBadges);

  heroMetaWrap.appendChild(el("div", "dd-hero-title", sc.name));
  heroMetaWrap.appendChild(
    el(
      "div",
      "muted-note",
      `${pro ? "Market Cap" : "Company Size"}: ${formatMarketCap(
        sc.market_cap_cr,
        mergedMarketObj.market,
        ccy
      )} • ${sc.cap_tier || "Large Cap"}${sc.rank ? ` • Rank #${sc.rank}` : ""}`
    )
  );
  heroLeft.appendChild(heroMetaWrap);

  const heroRight = el("div", "dd-hero-right");
  heroRight.appendChild(el("div", "dd-cmp", formatStockPrice(sc.price, ccy)));
  const ratingWrap = el("div", "top-gap");
  ratingWrap.appendChild(el("span", ratingBadgeClass(sc.rating), sc.rating));
  heroRight.appendChild(ratingWrap);
  heroRight.appendChild(createFriendlyValZonePill(sc, pro));
  const heroTradeWrap = el("div", "top-gap");
  const heroTradeBtn = el("button", "btn btn-paper-trade btn-xs", "Paper Trade / Set Dip Limit");
  heroTradeBtn.type = "button";
  heroTradeBtn.addEventListener("click", () => {
    openPaperOrderTicket(sc, { side: "BUY", orderType: "LIMIT" });
  });
  heroTradeWrap.appendChild(heroTradeBtn);
  heroRight.appendChild(heroTradeWrap);

  heroTop.appendChild(heroLeft);
  heroTop.appendChild(heroRight);
  hero.appendChild(heroTop);

  // Crisp "What This Company Does" inner panel
  const whatBox = el("div", "dd-what-box");
  const whatHeader = el("div", "dd-what-header");
  whatHeader.appendChild(el("span", "dd-what-label", "What This Company Does"));
  if (comp.industry) {
    whatHeader.appendChild(el("span", "dd-industry-pill", comp.industry));
  }
  whatBox.appendChild(whatHeader);
  whatBox.appendChild(el("div", "dd-what-text", pe.what_it_does));

  const bannerCls =
    sc.rating === "Buy"
      ? "banner-buy"
      : sc.rating === "Hold"
      ? "banner-hold"
      : sc.rating === "Avoid"
      ? "banner-avoid"
      : "";
  whatBox.appendChild(
    el("div", `dd-verdict-banner ${bannerCls}`.trim(), `Plain Verdict: ${pe.one_line_verdict}`)
  );
  hero.appendChild(whatBox);
  container.appendChild(hero);

  // =========================================================================
  // SECTION 2 — "The Bottom Line (30-Second Plain-English Summary)" + Ask AI Analyst
  // =========================================================================
  const blCard = el("div", "bottom-line-card");
  const blHeader = el("div", "bottom-line-header");
  const blTitleWrap = document.createElement("div");
  blTitleWrap.appendChild(
    el("div", "dd-section-title", "The Bottom Line (30-Second Plain-English Summary)")
  );
  blTitleWrap.appendChild(
    el(
      "div",
      "muted-note",
      "Why it earned this rank in plain money terms — business quality, stock price fairness & track record"
    )
  );
  blHeader.appendChild(blTitleWrap);

  const aiBtn = el("button", "btn-ai-memo", "✨ Ask AI Analyst (Custom Deep-Dive Memo)");
  aiBtn.type = "button";
  aiBtn.id = "dd-ai-memo-btn";
  blHeader.appendChild(aiBtn);
  blCard.appendChild(blHeader);

  const blList = el("div", "bottom-line-list");
  const summaryLines = Array.isArray(pe.bottom_line_summary) ? pe.bottom_line_summary : [];
  summaryLines.slice(0, 3).forEach((sentence, idx) => {
    const item = el("div", "bottom-line-item");
    const stepCls = idx === 1 ? "bl-step-2" : idx === 2 ? "bl-step-3" : "";
    item.appendChild(el("span", `bl-step-badge ${stepCls}`.trim(), String(idx + 1)));
    item.appendChild(el("div", "bl-text", sentence));
    blList.appendChild(item);
  });
  blCard.appendChild(blList);

  const aiMemoMount = el("div", "ai-memo-mount");
  blCard.appendChild(aiMemoMount);

  if (state.aiMemoCache.has(sc.ticker)) {
    renderAiMemoResultIntoMount(aiMemoMount, aiBtn, state.aiMemoCache.get(sc.ticker));
  } else if (state.aiMemoInFlight.has(sc.ticker)) {
    aiBtn.disabled = true;
    aiBtn.textContent = "Generating AI Memo...";
    const loadingBox = el("div", "ai-memo-loading");
    loadingBox.appendChild(el("span", "ai-pulse-dot"));
    loadingBox.appendChild(
      el(
        "span",
        "",
        "Generating plain-English analyst memo from 8Y financials & Street consensus..."
      )
    );
    aiMemoMount.appendChild(loadingBox);
  }

  aiBtn.addEventListener("click", async () => {
    const targetTicker = sc.ticker;
    if (state.aiMemoCache.has(targetTicker)) {
      renderAiMemoResultIntoMount(aiMemoMount, aiBtn, state.aiMemoCache.get(targetTicker));
      return;
    }
    if (state.aiMemoInFlight.has(targetTicker)) {
      return;
    }

    state.aiMemoInFlight.add(targetTicker);
    aiBtn.disabled = true;
    aiBtn.textContent = "Generating AI Memo...";
    aiMemoMount.replaceChildren();
    const loadingBox = el("div", "ai-memo-loading");
    loadingBox.appendChild(el("span", "ai-pulse-dot"));
    loadingBox.appendChild(
      el(
        "span",
        "",
        "Generating plain-English analyst memo from 8Y financials & Street consensus..."
      )
    );
    aiMemoMount.appendChild(loadingBox);

    try {
      const memoRes = await fetchAiAnalystMemo(sc);
      if (memoRes && memoRes.available !== false) {
        state.aiMemoCache.set(targetTicker, memoRes);
      }
      if (state.selectedTicker === targetTicker && state.drawerOpen) {
        renderAiMemoResultIntoMount(aiMemoMount, aiBtn, memoRes);
      }
    } finally {
      state.aiMemoInFlight.delete(targetTicker);
    }
  });

  container.appendChild(blCard);

  // =========================================================================
  // SECTION 3 — "How It Earned X / 100 (Simple Score Receipt)"
  // =========================================================================
  const receiptCard = el("div", "dd-section-card");
  receiptCard.appendChild(
    el(
      "div",
      "dd-section-title",
      pro
        ? `How It Earned ${sc.composite_score.toFixed(1)} / 100 — Weighted Pillar Waterfall`
        : `How It Earned ${sc.composite_score.toFixed(1)} / 100 (Simple Score Receipt)`
    )
  );
  receiptCard.appendChild(
    el(
      "div",
      "dd-section-sub",
      pro
        ? `Exact weighted pillar contributions & guardrail deductions under ${
            PRESET_NAMES[bd.preset_used] || "Active Philosophy"
          }`
        : "Four everyday questions add up to 100 points — minus any red-flag deductions"
    )
  );
  receiptCard.appendChild(createContributionBarSvg(bd.contributions, 10));

  const receiptList = el("div", "receipt-list");
  const stepPtsClasses = {
    quality: "text-pos",
    growth: "text-indigo",
    value: "text-cyan",
    momentum: "text-warn",
  };

  for (const step of pe.receipt_steps) {
    const sRow = el("div", "receipt-step-row");
    const mainCol = el("div", "receipt-step-main");
    const titleLine = el("div", "receipt-title-line");
    titleLine.appendChild(
      el("span", "receipt-step-title", pro ? step.pro_title || step.simple_title : step.simple_title)
    );
    if (step.verdict_tag) {
      titleLine.appendChild(el("span", verdictTagClass(step.verdict_tag), step.verdict_tag));
    }
    mainCol.appendChild(titleLine);
    if (step.plain_why) {
      mainCol.appendChild(el("div", "receipt-plain-why", step.plain_why));
    }
    sRow.appendChild(mainCol);

    const rightCol = el("div", "receipt-step-right");
    const ptsColor = stepPtsClasses[step.key] || "text-cyan";
    const ptsAdded =
      step.points_added !== undefined
        ? Number(step.points_added)
        : Number((bd.contributions && bd.contributions[step.key]) || 0);
    const sc100 = Number(step.score_100 || 0);
    const wtPct =
      step.weight_pct !== undefined
        ? Number(step.weight_pct)
        : Number((bd.weights_pct && bd.weights_pct[step.key]) || 25);

    rightCol.appendChild(el("div", `receipt-pts ${ptsColor}`, `+${ptsAdded.toFixed(1)} pts`));
    rightCol.appendChild(
      el(
        "div",
        "receipt-sub-score",
        pro
          ? `${sc100.toFixed(1)} / 100 × ${wtPct.toFixed(1)}% wt`
          : `${Math.round(sc100)} / 100 (${Math.round(wtPct)}% weight)`
      )
    );
    sRow.appendChild(rightCol);
    receiptList.appendChild(sRow);
  }

  // Red-flag deductions / clean safety check row
  const penItems = bd.penalty_items || [];
  if (penItems.length > 0) {
    for (const item of penItems) {
      const pRow = el("div", "receipt-step-row penalty-row");
      const pMain = el("div", "receipt-step-main");
      const pTitleLine = el("div", "receipt-title-line");
      pTitleLine.appendChild(
        el(
          "span",
          "receipt-step-title text-neg",
          pro ? "Guardrail Penalty" : "Red-Flag Deduction"
        )
      );
      pMain.appendChild(pTitleLine);
      pMain.appendChild(
        el("div", "receipt-plain-why", pro ? item.reason : formatPlainPenaltyReason(item.reason))
      );
      pRow.appendChild(pMain);

      const pRight = el("div", "receipt-step-right");
      const ptsNum = Number(item.points || 0);
      const ptsStr = ptsNum < 0 ? `${ptsNum.toFixed(1)} pts` : `-${ptsNum.toFixed(1)} pts`;
      pRight.appendChild(el("div", "receipt-pts text-neg", ptsStr));
      pRight.appendChild(el("div", "receipt-sub-score", "Safety deduction"));
      pRow.appendChild(pRight);
      receiptList.appendChild(pRow);
    }
  } else {
    const cleanRow = el("div", "receipt-step-row clean-row");
    const cMain = el("div", "receipt-step-main");
    cMain.appendChild(
      el(
        "div",
        "receipt-step-title text-pos",
        pro ? "Forensic & Valuation Guardrails" : "Red-Flag & Safety Check"
      )
    );
    cMain.appendChild(
      el(
        "div",
        "receipt-plain-why",
        "Zero accounting, debt, or sudden profit-drop red flags triggered"
      )
    );
    cleanRow.appendChild(cMain);
    const cRight = el("div", "receipt-step-right");
    cRight.appendChild(el("div", "receipt-pts text-pos", "0.0 pts"));
    cRight.appendChild(el("div", "receipt-sub-score", "No deductions"));
    cleanRow.appendChild(cRight);
    receiptList.appendChild(cleanRow);
  }

  const totalRow = el("div", "receipt-step-row total-row");
  const tMain = el("div", "receipt-step-main");
  tMain.appendChild(
    el("div", "receipt-step-title", pro ? "Final Composite Score" : "Final Overall Score")
  );
  tMain.appendChild(
    el(
      "div",
      "receipt-plain-why",
      `${Number(bd.raw_composite).toFixed(1)} points from 4 steps − ${Number(
        bd.total_penalty || 0
      ).toFixed(1)} red-flag deductions`
    )
  );
  totalRow.appendChild(tMain);

  const tRight = el("div", "receipt-step-right");
  tRight.appendChild(
    el("div", "receipt-pts text-pos", `${sc.composite_score.toFixed(1)} / 100`)
  );
  tRight.appendChild(el("div", "receipt-sub-score", sc.rating));
  totalRow.appendChild(tRight);
  receiptList.appendChild(totalRow);

  receiptCard.appendChild(receiptList);
  if (pro && bd.rating_rule) {
    receiptCard.appendChild(el("div", "rule-verdict-box", `Verdict Rule: ${bd.rating_rule}`));
  }
  container.appendChild(receiptCard);

  // In Pro View, also show Institutional Bull Thesis vs Forensic Guardrail bullets
  if (pro) {
    const thesisGrid = el("div", "dd-two-col");
    const bullBox = el("div", "thesis-box");
    bullBox.appendChild(el("div", "thesis-title text-pos", "Institutional Bull Thesis & Moats"));
    const bullList = el("ul", "thesis-list");
    for (const sItem of sc.strengths || []) {
      bullList.appendChild(el("li", "", `✓ ${sItem}`));
    }
    bullBox.appendChild(bullList);
    thesisGrid.appendChild(bullBox);

    const flagBox = el("div", "thesis-box");
    const hasFlags = sc.red_flags && sc.red_flags.length > 0;
    flagBox.appendChild(
      el(
        "div",
        hasFlags ? "thesis-title text-neg" : "thesis-title text-cyan",
        "Forensic & Valuation Guardrails"
      )
    );
    const flagList = el("ul", "thesis-list");
    if (hasFlags) {
      for (const fItem of sc.red_flags) {
        flagList.appendChild(el("li", "text-neg", `⚠ ${fItem}`));
      }
    } else {
      flagList.appendChild(
        el("li", "text-pos", "✓ Zero forensic accounting, leverage, or earnings contraction flags")
      );
      flagList.appendChild(
        el(
          "li",
          "",
          `✓ Profitable in ${m.profit_consistency || "5/5"} recent audited fiscal years`
        )
      );
      flagList.appendChild(
        el("li", "", `✓ Valuation check: ${sc.valuation_zone || "Fair GARP Price"}`)
      );
    }
    flagBox.appendChild(flagList);
    thesisGrid.appendChild(flagBox);
    container.appendChild(thesisGrid);
  }

  // =========================================================================
  // SECTION 4 — 4 Plain-English Question Cards (2x2 Grid)
  // =========================================================================
  const stepBarHex = {
    quality: "#10b981",
    growth: "#818cf8",
    value: "#38bdf8",
    momentum: "#f59e0b",
  };
  const qGrid = el("div", "dd-two-col");

  pe.receipt_steps.forEach((step, idx) => {
    const qCard = el("div", "question-card");
    const qHead = el("div", "q-card-header");
    const qTitleWrap = el("div", "q-card-title-wrap");
    qTitleWrap.appendChild(
      el("span", "ev-title", pro ? step.pro_title || step.simple_title : step.simple_title)
    );
    if (step.verdict_tag) {
      qTitleWrap.appendChild(el("span", verdictTagClass(step.verdict_tag), step.verdict_tag));
    }
    qHead.appendChild(qTitleWrap);

    const scColor = stepPtsClasses[step.key] || "text-cyan";
    const scVal = Number(step.score_100 || 0);
    qHead.appendChild(
      el("span", `q-card-score ${scColor}`, `${scVal.toFixed(pro ? 1 : 0)} / 100`)
    );
    qCard.appendChild(qHead);
    qCard.appendChild(createProgressSvg(scVal, stepBarHex[step.key] || "#38bdf8"));

    const rowsWrap = el("div", "q-metrics-list");
    for (const row of step.rows || []) {
      const mRow = el("div", "q-metric-row");
      const left = el("div", "q-m-left");
      const right = el("div", "q-m-right");
      const tCls = toneClass(row.tone);

      if (pro) {
        left.appendChild(el("span", "q-m-label", row.pro_label || row.simple_label));
        const subParts = [row.simple_label, row.target_hint].filter(Boolean);
        if (subParts.length > 0) {
          left.appendChild(el("span", "q-m-sub", subParts.join(" • ")));
        }
        right.appendChild(
          el("span", `q-m-val ${tCls}`.trim(), row.pro_value || row.simple_value)
        );
        if (row.simple_value && row.simple_value !== row.pro_value) {
          right.appendChild(el("span", "q-m-val-sub", row.simple_value));
        }
      } else {
        left.appendChild(el("span", "q-m-label", row.simple_label));
        if (row.target_hint) {
          left.appendChild(el("span", "q-m-sub", row.target_hint));
        }
        right.appendChild(el("span", `q-m-val ${tCls}`.trim(), row.simple_value));
      }

      mRow.appendChild(left);
      mRow.appendChild(right);
      rowsWrap.appendChild(mRow);
    }
    qCard.appendChild(rowsWrap);

    // Card 4: Plain-English Safety Checks in Simple View, Piotroski Checks in Pro View
    if (step.key === "momentum" || idx === 3) {
      const checksToShow = pro
        ? sc.piotroski_checks && sc.piotroski_checks.length > 0
          ? sc.piotroski_checks
          : pe.safety_checks_plain || []
        : pe.safety_checks_plain && pe.safety_checks_plain.length > 0
        ? pe.safety_checks_plain
        : [];
      if (checksToShow.length > 0) {
        const checksWrap = el("div", "fscore-checks-wrap");
        for (const chk of checksToShow) {
          checksWrap.appendChild(el("span", "check-pill", `✓ ${chk}`));
        }
        qCard.appendChild(checksWrap);
      }
    }

    qGrid.appendChild(qCard);
  });

  container.appendChild(qGrid);

  // =========================================================================
  // SECTION 5 — Expert / Analyst Consensus Card + 5Y Price Chart + 6Y Financials
  // =========================================================================
  if (sc.street && sc.street.has_coverage && Number(sc.street.analyst_count || 0) > 0) {
    container.appendChild(buildStreetConsensusCard(sc, mergedMarketObj, ccy, pro));
  }

  // 5-Year Price Chart
  const chartCard = el("div", "dd-section-card");
  const idxChartLabel =
    idxTag === "NASDAQ100"
      ? "NASDAQ 100 · USD $"
      : idxTag === "SP500"
      ? "S&P 500 · USD $"
      : "NIFTY 200 · INR ₹";
  const lineHex = idxTag === "SP500" ? "#a78bfa" : idxTag === "NASDAQ100" ? "#38bdf8" : "#10b981";
  const fillRgba =
    idxTag === "SP500"
      ? "rgba(167, 139, 250, 0.14)"
      : idxTag === "NASDAQ100"
      ? "rgba(56, 189, 248, 0.14)"
      : "rgba(16, 185, 129, 0.12)";
  chartCard.appendChild(
    el(
      "div",
      "dd-section-title",
      pro
        ? `5-Year Historical Price Trajectory (${idxChartLabel})`
        : `5-Year Stock Price History (${idxChartLabel})`
    )
  );
  chartCard.appendChild(
    el(
      "div",
      "dd-section-sub",
      pro
        ? "Daily adjusted close history used for point-in-time valuation & momentum"
        : `5-year share price trend in ${ccy === "USD" ? "US Dollars ($)" : "Indian Rupees (₹)"}`
    )
  );
  const chartBox = el("div", "chart-box-sm");
  chartCard.appendChild(chartBox);
  container.appendChild(chartCard);

  const ph = detail.price_history || [];
  renderMultiLineChart(
    chartBox,
    [
      {
        name: sc.ticker,
        values: ph.map((p) => p.close_price),
        color: lineHex,
        areaFill: fillRgba,
      },
    ],
    ph.map((p) => p.trade_date),
    (v) => formatStockPrice(v, ccy),
    { height: 185 }
  );

  // 6-Year Audited Financials Table (Clear plain-English headers in Simple View, Pro labels in Pro View)
  const finCard = el("div", "dd-section-card");
  finCard.appendChild(
    el(
      "div",
      "dd-section-title",
      pro
        ? `6-Year Audited Consolidated Financials (${us ? "USD Millions · $M" : "INR Crores · ₹Cr"})`
        : `6-Year Sales & Profit Track Record (${
            us ? "Amounts in $ Millions" : "Amounts in ₹ Crores"
          })`
    )
  );
  finCard.appendChild(
    el(
      "div",
      "dd-section-sub",
      pro
        ? us
          ? "Official SEC EDGAR XBRL 10-K audited annual statements"
          : "Audited consolidated NSE annual filings"
        : "Official audited yearly company results over the last 6 financial years"
    )
  );

  const fTableWrap = el("div", "table-scroll");
  const fTable = el("table", "quant-table");
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  const unitTag = us ? "($M)" : "(₹Cr)";
  const finCols = pro
    ? [
        "FY",
        `Sales ${unitTag}`,
        `EBITDA ${unitTag}`,
        `PAT ${unitTag}`,
        sc.is_financial ? "ROE %" : "ROCE %",
        "OPM %",
        sc.is_financial ? "D/E" : "CFO/EBITDA",
      ]
    : [
        "Year",
        `Annual Sales ${unitTag}`,
        `Operating Profit ${unitTag}`,
        `Net Profit ${unitTag}`,
        sc.is_financial ? "Return on Equity" : "Return on Capital",
        "Profit Margin",
        sc.is_financial ? `Shareholder Equity ${unitTag}` : "Cash Conversion",
      ];
  for (const col of finCols) {
    htr.appendChild(el("th", "", col));
  }
  thead.appendChild(htr);
  fTable.appendChild(thead);

  const locale = us ? "en-US" : "en-IN";
  const ftbody = document.createElement("tbody");
  for (const f of (detail.fundamentals || []).slice(-6)) {
    const r = document.createElement("tr");
    r.appendChild(el("td", "company-primary", `FY${String(f.fiscal_year).slice(-2)}`));
    r.appendChild(el("td", "", Math.round(Number(f.revenue_cr || 0)).toLocaleString(locale)));
    r.appendChild(el("td", "", Math.round(Number(f.ebitda_cr || 0)).toLocaleString(locale)));
    const patVal = Number(f.net_profit_cr || 0);
    r.appendChild(
      el("td", patVal < 0 ? "text-neg" : "text-pos", Math.round(patVal).toLocaleString(locale))
    );
    r.appendChild(el("td", "", `${sc.is_financial ? f.roe_pct : f.roce_pct}%`));
    r.appendChild(el("td", "", `${f.op_margin_pct}%`));
    if (pro) {
      r.appendChild(
        el(
          "td",
          "",
          sc.is_financial
            ? `${f.debt_to_equity}x`
            : `${Math.round(Number(f.cfo_to_ebitda_pct || 0))}%`
        )
      );
    } else {
      r.appendChild(
        el(
          "td",
          "",
          sc.is_financial
            ? Math.round(Number(f.total_equity_cr || 0)).toLocaleString(locale)
            : `${Math.round(Number(f.cfo_to_ebitda_pct || 0))}%`
        )
      );
    }
    ftbody.appendChild(r);
  }
  fTable.appendChild(ftbody);
  fTableWrap.appendChild(fTable);
  finCard.appendChild(fTableWrap);
  container.appendChild(finCard);
}

// --- Funnel Actions, Live Sync & CSV Import ---

async function syncSpecificTicker(rawTicker) {
  if (state.staticMode) {
    showToast(
      "Cloud Snapshot Mode: Run the local FastAPI engine (uvicorn app.main:app) to sync custom live tickers."
    );
    return;
  }
  try {
    const res = await apiRequest("/api/sync/ticker", {
      method: "POST",
      jsonBody: { ticker: rawTicker },
    });
    showToast(
      `Synced ${res.sync.ticker} (${res.sync.name}): ${res.sync.price_days_synced} price days, ${res.sync.fundamental_years_synced} audited FYs.`
    );
    state.selectedTicker = res.sync.ticker;
    state.backtestLoaded = false;
    state.plannerLoaded = false;
    await loadScreener(true);
    await openDeepDive(res.sync.ticker);
  } catch (err) {
    showToast(err.message, true);
  }
}

async function handleLiveTickerSync() {
  const input = document.getElementById("sync-ticker-input");
  const raw = input.value.trim();
  if (!raw) {
    showToast("Enter an NSE symbol such as ZOMATO.NS or DIXON.NS.", true);
    return;
  }
  const btn = document.getElementById("sync-ticker-btn");
  btn.textContent = "Syncing...";
  btn.disabled = true;
  await syncSpecificTicker(raw);
  btn.textContent = "Sync Stock";
  btn.disabled = false;
}

async function handleFastPriceRefresh() {
  if (state.staticMode) {
    showToast(
      "Cloud Snapshot Mode: Live Yahoo Finance batch price refresh requires the local FastAPI server."
    );
    return;
  }
  const btn = document.getElementById("fast-prices-btn");
  btn.textContent = "Refreshing Prices...";
  btn.disabled = true;
  try {
    const res = await apiRequest("/api/funnel/prices", {
      method: "POST",
      jsonBody: {},
    });
    showToast(
      `Weekly Price Sync Complete: Updated ${res.tickers_refreshed} stocks (${res.spark_batch_calls} batch calls).`
    );
    state.backtestLoaded = false;
    state.plannerLoaded = false;
    await loadScreener(false);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.textContent = "Weekly Price Refresh (4s)";
    btn.disabled = false;
  }
}

async function handleExpandFunnel() {
  if (state.staticMode) {
    showToast("Cloud Snapshot Mode: Universe is already pre-scored in this snapshot.");
    return;
  }
  const btn = document.getElementById("expand-funnel-btn");
  btn.textContent = "Deep-Scoring Next 30...";
  btn.disabled = true;
  try {
    const res = await apiRequest("/api/funnel/expand", {
      method: "POST",
      jsonBody: { batch_size: 30 },
    });
    showToast(
      `Deep-scored ${res.companies_deep_scored} additional candidates (${res.annual_rows_saved} audited FY statements).`
    );
    state.backtestLoaded = false;
    state.plannerLoaded = false;
    await loadScreener(true);
  } catch (err) {
    showToast(err.message, true);
    btn.disabled = false;
  }
}

async function handleRefreshFunnel() {
  if (state.staticMode) {
    showToast(
      "Cloud Snapshot Mode: Run uvicorn app.main:app locally to trigger live funnel sync."
    );
    return;
  }
  const btn = document.getElementById("refresh-funnel-btn");
  btn.textContent = "Syncing Funnel...";
  btn.disabled = true;
  showToast("Refreshing prices & checking stale fundamentals (7-day TTL cache active)...");
  try {
    const res = await apiRequest("/api/funnel/refresh", {
      method: "POST",
      jsonBody: { shortlist_top_n: 60 },
    });
    showToast(
      `Synced ${res.stage1_scanned} stocks & verified/updated ${res.stage2_deep_scored} companies!`
    );
    state.backtestLoaded = false;
    state.plannerLoaded = false;
    await loadScreener(true);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.textContent = "Full Funnel Sync";
    btn.disabled = false;
  }
}

async function handleCsvUpload() {
  const fileInput = document.getElementById("csv-file-input");
  if (!fileInput.files || fileInput.files.length === 0) {
    showToast("Select a .csv file first.", true);
    return;
  }

  try {
    if (state.staticMode) {
      const csvText = await fileInput.files[0].text();
      const imported = await importCsvInMemory(csvText);
      showToast(
        `Imported ${imported.companies_imported} companies (${imported.rows_imported} annual rows) into session.`
      );
    } else {
      const formData = new FormData();
      formData.append("file", fileInput.files[0]);
      const res = await apiRequest("/api/import/csv", {
        method: "POST",
        rawBody: formData,
      });
      showToast(
        `Imported ${res.imported.companies_imported} companies (${res.imported.rows_imported} annual rows).`
      );
    }
    fileInput.value = "";
    state.backtestLoaded = false;
    state.plannerLoaded = false;
    await loadScreener(true);
  } catch (err) {
    showToast(err.message, true);
  }
}

// --- Tab 2: Multi-Market Capital Deployment & Wealth Planner ---

async function runPlanner() {
  const btn = document.getElementById("run-planner-btn");
  const isUsdMode = isUsdMarketMode(state.plannerMarket);
  btn.textContent = "Building Blueprint...";
  btn.disabled = true;

  try {
    const selectedPreset = document.getElementById("screener-preset").value;
    const payload = {
      market: state.plannerMarket,
      lump_sum_inr: Number(
        document.getElementById("pl-lumpsum").value || (isUsdMode ? 10000 : 500000)
      ),
      monthly_sip_inr: Number(document.getElementById("pl-sip").value || 0),
      horizon_years: Number(document.getElementById("pl-horizon").value || 7),
      target_corpus_inr: Number(
        document.getElementById("pl-target").value || (isUsdMode ? 26000 : 1300000)
      ),
      risk_profile: document.getElementById("pl-risk").value,
      preset: selectedPreset === "custom" ? "qglp_compounder" : selectedPreset,
      max_stocks: 8,
      save_plan: false,
    };

    const res = state.staticMode
      ? await runPlannerSnapshot(payload)
      : await apiRequest("/api/planner", {
          method: "POST",
          jsonBody: payload,
        });
    state.plannerLoaded = true;
    renderPlannerResults(res);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.textContent = isUsdMarketMode(state.plannerMarket)
      ? "Build $ Blueprint"
      : "Build ₹ Blueprint";
    btn.disabled = false;
  }
}

function renderPlannerResults(plan) {
  state.currentPlan = plan;
  const planCcy =
    plan.plan_currency || (isUsdMarketMode(state.plannerMarket) ? "USD" : "INR");
  const g = plan.goal_summary || {};
  const d = plan.deployment_summary || {};
  const kpis = document.getElementById("pl-kpis");
  kpis.replaceChildren();

  const basketTitle = document.getElementById("pl-basket-title");
  if (state.plannerMarket === "NASDAQ100") {
    basketTitle.textContent = "Recommended US · Nasdaq 100 Buy Basket — Where to Invest & Why";
  } else if (state.plannerMarket === "SP500") {
    basketTitle.textContent =
      "Recommended US · S&P 500 (Non-Nasdaq) Buy Basket — Where to Invest & Why";
  } else if (state.plannerMarket === "US") {
    basketTitle.textContent =
      "Recommended All-US (Nasdaq 100 + S&P 500) Buy Basket — Where to Invest & Why";
  } else if (state.plannerMarket === "IN") {
    basketTitle.textContent = "Recommended India · Nifty 200 Buy Basket — Where to Invest & Why";
  } else {
    basketTitle.textContent = "Recommended Global Compounder Basket — Where to Invest & Why";
  }

  kpis.appendChild(
    buildKpiCard(
      "Equity Allocated in Shares",
      formatCurrencyCompact(d.deployed_in_shares_inr || 0, planCcy),
      `${d.sectors_covered || 0} Sectors • Unallocated Cash: ${formatExactAmount(
        d.residual_cash_inr || 0,
        planCcy
      )}`,
      "text-pos"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Entry Tranche Strategy",
      `${formatCurrencyCompact(d.immediate_tranche_inr || 0, planCcy)} Now`,
      d.staggered_dip_reserve_inr > 0
        ? `+ ${formatCurrencyCompact(d.staggered_dip_reserve_inr, planCcy)} held for 6–8% pullbacks`
        : "100% within Fair GARP P/E band — deploy today",
      "text-cyan"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Expected Median Corpus",
      formatCurrencyCompact(g.median_corpus_inr || 0, planCcy),
      `Bear 10th: ${formatCurrencyCompact(g.bear_10_corpus_inr || 0, planCcy)} → Bull 90th: ${formatCurrencyCompact(
        g.bull_90_corpus_inr || 0,
        planCcy
      )}`,
      "text-pos"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Goal Achievement Odds",
      `${g.goal_probability_pct}%`,
      g.recommended_extra_sip_inr > 0
        ? `Target ${formatCurrencyCompact(g.target_corpus_inr, planCcy)} • Add +${formatCurrencyCompact(
            g.recommended_extra_sip_inr,
            planCcy
          )}/mo SIP`
        : `On track for ${formatCurrencyCompact(g.target_corpus_inr, planCcy)} (${
            plan.expected_cagr_pct
          }% Est. CAGR)`,
      g.goal_probability_pct >= 60 ? "text-pos" : "text-warn"
    )
  );

  const bBody = document.getElementById("pl-basket-tbody");
  bBody.replaceChildren();
  for (const s of plan.stock_basket || []) {
    const tr = document.createElement("tr");

    // 1. Company & Portfolio Role + Market Tag
    const nameTd = document.createElement("td");
    const line = el("div", "company-primary");
    line.appendChild(el("span", "", s.name));
    line.appendChild(el("span", "ticker-tag", displaySymbol(s.ticker)));
    line.appendChild(createMarketTag(s));
    nameTd.appendChild(line);
    nameTd.appendChild(el("span", "sector-sub", `${s.sector} • ${s.role}`));
    tr.appendChild(nameTd);

    // 2. Verdict
    const rTd = document.createElement("td");
    rTd.appendChild(el("span", ratingBadgeClass(s.rating), s.rating));
    tr.appendChild(rTd);

    // 3. Score
    tr.appendChild(el("td", "score-big", Number(s.composite_score || 0).toFixed(1)));

    // 4. CMP vs Fair P/E (native stock currency)
    const cmpTd = document.createElement("td");
    cmpTd.appendChild(
      el("div", "company-primary", formatStockPrice(s.price, stockCurrency(s)))
    );
    cmpTd.appendChild(
      el("span", "sector-sub", `P/E ${formatPeVsFair({ pe_ratio: s.pe_ratio, fair_pe: s.fair_pe })}`)
    );
    tr.appendChild(cmpTd);

    // 5. Allocation & Shares (plan currency)
    const allocTd = document.createElement("td");
    allocTd.appendChild(
      el(
        "div",
        "company-primary text-pos",
        `${formatExactAmount(s.lump_sum_inr, planCcy)} (${s.est_shares} sh)`
      )
    );
    const subAlloc =
      s.monthly_sip_inr > 0
        ? `Weight ${s.equity_weight_pct}% • +${formatExactAmount(s.monthly_sip_inr, planCcy)}/mo SIP`
        : `Portfolio Weight: ${s.equity_weight_pct}%`;
    allocTd.appendChild(el("span", "sector-sub", subAlloc));
    tr.appendChild(allocTd);

    // 6. Entry Execution Plan
    tr.appendChild(
      el(
        "td",
        String(s.entry_guidance || "").startsWith("Buy 100%") ? "text-pos" : "text-cyan",
        s.entry_guidance
      )
    );

    // 7. Investment Rationale
    const whyTd = el("td", "cell-wrap");
    whyTd.appendChild(el("div", "", s.why_buy));
    if (s.strength_highlight) {
      whyTd.appendChild(el("span", "sector-sub text-pos", `✓ ${s.strength_highlight}`));
    }
    tr.appendChild(whyTd);

    // 8. Paper Trade & Deep Dive Buttons
    const ddTd = document.createElement("td");
    const actWrap = el("div", "action-cell-group");
    const ptBtn = el("button", "btn-paper-trade-xs", "Paper Trade");
    ptBtn.type = "button";
    ptBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openPaperOrderTicket(s, { side: "BUY", orderType: "LIMIT" });
    });
    const ddBtn = el("button", "btn-deep-dive", "Deep Dive →");
    ddBtn.type = "button";
    ddBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openDeepDive(s.ticker);
    });
    actWrap.appendChild(ptBtn);
    actWrap.appendChild(ddBtn);
    ddTd.appendChild(actWrap);
    tr.appendChild(ddTd);

    tr.addEventListener("click", () => openDeepDive(s.ticker));
    bBody.appendChild(tr);
  }

  const monList = document.getElementById("pl-monitoring-list");
  if (monList) {
    monList.replaceChildren();
    for (const rule of plan.monitoring_rules || []) {
      monList.appendChild(el("li", "", `• ${rule}`));
    }
  }

  const proj = plan.yearly_projections || [];
  renderMultiLineChart(
    document.getElementById("pl-cone-chart"),
    [
      {
        name: "Principal",
        values: proj.map((p) => p.invested_inr),
        color: "#64748b",
        dashed: true,
        width: 1.6,
      },
      {
        name: "Bear 10th",
        values: proj.map((p) => p.bear_10_inr),
        color: "#f59e0b",
        width: 2.0,
      },
      {
        name: "Base 50th",
        values: proj.map((p) => p.base_50_inr),
        color: "#10b981",
        areaFill: "rgba(16, 185, 129, 0.11)",
        width: 2.6,
      },
      {
        name: "Bull 90th",
        values: proj.map((p) => p.bull_90_inr),
        color: "#38bdf8",
        width: 2.0,
      },
    ],
    proj.map((p) => `Year ${p.year}`),
    (v) => formatCurrencyCompact(v, planCcy)
  );

  document.getElementById("pl-profile-label").textContent = plan.profile_label || "";
  const assetContainer = document.getElementById("pl-asset-bars");
  assetContainer.replaceChildren();
  const colors = ["#10b981", "#38bdf8", "#818cf8", "#f59e0b"];
  (plan.asset_allocation || []).forEach((a, idx) => {
    const row = el("div", "asset-row");
    const top = el("div", "asset-row-top");
    top.appendChild(el("span", "", a.asset));
    top.appendChild(el("span", "text-cyan", `${a.pct}%`));
    row.appendChild(top);
    row.appendChild(createProgressSvg(a.pct, colors[idx % colors.length]));

    const meta = el("div", "asset-meta");
    meta.appendChild(
      el("span", "", `Allocation: ${formatExactAmount(a.lump_sum_inr, planCcy)}`)
    );
    meta.appendChild(
      el("span", "", `Monthly SIP: ${formatExactAmount(a.monthly_sip_inr, planCcy)}/mo`)
    );
    meta.appendChild(el("span", "", `Est. CAGR: ${a.expected_return}%`));
    row.appendChild(meta);
    assetContainer.appendChild(row);
  });
}

// --- Tab 3: Multi-Market Point-in-Time Backtester ---

async function runBacktest() {
  const btn = document.getElementById("run-backtest-btn");
  btn.textContent = "Simulating...";
  btn.disabled = true;

  try {
    const isUsBt = isUsdMarketMode(state.backtestMarket);
    const payload = {
      market: state.backtestMarket,
      preset: document.getElementById("bt-preset").value,
      lookback_years: Number(document.getElementById("bt-years").value),
      top_n: Number(document.getElementById("bt-topn").value),
      rebalance: document.getElementById("bt-rebal").value,
      weighting: document.getElementById("bt-weight").value,
      initial_capital: isUsBt ? 10000 : 500000,
      cost_bps: 25,
    };

    const res = state.staticMode
      ? await runBacktestSnapshot(payload)
      : await apiRequest("/api/backtest", {
          method: "POST",
          jsonBody: payload,
        });
    state.backtestLoaded = true;
    renderBacktestResults(res);
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.textContent = "Run Backtest";
    btn.disabled = false;
  }
}

function renderBacktestResults(res) {
  const s = res.summary || {};
  const isUsBt = isUsdMarketMode(state.backtestMarket);
  const btCcy = s.currency || (isUsBt ? "USD" : "INR");
  const defaultBm =
    state.backtestMarket === "NASDAQ100"
      ? "Nasdaq 100 (^NDX)"
      : isUsBt
      ? "S&P 500 (^GSPC)"
      : "Nifty 50 (^NSEI)";
  const bmName = s.benchmark_name || defaultBm;
  const bmShort = bmName.includes("S&P")
    ? "S&P 500"
    : bmName.includes("Nasdaq")
    ? "Nasdaq 100"
    : "Nifty 50";
  const initLabel = btCcy === "USD" ? "$10,000" : "₹5,00,000";

  document.getElementById("bt-equity-title").textContent =
    `${initLabel} Wealth Growth vs. ${bmName}`;
  document.getElementById("bt-bm-legend").textContent = `${bmShort} Benchmark`;
  document.getElementById("bt-ledger-sub").textContent =
    `Point-in-time period returns vs. ${bmShort}`;
  document.getElementById("bt-ledger-bm-th").textContent = bmShort;

  document.getElementById("bt-guardrail-note").textContent =
    btCcy === "USD"
      ? `Bias Guardrails Active: 60-day SEC 10-K/10-Q point-in-time reporting lag enforced • Point-in-time Street signals guard active • 25 bps US execution slippage/friction • ${
          s.risk_free_rate_pct || 4.3
        }% US 10Y Treasury Sharpe risk-free rate.`
      : `Bias Guardrails Active: 60-day SEBI LODR reporting lag enforced on annual statements • Point-in-time Street signals guard active • 25 bps delivery friction/slippage • ${
          s.risk_free_rate_pct || 6.8
        }% India 10Y G-Sec Sharpe risk-free rate.`;

  const kpis = document.getElementById("bt-kpis");
  kpis.replaceChildren();

  const btScopeLabel =
    state.backtestMarket === "NASDAQ100"
      ? "Nasdaq 100"
      : state.backtestMarket === "SP500"
      ? "S&P 500"
      : state.backtestMarket === "US"
      ? "All US"
      : state.backtestMarket === "IN"
      ? "Nifty 200"
      : "Global";

  kpis.appendChild(
    buildKpiCard(
      `Strategy CAGR (${btScopeLabel})`,
      `${s.portfolio_cagr_pct}%`,
      `vs ${bmShort}: ${s.benchmark_cagr_pct}% (${s.start_date} → ${s.end_date})`,
      s.portfolio_cagr_pct >= s.benchmark_cagr_pct ? "text-pos" : "text-warn"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Annualized Alpha",
      `${fmtSigned(s.alpha_annual_pct, 2)}%`,
      `Info Ratio: ${s.information_ratio} • Win Rate: ${s.win_rate_pct}%`,
      s.alpha_annual_pct >= 0 ? "text-pos" : "text-neg"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      `Sharpe Ratio (Rf ${s.risk_free_rate_pct || (btCcy === "USD" ? 4.3 : 6.8)}%)`,
      String(s.sharpe_ratio),
      `Sortino: ${s.sortino_ratio} • ${bmShort} Sharpe: ${s.benchmark_sharpe}`,
      "text-cyan"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Max Drawdown",
      `${s.max_drawdown_pct}%`,
      `${bmShort} Max DD: ${s.benchmark_max_dd_pct}% • Beta: ${s.beta}`,
      "text-neg"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      `${btCcy === "USD" ? "$10,000" : "₹5.00 L"} Grown To`,
      formatCurrencyCompact(s.final_portfolio_inr, btCcy),
      `${bmShort} Passive: ${formatCurrencyCompact(s.final_benchmark_inr, btCcy)}`,
      "text-pos"
    )
  );

  const curve = res.equity_curve || [];
  const dates = curve.map((c) => c.date);

  renderMultiLineChart(
    document.getElementById("bt-equity-chart"),
    [
      {
        name: bmShort,
        values: curve.map((c) => c.benchmark_nav),
        color: "#94a3b8",
        dashed: true,
        width: 1.8,
      },
      {
        name: "Strategy",
        values: curve.map((c) => c.portfolio_nav),
        color: "#10b981",
        areaFill: "rgba(16, 185, 129, 0.12)",
        width: 2.5,
      },
    ],
    dates,
    (v) => formatCurrencyCompact(v, btCcy)
  );

  renderMultiLineChart(
    document.getElementById("bt-dd-chart"),
    [
      {
        name: `${bmShort} DD`,
        values: curve.map((c) => c.benchmark_dd_pct),
        color: "#94a3b8",
        dashed: true,
        width: 1.6,
      },
      {
        name: "Strategy DD",
        values: curve.map((c) => c.portfolio_dd_pct),
        color: "#f43f5e",
        areaFill: "rgba(244, 63, 94, 0.14)",
        width: 2.0,
      },
    ],
    dates,
    (v) => `${v.toFixed(1)}%`,
    { includeZero: true, areaBaseline: 0 }
  );

  const hBody = document.getElementById("bt-holdings-tbody");
  hBody.replaceChildren();
  for (const h of res.latest_holdings || []) {
    const tr = document.createElement("tr");

    const compTd = document.createElement("td");
    const line = el("div", "company-primary");
    line.appendChild(el("span", "", h.name));
    line.appendChild(el("span", "ticker-tag", displaySymbol(h.ticker)));
    line.appendChild(createMarketTag(h));
    compTd.appendChild(line);
    tr.appendChild(compTd);

    tr.appendChild(el("td", "muted-note", h.sector));

    const rTd = document.createElement("td");
    rTd.appendChild(el("span", ratingBadgeClass(h.rating), h.rating));
    tr.appendChild(rTd);

    tr.appendChild(el("td", "score-big", Number(h.composite_score || 0).toFixed(1)));
    tr.appendChild(el("td", "text-cyan", `${Number(h.weight_pct || 0).toFixed(1)}%`));

    const ddTd = document.createElement("td");
    const ddBtn = el("button", "btn-deep-dive", "Deep Dive →");
    ddBtn.type = "button";
    ddBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openDeepDive(h.ticker);
    });
    ddTd.appendChild(ddBtn);
    tr.appendChild(ddTd);

    tr.addEventListener("click", () => openDeepDive(h.ticker));
    hBody.appendChild(tr);
  }

  const lBody = document.getElementById("bt-ledger-tbody");
  lBody.replaceChildren();
  for (const row of res.rebalance_log || []) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", "", `${row.rebalance_date} → ${row.end_date}`));
    tr.appendChild(el("td", "muted-note", (row.top_picks || []).join(", ")));
    tr.appendChild(el("td", "", `${row.turnover_pct}%`));
    tr.appendChild(
      el(
        "td",
        row.period_return_pct >= 0 ? "text-pos" : "text-neg",
        `${row.period_return_pct}%`
      )
    );
    tr.appendChild(el("td", "", `${row.benchmark_return_pct}%`));
    tr.appendChild(
      el(
        "td",
        row.excess_return_pct >= 0 ? "text-pos" : "text-neg",
        `${fmtSigned(row.excess_return_pct, 2)}%`
      )
    );
    lBody.appendChild(tr);
  }
}

// --- PWA Service Worker & Install App UX ---

function registerPwaServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Ignore service worker registration errors in local headless test environments
      });
    });
  }
}

function initPwaInstallUx() {
  const installBtn = document.getElementById("install-pwa-btn");
  if (!installBtn) return;

  const isStandalone =
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true;
  if (isStandalone) {
    installBtn.classList.add("hidden");
    return;
  }

  const ua = String(window.navigator.userAgent || "");
  const isIosMobile = /iPhone|iPad|iPod/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua);
  if (isIosMobile && isSafari) {
    state.iosSafariInstallable = true;
    installBtn.classList.remove("hidden");
  }

  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault();
    state.deferredInstallPrompt = ev;
    installBtn.classList.remove("hidden");
  });

  window.addEventListener("appinstalled", () => {
    state.deferredInstallPrompt = null;
    installBtn.classList.add("hidden");
    showToast("ArthaQuant App installed! Open anytime from your Home Screen or Desktop.");
  });

  installBtn.addEventListener("click", async () => {
    if (state.deferredInstallPrompt) {
      const promptEvent = state.deferredInstallPrompt;
      promptEvent.prompt();
      const choice = await promptEvent.userChoice.catch(() => ({ outcome: "dismissed" }));
      if (choice && choice.outcome === "accepted") {
        state.deferredInstallPrompt = null;
        installBtn.classList.add("hidden");
      }
      return;
    }
    if (state.iosSafariInstallable) {
      showToast(
        "Install on iPhone/iPad: Tap the Safari Share icon below, then select 'Add to Home Screen'."
      );
    }
  });
}

async function handleDeployPlannerBlueprintClick() {
  if (!state.currentPlan) {
    await runPlanner();
  }
  if (state.currentPlan) {
    await openDeployBlueprintModal(state.currentPlan);
  }
}

// --- Event Listeners ---

document.addEventListener("DOMContentLoaded", () => {
  registerPwaServiceWorker();
  initPwaInstallUx();

  document.getElementById("auth-form").addEventListener("submit", handleAuthSubmit);
  document.getElementById("logout-btn").addEventListener("click", handleLogout);

  for (const tabBtn of document.querySelectorAll(".nav-tab, .mobile-nav-btn")) {
    tabBtn.addEventListener("click", () => switchTab(tabBtn.dataset.tab));
  }

  document.getElementById("toggle-data-drawer-btn").addEventListener("click", () => {
    document.getElementById("data-sync-drawer").classList.toggle("hidden");
  });

  // Market Switchers across all 3 tabs
  for (const btn of document.querySelectorAll("#screener-market-switcher .market-btn")) {
    btn.addEventListener("click", () => setScreenerMarket(btn.dataset.market));
  }
  for (const btn of document.querySelectorAll("#planner-market-switcher .market-btn")) {
    btn.addEventListener("click", () => setPlannerMarket(btn.dataset.market));
  }
  for (const btn of document.querySelectorAll("#bt-market-switcher .market-btn")) {
    btn.addEventListener("click", () => setBacktestMarket(btn.dataset.market));
  }

  // Data Sync Drawer Controls
  document.getElementById("view-stage2-btn").addEventListener("click", () => setFunnelView("stage2"));
  document.getElementById("view-stage1-btn").addEventListener("click", () => setFunnelView("stage1"));
  document.getElementById("fast-prices-btn").addEventListener("click", handleFastPriceRefresh);
  document.getElementById("expand-funnel-btn").addEventListener("click", handleExpandFunnel);
  document.getElementById("refresh-funnel-btn").addEventListener("click", handleRefreshFunnel);
  document.getElementById("sync-ticker-btn").addEventListener("click", handleLiveTickerSync);
  document.getElementById("csv-upload-btn").addEventListener("click", handleCsvUpload);

  // Screener Controls
  document.getElementById("screener-search").addEventListener("input", applyClientFiltersAndRender);
  document.getElementById("screener-sort").addEventListener("change", applyClientFiltersAndRender);
  document.getElementById("screener-preset").addEventListener("change", (ev) => {
    const isCustom = ev.target.value === "custom";
    document.getElementById("custom-weights-row").classList.toggle("hidden", !isCustom);
    renderFormulaBar();
    if (!isCustom) loadScreener(false);
  });
  document.getElementById("screener-sector").addEventListener("change", () => loadScreener(false));
  document.getElementById("apply-weights-btn").addEventListener("click", () => {
    renderFormulaBar();
    loadScreener(false);
  });

  // Planner, Paper Basket Deploy & Backtest Controls
  document.getElementById("run-planner-btn").addEventListener("click", runPlanner);
  document
    .getElementById("deploy-paper-basket-btn")
    .addEventListener("click", handleDeployPlannerBlueprintClick);
  document
    .getElementById("deploy-paper-basket-header-btn")
    .addEventListener("click", handleDeployPlannerBlueprintClick);
  document.getElementById("run-backtest-btn").addEventListener("click", runBacktest);

  // Simple / Pro Explanation Mode Switchers (Leaderboard & Sticky Deep Dive Drawer)
  document.getElementById("screener-mode-simple-btn").addEventListener("click", () => setProMode(false));
  document.getElementById("screener-mode-pro-btn").addEventListener("click", () => setProMode(true));
  document.getElementById("dd-mode-simple-btn").addEventListener("click", () => setProMode(false));
  document.getElementById("dd-mode-pro-btn").addEventListener("click", () => setProMode(true));

  // Slide-Over Deep Dive Drawer Controls + Paper Trade Trigger
  document.getElementById("dd-paper-trade-btn").addEventListener("click", () => {
    const target =
      (state.currentDetail && state.currentDetail.scorecard) || state.selectedTicker;
    openPaperOrderTicket(target, { side: "BUY", orderType: "LIMIT" });
  });
  document.getElementById("dd-close-btn").addEventListener("click", closeDeepDive);
  document.getElementById("deep-dive-backdrop").addEventListener("click", closeDeepDive);
  document.getElementById("dd-prev-btn").addEventListener("click", () => stepDeepDive(-1));
  document.getElementById("dd-next-btn").addEventListener("click", () => stepDeepDive(1));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closeAllPaperModals();
      closePaperAuthModal();
      if (state.drawerOpen) {
        closeDeepDive();
      }
    }
  });

  initAuth();
});
