// ArthaQuant Client-Side Institutional Engine (Netlify Cloud Snapshot Mode)
// Mirrors `app/factors.py`, `app/backtester.py`, and `app/planner.py` (V1.2)
// Security guarantees:
// - Zero innerHTML / outerHTML / insertAdjacentHTML / document.write
// - Zero localStorage / sessionStorage
// - Zero native alert() / confirm() / prompt()

const BENCHMARK_TICKER = "^NSEI";
const NASDAQ_BENCHMARK_TICKER = "^NDX";
const SP500_BENCHMARK_TICKER = "^GSPC";
const INDIA_RISK_FREE_RATE = 0.068;
const US_RISK_FREE_RATE = 0.043;
const USD_INR_TICKER = "USDINR=X";
const USD_INR_RATE = 93.44;
const ALLOWED_MARKETS = new Set(["ALL", "IN", "US", "NASDAQ100", "SP500"]);

const MARKET_MAKER_NOISE = [
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
];

export const PRESET_WEIGHTS = {
  qglp_compounder: { quality: 45.0, value: 20.0, growth: 25.0, momentum: 10.0 },
  street_quant: { quality: 35.0, value: 20.0, growth: 25.0, momentum: 20.0 },
  artha_blend: { quality: 35.0, value: 25.0, growth: 20.0, momentum: 20.0 },
  coffee_can: { quality: 55.0, value: 10.0, growth: 30.0, momentum: 5.0 },
  magic_formula: { quality: 45.0, value: 45.0, growth: 5.0, momentum: 5.0 },
  value_momentum: { quality: 10.0, value: 45.0, growth: 5.0, momentum: 40.0 },
};

const RISK_PROFILES = {
  equity_direct: {
    label: "100% Direct Long-Term NSE Compounder Basket (Buy & Hold 5Y+)",
    allocation: [
      { asset: "Core QGLP / Coffee-Can Compounders", pct: 65.0, expected_return: 14.5 },
      { asset: "GARP Growth & Value Leaders", pct: 35.0, expected_return: 16.0 },
    ],
    blended_mu: 0.148,
    blended_sigma: 0.165,
  },
  moderate: {
    label: "Moderate Multi-Asset (70% NSE Equity / 20% India Debt / 10% Gold)",
    allocation: [
      { asset: "Core QGLP / Coffee-Can Compounders", pct: 45.0, expected_return: 14.0 },
      { asset: "GARP Growth & Value Leaders", pct: 25.0, expected_return: 15.8 },
      { asset: "India G-Sec / Target Maturity Debt", pct: 20.0, expected_return: 7.2 },
      { asset: "Gold ETF / Sovereign Gold", pct: 10.0, expected_return: 8.5 },
    ],
    blended_mu: 0.125,
    blended_sigma: 0.128,
  },
  aggressive: {
    label: "Aggressive Wealth Builder (85% NSE Equity / 10% Liquid Reserve / 5% Gold)",
    allocation: [
      { asset: "Core QGLP / Coffee-Can Compounders", pct: 50.0, expected_return: 14.2 },
      { asset: "GARP Growth & Value Leaders", pct: 35.0, expected_return: 16.2 },
      { asset: "Liquid / T-Bill Opportunity Reserve", pct: 10.0, expected_return: 6.8 },
      { asset: "Gold ETF Hedge", pct: 5.0, expected_return: 8.5 },
    ],
    blended_mu: 0.139,
    blended_sigma: 0.152,
  },
  conservative: {
    label: "Conservative (45% NSE Equity / 40% India Debt / 15% Gold)",
    allocation: [
      { asset: "Core QGLP / Coffee-Can Compounders", pct: 30.0, expected_return: 13.5 },
      { asset: "GARP Value Leaders", pct: 15.0, expected_return: 15.0 },
      { asset: "India G-Sec / Corporate Bond Fund", pct: 40.0, expected_return: 7.2 },
      { asset: "Gold ETF / Sovereign Gold", pct: 15.0, expected_return: 8.5 },
    ],
    blended_mu: 0.104,
    blended_sigma: 0.088,
  },
};

const US_RISK_PROFILES = {
  equity_direct: {
    label: "100% Direct Long-Term Nasdaq-100 Compounder Basket (Buy & Hold 5Y+)",
    allocation: [
      { asset: "Core QGLP / Coffee-Can Compounders", pct: 65.0, expected_return: 12.8 },
      { asset: "GARP Growth & Value Leaders", pct: 35.0, expected_return: 14.2 },
    ],
    blended_mu: 0.132,
    blended_sigma: 0.168,
  },
  moderate: {
    label: "Moderate Multi-Asset (70% US Equity / 20% US Treasury / 10% Gold)",
    allocation: [
      { asset: "Core QGLP / Coffee-Can Compounders", pct: 45.0, expected_return: 12.5 },
      { asset: "GARP Growth & Value Leaders", pct: 25.0, expected_return: 14.0 },
      { asset: "US 10Y Treasury / IG Bond ETF", pct: 20.0, expected_return: 4.4 },
      { asset: "Gold ETF Hedge", pct: 10.0, expected_return: 6.5 },
    ],
    blended_mu: 0.106,
    blended_sigma: 0.128,
  },
  aggressive: {
    label: "Aggressive Wealth Builder (85% US Equity / 10% T-Bills / 5% Gold)",
    allocation: [
      { asset: "Core QGLP / Coffee-Can Compounders", pct: 50.0, expected_return: 12.6 },
      { asset: "GARP Growth & Value Leaders", pct: 35.0, expected_return: 14.4 },
      { asset: "US T-Bill Opportunity Reserve", pct: 10.0, expected_return: 4.3 },
      { asset: "Gold ETF Hedge", pct: 5.0, expected_return: 6.5 },
    ],
    blended_mu: 0.121,
    blended_sigma: 0.152,
  },
  conservative: {
    label: "Conservative (45% US Equity / 40% US Treasury / 15% Gold)",
    allocation: [
      { asset: "Core QGLP / Coffee-Can Compounders", pct: 30.0, expected_return: 12.0 },
      { asset: "GARP Value Leaders", pct: 15.0, expected_return: 13.2 },
      { asset: "US Treasury / IG Corporate Bond ETF", pct: 40.0, expected_return: 4.5 },
      { asset: "Gold ETF Hedge", pct: 15.0, expected_return: 6.5 },
    ],
    blended_mu: 0.084,
    blended_sigma: 0.088,
  },
};

function resolveMarketAndIndexTag(item) {
  const rawTag = String((item && item.index_tag) || "")
    .trim()
    .toUpperCase();
  let marketCode;
  let indexTag;
  if ((item && item.market === "US") || rawTag === "NASDAQ100" || rawTag === "SP500") {
    marketCode = "US";
    indexTag = rawTag === "SP500" ? "SP500" : "NASDAQ100";
  } else {
    marketCode = "IN";
    indexTag = "NIFTY200";
  }
  let marketLabel;
  if (indexTag === "NASDAQ100") {
    marketLabel = "US Stock · NASDAQ 100";
  } else if (indexTag === "SP500") {
    marketLabel = "US Stock · S&P 500";
  } else {
    marketLabel = "Indian Stock · NIFTY 200";
  }
  const currency = marketCode === "US" ? "USD" : "INR";
  return { marketCode, indexTag, marketLabel, currency };
}

function matchesMarketFilter(marketCode, indexTag, filterVal) {
  if (filterVal === "IN") return marketCode === "IN";
  if (filterVal === "US") return marketCode === "US";
  if (filterVal === "NASDAQ100") return indexTag === "NASDAQ100";
  if (filterVal === "SP500") return indexTag === "SP500";
  return true;
}

function safeFloat(val, fallback = 0.0) {
  if (val === null || val === undefined || val === "") return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function safeInt(val, fallback = 0) {
  if (val === null || val === undefined || val === "") return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function jsRoundInt(val) {
  const r = Math.floor(val + 0.5);
  return r === 0 ? 0 : r;
}

function buildStreetPayload(ssig, streetAvail, curPrice) {
  if (!streetAvail || !ssig) {
    return {
      has_coverage: false,
      analyst_count: 0,
      strong_buy: 0,
      buy: 0,
      hold: 0,
      sell: 0,
      strong_sell: 0,
      consensus_buy_pct: 0.0,
      recommendation_key: "",
      target_mean: 0.0,
      target_high: 0.0,
      target_low: 0.0,
      target_upside_pct: 0.0,
      forward_pe: 0.0,
      fwd_eps_growth_fy1_pct: 0.0,
      fwd_eps_growth_fy2_pct: 0.0,
      eps_rev_up_30d: 0,
      eps_rev_down_30d: 0,
      eps_rev_up_90d: 0,
      eps_rev_down_90d: 0,
      rev_breadth_pct: 0.0,
      inst_held_pct: 0.0,
      recent_bank_actions: [],
      top_holders: [],
    };
  }

  const analystCount = Math.max(0, safeInt(ssig.analyst_count, 0));
  const hasCoverage = analystCount > 0;
  const strongBuy = Math.max(0, safeInt(ssig.strong_buy ?? ssig.strong_buy_count, 0));
  const buy = Math.max(0, safeInt(ssig.buy ?? ssig.buy_count, 0));
  const hold = Math.max(0, safeInt(ssig.hold ?? ssig.hold_count, 0));
  const sell = Math.max(0, safeInt(ssig.sell ?? ssig.sell_count, 0));
  const strongSell = Math.max(0, safeInt(ssig.strong_sell ?? ssig.strong_sell_count, 0));

  const targetMean = roundTo(safeFloat(ssig.target_mean ?? ssig.target_mean_price, 0.0), 2);
  const targetHigh = roundTo(safeFloat(ssig.target_high ?? ssig.target_high_price, 0.0), 2);
  const targetLow = roundTo(safeFloat(ssig.target_low ?? ssig.target_low_price, 0.0), 2);
  const targetUpsidePct =
    hasCoverage && targetMean > 0.0 && curPrice > 0.0
      ? roundTo((targetMean / curPrice - 1.0) * 100.0, 1)
      : 0.0;

  let rawActions = ssig.recent_bank_actions;
  if (rawActions === undefined && ssig.recent_bank_actions_json) {
    try {
      rawActions = JSON.parse(String(ssig.recent_bank_actions_json));
    } catch (_err) {
      rawActions = [];
    }
  }
  const actionsOut = [];
  if (Array.isArray(rawActions)) {
    for (const act of rawActions.slice(0, 5)) {
      if (act && typeof act === "object") {
        actionsOut.push({
          firm: String(act.firm || ""),
          to_grade: String(act.to_grade || act.toGrade || ""),
          from_grade: String(act.from_grade || act.fromGrade || ""),
          action: String(act.action || ""),
          date: String(act.date || ""),
        });
      }
    }
  }

  let rawHolders = ssig.top_holders;
  if (rawHolders === undefined && ssig.top_holders_json) {
    try {
      rawHolders = JSON.parse(String(ssig.top_holders_json));
    } catch (_err) {
      rawHolders = [];
    }
  }
  const holdersOut = [];
  if (Array.isArray(rawHolders)) {
    for (const h of rawHolders) {
      const hName =
        h && typeof h === "object"
          ? String(h.organization || h.name || "").trim()
          : String(h || "").trim();
      if (!hName) continue;
      const hLow = hName.toLowerCase();
      if (MARKET_MAKER_NOISE.some((noise) => hLow.includes(noise))) continue;
      holdersOut.push(hName);
      if (holdersOut.length >= 4) break;
    }
  }

  return {
    has_coverage: hasCoverage,
    analyst_count: analystCount,
    strong_buy: strongBuy,
    buy,
    hold,
    sell,
    strong_sell: strongSell,
    consensus_buy_pct: roundTo(safeFloat(ssig.consensus_buy_pct, 0.0), 1),
    recommendation_key: String(ssig.recommendation_key || ""),
    target_mean: targetMean,
    target_high: targetHigh,
    target_low: targetLow,
    target_upside_pct: targetUpsidePct,
    forward_pe: roundTo(safeFloat(ssig.forward_pe, 0.0), 1),
    fwd_eps_growth_fy1_pct: roundTo(safeFloat(ssig.fwd_eps_growth_fy1_pct, 0.0), 1),
    fwd_eps_growth_fy2_pct: roundTo(safeFloat(ssig.fwd_eps_growth_fy2_pct, 0.0), 1),
    eps_rev_up_30d: Math.max(0, safeInt(ssig.eps_rev_up_30d, 0)),
    eps_rev_down_30d: Math.max(0, safeInt(ssig.eps_rev_down_30d, 0)),
    eps_rev_up_90d: Math.max(0, safeInt(ssig.eps_rev_up_90d, 0)),
    eps_rev_down_90d: Math.max(0, safeInt(ssig.eps_rev_down_90d, 0)),
    rev_breadth_pct: roundTo(safeFloat(ssig.rev_breadth_pct, 0.0), 1),
    inst_held_pct: roundTo(safeFloat(ssig.inst_held_pct, 0.0), 1),
    recent_bank_actions: actionsOut,
    top_holders: holdersOut,
  };
}

function resolveRiskProfile(riskProfile, market) {
  if (market === "US" || market === "NASDAQ100" || market === "SP500") {
    const baseUs = US_RISK_PROFILES[riskProfile] || US_RISK_PROFILES.equity_direct;
    if (market === "SP500") {
      return { ...baseUs, label: baseUs.label.replace("Nasdaq-100", "S&P 500") };
    }
    if (market === "US") {
      return { ...baseUs, label: baseUs.label.replace("Nasdaq-100", "US S&P 500 + Nasdaq-100") };
    }
    return baseUs;
  }
  const base = RISK_PROFILES[riskProfile] || RISK_PROFILES.equity_direct;
  if (market === "ALL") {
    return {
      ...base,
      label: base.label.replace("NSE ", "Global NSE + US "),
    };
  }
  return base;
}

function latestValidPrice(arr) {
  if (!arr || arr.length === 0) return 0.0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0) {
      return Number(v);
    }
  }
  return 0.0;
}

function resolveUsdInrRate(snapshot, overrideRate = null) {
  if (overrideRate !== null && overrideRate !== undefined && overrideRate !== "") {
    const ov = Number(overrideRate);
    if (Number.isFinite(ov) && ov > 0) return roundTo(ov, 2);
  }
  const prices = snapshot && snapshot.prices;
  const live = prices ? latestValidPrice(prices[USD_INR_TICKER]) : 0.0;
  return live > 0 ? roundTo(live, 2) : USD_INR_RATE;
}

function countNonNullPrices(arr) {
  if (!arr || arr.length === 0) return 0;
  let cnt = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) cnt += 1;
  }
  return cnt;
}

const COMMODITY_KEYWORDS = [
  "aluminium",
  "copper",
  "steel",
  "zinc",
  "coal",
  "mining",
  "metal",
  "vedanta",
  "hindalco",
  "nmdc",
  "iron",
  "petroleum",
];

let cachedSnapshotPromise = null;

function clamp(val, lo = 0.0, hi = 100.0) {
  return Math.max(lo, Math.min(hi, val));
}

function roundTo(val, decimals = 1) {
  const f = Math.pow(10, decimals);
  return Math.round(val * f) / f;
}

function linearScore(val, bad, good) {
  if (!Number.isFinite(val) || good === bad) return 50.0;
  return clamp(((val - bad) / (good - bad)) * 100.0, 0.0, 100.0);
}

function median(values) {
  if (!values || values.length === 0) return 0.0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

function pstdev(values) {
  if (!values || values.length === 0) return 0.0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sq = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(sq);
}

function sampleStd(values) {
  if (!values || values.length < 2) return 0.0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sq = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (values.length - 1);
  return Math.sqrt(sq);
}

function resolveWeights(preset, custom) {
  let raw;
  if (preset === "custom" && custom) {
    raw = {
      quality: Math.max(0, Number(custom.quality ?? 45)),
      value: Math.max(0, Number(custom.value ?? 20)),
      growth: Math.max(0, Number(custom.growth ?? 25)),
      momentum: Math.max(0, Number(custom.momentum ?? 10)),
    };
  } else {
    raw = Object.assign({}, PRESET_WEIGHTS[preset] || PRESET_WEIGHTS.qglp_compounder);
  }
  const total = raw.quality + raw.value + raw.growth + raw.momentum;
  if (total <= 0) return { quality: 0.45, value: 0.2, growth: 0.25, momentum: 0.1 };
  return {
    quality: raw.quality / total,
    value: raw.value / total,
    growth: raw.growth / total,
    momentum: raw.momentum / total,
  };
}

function computeCagr(records, field, lookbackYears) {
  if (records.length < 2) return 8.0;
  const latest = records[records.length - 1];
  const targetIdx = Math.max(0, records.length - 1 - lookbackYears);
  const base = records[targetIdx];
  const yrs = Math.max(1, Number(latest.fiscal_year) - Number(base.fiscal_year));
  const endVal = Number(latest[field]);
  const startVal = Number(base[field]);
  if (endVal <= 0) return -20.0;
  if (startVal <= 0) return 18.0;
  return (Math.pow(endVal / startVal, 1.0 / yrs) - 1.0) * 100.0;
}

function computePiotroskiFScore(latest, prev, isFinancial) {
  let score = 0;
  const checks = [];
  const totAssets = Math.max(1.0, Number(latest.total_assets_cr));
  const patCur = Number(latest.net_profit_cr);
  const roaCur = patCur / totAssets;
  const cfoCur = Number(latest.cfo_cr);

  if (patCur > 0) {
    score += 1;
    checks.push("Positive Net Profit (PAT > 0)");
  }

  if (isFinancial) {
    if (Number(latest.roe_pct) >= 12.0) {
      score += 1;
      checks.push("Healthy Banking ROE (>= 12%)");
    }
    if (roaCur >= 0.01) {
      score += 1;
      checks.push("Strong Banking ROA (>= 1.0%)");
    }
  } else {
    if (cfoCur > 0) {
      score += 1;
      checks.push("Positive Operating Cash Flow (CFO > 0)");
    }
    if (cfoCur >= patCur * 0.9 && cfoCur > 0) {
      score += 1;
      checks.push("Clean Accrual Quality (CFO >= 0.9x PAT)");
    }
  }

  if (!prev) {
    score += 3;
    return [score, checks];
  }

  const prevAssets = Math.max(1.0, Number(prev.total_assets_cr));
  const roaPrev = Number(prev.net_profit_cr) / prevAssets;
  if (roaCur >= roaPrev - 0.002) {
    score += 1;
    checks.push("Stable/Improving Return on Assets");
  }

  const levCur = Number(latest.total_debt_cr) / totAssets;
  const levPrev = Number(prev.total_debt_cr) / prevAssets;
  if (levCur <= levPrev + 0.015) {
    score += 1;
    checks.push("Controlled Balance Sheet Leverage");
  }

  const crCur = Number(latest.current_assets_cr) / Math.max(1.0, Number(latest.current_liabilities_cr));
  const crPrev = Number(prev.current_assets_cr) / Math.max(1.0, Number(prev.current_liabilities_cr));
  if (crCur >= crPrev - 0.08) {
    score += 1;
    checks.push("Healthy Liquidity Trend");
  }

  if (Number(latest.shares_cr) <= Number(prev.shares_cr) * 1.02) {
    score += 1;
    checks.push("No Material Equity Dilution");
  }

  if (Number(latest.op_margin_pct) >= Number(prev.op_margin_pct) - 0.6) {
    score += 1;
    checks.push("Resilient Operating Margin");
  }

  const atCur = Number(latest.revenue_cr) / totAssets;
  const atPrev = Number(prev.revenue_cr) / prevAssets;
  if (atCur >= atPrev - 0.025) {
    score += 1;
    checks.push("Stable/Improving Asset Turnover");
  }

  return [score, checks];
}

const OIL_AND_COMMODITY_KEYWORDS = [
  "oil & gas e&p",
  "oil & gas integrated",
  "oil & gas refining",
  "oil & gas equipment",
  "petroleum",
  "coal",
  "exxon",
  "chevron",
  "conocophillips",
  "occidental",
  "valero",
  "phillips 66",
  "marathon",
  "halliburton",
  "schlumberger",
  "baker hughes",
  "devon",
  "diamondback",
  "eog ",
  "reliance",
  "oil india",
  "natural gas corpn",
];

const PIOTROSKI_PLAIN_MAP = {
  "Positive Net Profit (PAT > 0)": "Made a net profit this year",
  "Healthy Banking ROE (>= 12%)": "Earned healthy returns on shareholder money (12%+)",
  "Strong Banking ROA (>= 1.0%)": "Earned solid profit on total lending assets",
  "Positive Operating Cash Flow (CFO > 0)": "Generated positive cash from day-to-day operations",
  "Clean Accrual Quality (CFO >= 0.9x PAT)": "Reported profits are backed by real bank cash",
  "Stable/Improving Return on Assets": "Profitability on company assets held steady or improved",
  "Controlled Balance Sheet Leverage": "Kept debt levels controlled vs last year",
  "Healthy Liquidity Trend": "Maintained a healthy short-term cash cushion",
  "No Material Equity Dilution": "Did not dilute shareholders with extra shares",
  "Resilient Operating Margin": "Protected profit margins on sales vs last year",
  "Stable/Improving Asset Turnover": "Generated steady or higher sales from company assets",
};

function peRoundInt(val) {
  const r = Math.floor(Number(val) + 0.5);
  return r === 0 ? 0 : r;
}

function peRoundDec(val, decimals = 1) {
  const f = Math.pow(10, decimals);
  const res = Math.floor(Number(val) * f + 0.5) / f;
  return res === 0 ? 0 : res;
}

function peFmt(val, decimals = 1) {
  if (decimals <= 0) return String(peRoundInt(val));
  let v = peRoundDec(val, decimals);
  if (Math.abs(v - 99.9) < 1e-6) v = 100.0;
  return v.toFixed(decimals);
}

function peSfmt(val, decimals = 1) {
  if (decimals <= 0) {
    const iv = peRoundInt(val);
    return iv >= 0 ? `+${iv}` : String(iv);
  }
  let v = peRoundDec(val, decimals);
  if (Math.abs(v - 99.9) < 1e-6) v = 100.0;
  return `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}`;
}

function peVerdictTag(score100) {
  if (score100 >= 75.0) return "Standout";
  if (score100 >= 58.0) return "Solid";
  if (score100 >= 42.0) return "Mixed";
  return "Weak / Expensive";
}

function translatePenaltyReason(rawReason, isFin) {
  const low = String(rawReason || "").toLowerCase();
  if (low.includes("loss-making")) return "unprofitable in the latest year";
  if (low.includes("inconsistent profitability")) {
    const m = String(rawReason || "").match(/\((\d+\/\d+)\s+profitable/);
    const yrTxt = m ? m[1] : "fewer";
    return `inconsistent yearly profits (${yrTxt} profitable years)`;
  }
  if (low.includes("widespread sell-side eps cuts")) {
    return "covering bank analysts recently cut profit forecasts";
  }
  if (low.includes("negative net worth")) return "negative shareholder net worth";
  if (low.includes("high corporate debt")) {
    return isFin ? "heavy balance-sheet debt load" : "heavy corporate debt load";
  }
  if (low.includes("weak 5y cumulative cash conversion")) {
    return "weak conversion of paper profits into real cash";
  }
  if (low.includes("structural multi-year profit contraction")) {
    return "multi-year decline in annual profits";
  }
  if (low.includes("recent 2q earnings slowdown")) {
    return "recent quarterly profit and sales slowdown";
  }
  if (low.includes("promoter/institutional exit")) {
    return "recent selling by founders or institutional investors";
  }
  if (low.includes("elevated banking npas")) {
    return "elevated bad loans on the lending book";
  }
  if (low.includes("commodity cyclicality risk")) {
    return "wide profit swings across commodity cycles";
  }
  if (low.includes("weak piotroski")) {
    return "weak annual financial health checklist score";
  }
  if (low.includes("valuation rich")) {
    return "stretched stock price relative to fair value";
  }
  return "fundamental caution flag";
}

function translatePiotroskiChecks(checks) {
  const out = [];
  for (const chk of checks || []) {
    const mapped = PIOTROSKI_PLAIN_MAP[chk];
    if (mapped) out.push(mapped);
  }
  return out;
}

function buildPlainEnglish(ctx) {
  const compName = String(ctx.name || ctx.ticker || "This company").trim();
  const compSector = String(ctx.sector || "Diversified").trim();
  const industryStr = String(ctx.industry || "").trim();
  const rawSummary = String(ctx.business_summary || "").trim();
  const marketCode = String(ctx.market_code || "IN");
  const currency = String(ctx.currency || (marketCode === "US" ? "USD" : "INR"));
  const ccySym = currency === "USD" ? "$" : "₹";
  const hundredUnit = `${ccySym}100`;

  const isFin = Boolean(ctx.is_fin);
  const isCommodityBiz = Boolean(ctx.is_commodity_biz);
  const isCyclical = Boolean(ctx.is_cyclical);
  const buybackEquity = Boolean(ctx.buyback_distorted_equity);

  const patCr = safeFloat(ctx.pat_cr, 0.0);
  const patFyCr = safeFloat(ctx.pat_fy_cr, 0.0);
  const equityCr = safeFloat(ctx.equity_cr, 0.0);

  const peRatio = peRoundDec(safeFloat(ctx.pe_ratio, 99.9), 1);
  const fairPe = peRoundDec(safeFloat(ctx.fair_pe, 18.0), 1);
  const pegRatio = peRoundDec(safeFloat(ctx.peg_ratio, 9.9), 2);
  const pbRatio = peRoundDec(safeFloat(ctx.pb_ratio, 25.0), 2);
  const fcfYieldPct = peRoundDec(safeFloat(ctx.fcf_yield_pct, 0.0), 2);
  const earningsYieldPct = peRoundDec(safeFloat(ctx.earnings_yield_pct, 0.0), 2);

  const roceCur = peRoundDec(safeFloat(ctx.roce_cur, 0.0), 1);
  const med5yRoce = peRoundDec(safeFloat(ctx.med_5y_roce, 0.0), 1);
  const roeCur = peRoundDec(safeFloat(ctx.roe_cur, 0.0), 1);
  const med5yRoe = peRoundDec(safeFloat(ctx.med_5y_roe, 0.0), 1);
  const sustainedRoce = peRoundDec(safeFloat(ctx.sustained_roce ?? med5yRoce, 0.0), 1);
  const roaPct = peRoundDec(safeFloat(ctx.roa_pct, 0.0), 2);
  const cycleFloorRet = peRoundDec(safeFloat(ctx.cycle_floor_ret, 0.0), 1);
  const moatStability = peRoundInt(safeFloat(ctx.moat_stability, 50.0));
  const opmCur = peRoundDec(safeFloat(ctx.opm_cur, 0.0), 1);
  const deCur = peRoundDec(safeFloat(ctx.de_cur, 0.0), 2);
  const cumCfoEbitda5y = peRoundDec(safeFloat(ctx.cum_cfo_ebitda_5y, 0.0), 1);
  const cfoToDebtPct = peRoundDec(safeFloat(ctx.cfo_to_debt_pct, 0.0), 1);

  const profitableYrs = safeInt(ctx.profitable_yrs, 0);
  const w5Len = Math.max(1, safeInt(ctx.window_5y_len, 5));

  const revCagr3y = peRoundDec(safeFloat(ctx.rev_cagr_3y, 0.0), 1);
  const revCagr5y = peRoundDec(safeFloat(ctx.rev_cagr_5y, 0.0), 1);
  const patCagr3y = peRoundDec(safeFloat(ctx.pat_cagr_3y, 0.0), 1);
  const patCagr5y = peRoundDec(safeFloat(ctx.pat_cagr_5y, 0.0), 1);

  const hasQtrData = Boolean(ctx.has_qtr_data);
  const qtrRevYoy = peRoundDec(safeFloat(ctx.qtr_rev_yoy, 0.0), 1);
  const qtrPatYoy = peRoundDec(safeFloat(ctx.qtr_pat_yoy, 0.0), 1);
  const latestQtrLabel = String(ctx.latest_qtr_label || "").trim();

  const gnpaPct = peRoundDec(safeFloat(ctx.gnpa_pct, 0.0), 2);
  const nnpaPct = peRoundDec(safeFloat(ctx.nnpa_pct, 0.0), 2);

  const fScore = safeInt(ctx.f_score, 0);
  const fChecks = Array.isArray(ctx.f_checks) ? ctx.f_checks : [];
  const promoterPct = peRoundDec(safeFloat(ctx.promoter_pct, 0.0), 1);
  const instPct = peRoundDec(safeFloat(ctx.inst_pct, 0.0), 1);
  const mom121Pct = peRoundDec(safeFloat(ctx.mom_12_1_pct, 0.0), 1);
  const above200dma = Boolean(ctx.above_200dma);

  const compositeScore = peRoundDec(safeFloat(ctx.composite_score, 0.0), 1);
  const rating = String(ctx.rating || "Hold");
  const valuationZone = String(ctx.valuation_zone || "Fair GARP Price");
  const valuationCapped = Boolean(ctx.valuation_capped);

  const pillars = ctx.pillars || {};
  const qualityScore = peRoundDec(safeFloat(pillars.quality, 0.0), 1);
  const valueScore = peRoundDec(safeFloat(pillars.value, 0.0), 1);
  const growthScore = peRoundDec(safeFloat(pillars.growth, 0.0), 1);
  const momentumScore = peRoundDec(safeFloat(pillars.momentum, 0.0), 1);

  const sb = ctx.score_breakdown || {};
  const weightsPct = sb.weights_pct || {};
  const contributions = sb.contributions || {};
  const rawComposite = peRoundDec(safeFloat(sb.raw_composite ?? compositeScore, 0.0), 1);
  const totalPenalty = peRoundDec(safeFloat(sb.total_penalty, 0.0), 1);
  const penaltyItems = Array.isArray(sb.penalty_items) ? sb.penalty_items : [];

  const street = ctx.street || {};
  const stAnalystCnt = safeInt(street.analyst_count, 0);
  const stHasCov = Boolean(street.has_coverage) && stAnalystCnt > 0;
  const stBuyPct = peRoundDec(safeFloat(street.consensus_buy_pct, 0.0), 1);
  const stTargetMean = peRoundDec(safeFloat(street.target_mean, 0.0), 2);
  const stUpsidePct = peRoundDec(safeFloat(street.target_upside_pct, 0.0), 1);
  const stFwdFy1 = peRoundDec(safeFloat(street.fwd_eps_growth_fy1_pct, 0.0), 1);
  const stUp30 = safeInt(street.eps_rev_up_30d, 0);
  const stDn30 = safeInt(street.eps_rev_down_30d, 0);
  const stUp90 = safeInt(street.eps_rev_up_90d, 0);
  const stDn90 = safeInt(street.eps_rev_down_90d, 0);
  const stRevBreadth = peRoundDec(safeFloat(street.rev_breadth_pct, 0.0), 1);

  const indLow = industryStr.toLowerCase();
  const nmLow = compName.toLowerCase();
  const isRegulatedInfra =
    !isFin &&
    !isCommodityBiz &&
    (compSector === "Power & Energy" ||
      (compSector === "Energy, Oil & Power" &&
        (indLow.includes("utilities") ||
          indLow.includes("midstream") ||
          (!indLow && !OIL_AND_COMMODITY_KEYWORDS.some((kw) => nmLow.includes(kw))))));

  const isUnprofitableNow = patCr <= 0.0 || patFyCr <= 0.0;
  const isLossOrNoPe = isUnprofitableNow || peRatio >= 99.0;

  let archetypeCode;
  let archetypeLabel;
  if (isLossOrNoPe) {
    archetypeCode = "loss_turnaround";
    archetypeLabel = "Unprofitable / Turnaround";
  } else if (buybackEquity) {
    archetypeCode = "buyback_compounder";
    archetypeLabel = "Share-Buyback Cash Cow";
  } else if (isFin) {
    archetypeCode = "financial_lender";
    archetypeLabel = "Banking & Financial Leader";
  } else if (isRegulatedInfra) {
    archetypeCode = "regulated_infra";
    archetypeLabel = "Regulated Infrastructure";
  } else if (isCyclical) {
    archetypeCode = "cyclical_commodity";
    archetypeLabel = "Cyclical / Commodity Business";
  } else {
    archetypeCode = "secular_compounder";
    archetypeLabel =
      sustainedRoce >= 18.0 && deCur <= 0.5 ? "Cash-Rich Compounder" : "Steady Operating Business";
  }

  const mktAdj = marketCode === "US" ? "US" : "Indian";
  let whatItDoes;
  if (rawSummary) {
    whatItDoes = rawSummary;
  } else if (industryStr) {
    whatItDoes = `${compName} is an established ${mktAdj} ${industryStr.toLowerCase()} business operating in the ${compSector} sector.`;
  } else {
    whatItDoes = `${compName} is an established ${mktAdj} enterprise operating across the ${compSector} sector.`;
  }

  let oneLineVerdict;
  if (archetypeCode === "loss_turnaround") {
    oneLineVerdict = isUnprofitableNow
      ? "Currently unprofitable — wait for steady profits before investing"
      : "Priced far ahead of current profits — high expectations baked in";
  } else if (archetypeCode === "buyback_compounder") {
    if (peRatio <= fairPe * 1.15 && compositeScore >= 65.0) {
      oneLineVerdict = "Cash-rich share-buyback leader at a reasonable entry price";
    } else if (peRatio > fairPe * 1.35 || valuationZone === "Overvalued / Wait for Dip") {
      oneLineVerdict = "World-class cash generator, but stock price looks expensive today";
    } else {
      oneLineVerdict = "Strong cash-generating buyback compounder — accumulate on dips";
    }
  } else if (archetypeCode === "financial_lender") {
    if (compositeScore >= 68.0 && peRatio <= fairPe * 1.15) {
      oneLineVerdict = "Consistent financial compounder at a reasonable valuation";
    } else if (qualityScore >= 70.0 && peRatio > fairPe * 1.3) {
      oneLineVerdict = "Well-run financial franchise, though shares trade at a premium";
    } else if (compositeScore >= 57.0) {
      oneLineVerdict = "Steady financial institution at a sensible long-term price";
    } else {
      oneLineVerdict = "Mixed financial track record — stronger lenders available";
    }
  } else if (archetypeCode === "regulated_infra") {
    if (compositeScore >= 60.0 && peRatio <= fairPe * 1.15) {
      oneLineVerdict = "Steady utility & infrastructure operator at a sensible price";
    } else if (peRatio > fairPe * 1.3) {
      oneLineVerdict = "Predictable utility business, but stock price leaves little upside";
    } else {
      oneLineVerdict = "Contracted infrastructure operator carrying long-term project debt";
    }
  } else if (archetypeCode === "cyclical_commodity") {
    if (compositeScore >= 65.0 && peRatio <= fairPe * 1.05) {
      oneLineVerdict = "Strong cyclical business at a fair price — mind industry swings";
    } else if (peRatio > fairPe * 1.3) {
      oneLineVerdict = "Cyclical business trading at an expensive point in the cycle";
    } else {
      oneLineVerdict = "Profits move with industry cycles — demand a wide safety margin";
    }
  } else if (qualityScore >= 75.0 && deCur <= 0.25 && peRatio <= fairPe * 1.05 && compositeScore >= 68.0) {
    oneLineVerdict = "Strong, debt-free business at an attractive price";
  } else if (qualityScore >= 72.0 && peRatio <= fairPe * 1.15 && compositeScore >= 65.0) {
    oneLineVerdict = "High-quality compounder trading at a sensible price";
  } else if (qualityScore >= 70.0 && (peRatio > fairPe * 1.3 || valueScore < 40.0)) {
    oneLineVerdict = "World-class business, but stock price is expensive today";
  } else if (compositeScore >= 57.0) {
    oneLineVerdict = "Solid operating business with steady long-term fundamentals";
  } else if (compositeScore >= 45.0) {
    oneLineVerdict = "Decent business with mixed growth or price trade-offs";
  } else {
    oneLineVerdict = "Weak business fundamentals or stretched balance sheet — be cautious";
  }

  const roceI = peRoundInt(med5yRoce);
  const roeI = peRoundInt(med5yRoe);
  const floorI = peRoundInt(cycleFloorRet);

  let s1;
  if (archetypeCode === "loss_turnaround") {
    if (isUnprofitableNow) {
      s1 = `${compName} is currently unprofitable — cannot be valued on current profits yet, having earned a net profit in ${profitableYrs} of the last ${w5Len} years.`;
    } else if (isFin) {
      const eVerb =
        roeI >= 0
          ? `earns ${ccySym}${roeI} per ${hundredUnit}`
          : `loses ${ccySym}${Math.abs(roeI)} per ${hundredUnit}`;
      s1 = `${compName} ${eVerb} of shareholder equity over a 5-year median, but current net profits are still tiny relative to its market value — cannot be valued on current profits yet.`;
    } else {
      const eVerb =
        roceI >= 0
          ? `earns ${ccySym}${roceI} per ${hundredUnit}`
          : `loses ${ccySym}${Math.abs(roceI)} per ${hundredUnit}`;
      s1 = `${compName} ${eVerb} invested in the business over a 5-year median, but current net profits are still tiny relative to its market value — cannot be valued on current profits yet.`;
    }
  } else if (archetypeCode === "financial_lender") {
    if (gnpaPct > 0.0) {
      const loanPhrase =
        nnpaPct <= 0.8
          ? "very clean loan quality"
          : nnpaPct <= 1.5
          ? "manageable bad-loan levels"
          : "elevated bad loans requiring caution";
      s1 = `${compName} earns ${ccySym}${roeI} per ${hundredUnit} of shareholder equity over a 5-year median with ${loanPhrase} (${peFmt(nnpaPct, 2)}% net bad loans) and stayed profitable in ${profitableYrs} of ${w5Len} years.`;
    } else {
      s1 = `${compName} earns ${ccySym}${roeI} per ${hundredUnit} of shareholder equity over a 5-year median (generating ${ccySym}${peFmt(roaPct, 2)} profit per ${hundredUnit} of total assets) across ${profitableYrs} of ${w5Len} profitable years.`;
    }
  } else if (archetypeCode === "buyback_compounder") {
    const retBuyback = isFin ? roeI : roceI;
    s1 = `${compName} earns ${ccySym}${retBuyback} per ${hundredUnit} invested — book equity looks small/negative only because of years of share buybacks, while strong annual cash flow comfortably covers ${peFmt(cfoToDebtPct, 0)}% of total debt.`;
  } else if (archetypeCode === "regulated_infra") {
    s1 = `${compName} earns a steady ${ccySym}${roceI} per ${hundredUnit} invested across regulated or contracted infrastructure assets, where long-term project borrowing (${peFmt(deCur, 2)}x equity) is supported by predictable utility cash flows.`;
  } else if (archetypeCode === "cyclical_commodity") {
    const floorPhrase =
      floorI >= 0
        ? `dipping to ${ccySym}${floorI} per ${hundredUnit}`
        : `swinging to a ${ccySym}${Math.abs(floorI)} loss per ${hundredUnit}`;
    s1 = `${compName} earns ${ccySym}${roceI} per ${hundredUnit} invested over a 5-year median, but profits move with commodity and industry cycles (${floorPhrase} in tougher years), so even a low valuation during peak profits needs cycle caution.`;
  } else {
    let debtPhrase;
    if (deCur <= 0.15) debtPhrase = "with virtually zero debt";
    else if (deCur <= 0.5) debtPhrase = "with very low debt";
    else if (deCur <= 1.2) debtPhrase = "with manageable debt";
    else debtPhrase = "though carrying noticeable debt";
    const cashI = peRoundInt(cumCfoEbitda5y);
    const cashPhrase =
      cashI >= 70
        ? `turning ${cashI}% of operating profits into real bank cash`
        : `converting ${cashI}% of operating profits into cash`;
    const eVerb =
      roceI >= 0
        ? `earns ${ccySym}${roceI} per ${hundredUnit} invested`
        : `loses ${ccySym}${Math.abs(roceI)} per ${hundredUnit} invested`;
    s1 = `${compName} ${eVerb} over a 5-year median ${debtPhrase}, ${cashPhrase} across ${profitableYrs} of ${w5Len} profitable years.`;
  }

  const qInt = peRoundInt(qualityScore);
  const vInt = peRoundInt(valueScore);
  const gInt = peRoundInt(growthScore);
  const penInt = peRoundInt(totalPenalty);

  let s2;
  if (archetypeCode === "loss_turnaround") {
    if (isUnprofitableNow) {
      s2 = `Its overall score landed at ${peFmt(compositeScore, 1)}/100 (${rating}) because current losses trigger a ${penInt}-point safety deduction and leave no profit cushion to value the shares on.`;
    } else {
      const dedStr = penInt > 0 ? ` plus a ${penInt}-point caution deduction` : "";
      s2 = `Its overall score landed at ${peFmt(compositeScore, 1)}/100 (${rating}) because the stock price already bakes in years of high optimism relative to today's small profit base (price-value score ${vInt}/100${dedStr}).`;
    }
  } else if (qualityScore >= 70.0 && (peRatio > fairPe * 1.35 || valueScore < 35.0)) {
    const capNote =
      valuationCapped && penInt > 0
        ? ` and triggered an ${penInt}-point rich-price guardrail deduction`
        : penInt > 0
        ? ` alongside a ${penInt}-point caution deduction`
        : "";
    s2 = `Its score landed at ${peFmt(compositeScore, 1)}/100 (${rating}) mainly because an expensive stock valuation (${peFmt(peRatio, 1)}x annual profits vs a fair range near ~${peFmt(fairPe, 1)}x) pulled its price-value score down to ${vInt}/100${capNote}, holding back an otherwise standout ${qInt}/100 business.`;
  } else if (peRatio <= fairPe * 0.92 && compositeScore >= 65.0) {
    s2 = `It earned a high ${peFmt(compositeScore, 1)}/100 (${rating}) because strong business quality (${qInt}/100) pairs with an attractive bargain price at ${peFmt(peRatio, 1)}x annual profits versus a fair value range near ~${peFmt(fairPe, 1)}x.`;
  } else if (penInt > 0 && penaltyItems.length > 0) {
    const topReason = translatePenaltyReason(penaltyItems[0].reason || "", isFin);
    s2 = `Starting from a raw score of ${peFmt(rawComposite, 1)}/100, a ${penInt}-point safety deduction (${topReason}) brought the final score to ${peFmt(compositeScore, 1)}/100 (${rating}).`;
  } else if (compositeScore >= 68.0) {
    s2 = `It earned a strong ${peFmt(compositeScore, 1)}/100 (${rating}) by combining high business quality (${qInt}/100) and steady growth (${gInt}/100) at a sensible ${peFmt(peRatio, 1)}x profits (fair range ~${peFmt(fairPe, 1)}x) with zero caution flags.`;
  } else {
    let dragPhrase;
    if (valueScore < qualityScore && valueScore < growthScore) {
      dragPhrase = `a somewhat rich stock price at ${peFmt(peRatio, 1)}x profits (vs ~${peFmt(fairPe, 1)}x fair range)`;
    } else if (growthScore < qualityScore) {
      dragPhrase = `slower multi-year growth (${gInt}/100)`;
    } else {
      dragPhrase = `moderate business returns (${qInt}/100)`;
    }
    const leadPhrase =
      qualityScore >= growthScore
        ? `solid business quality (${qInt}/100)`
        : `healthy sales & profit growth (${gInt}/100)`;
    s2 = `Its ${peFmt(compositeScore, 1)}/100 (${rating}) score reflects ${leadPhrase} balanced against ${dragPhrase}.`;
  }

  const rev5yPhrase =
    revCagr5y >= 0.0
      ? `grew ${peFmt(revCagr5y, 1)}% a year`
      : `shrank ${peFmt(Math.abs(revCagr5y), 1)}% a year`;
  const pat5yPhrase =
    patCagr5y >= 0.0
      ? `profits compounded at ${peFmt(patCagr5y, 1)}% a year`
      : `profits declined ${peFmt(Math.abs(patCagr5y), 1)}% a year`;
  let analystTail;
  if (stHasCov && stAnalystCnt >= 3) {
    const buyI = peRoundInt(stBuyPct);
    if (stTargetMean > 0.0) {
      const upPhrase =
        stUpsidePct >= 0.0
          ? `${peFmt(stUpsidePct, 1)}% implied upside`
          : `${peFmt(Math.abs(stUpsidePct), 1)}% below current price`;
      analystTail = `while ${stAnalystCnt} covering bank analysts hold a ${buyI}% Buy view with an average target of ${ccySym}${peFmt(stTargetMean, 0)} (${upPhrase}).`;
    } else {
      analystTail = `while ${stAnalystCnt} covering bank analysts hold a ${buyI}% Buy consensus.`;
    }
  } else if (marketCode === "US") {
    analystTail = `backed by ${peFmt(instPct, 1)}% long-term institutional ownership.`;
  } else {
    analystTail = `backed by ${peFmt(promoterPct, 1)}% founder/promoter and ${peFmt(instPct, 1)}% institutional ownership.`;
  }
  const s3 = `Over the past 5 years, annual sales ${rev5yPhrase} and ${pat5yPhrase}, ${analystTail}`;

  let qPlainWhy;
  let qualityRows;
  if (isFin && !buybackEquity) {
    qPlainWhy =
      roeI >= 0
        ? `Earns ${ccySym}${roeI} per ${hundredUnit} of shareholder money over a 5-year median with ${profitableYrs}/${w5Len} profitable years.`
        : `Shareholder returns have been negative recently (${profitableYrs}/${w5Len} profitable years).`;
    const roeSimple =
      roeI >= 0
        ? `Earns ${ccySym}${roeI} per ${hundredUnit} equity`
        : `Loses ${ccySym}${Math.abs(roeI)} per ${hundredUnit} equity`;
    const roeTone =
      med5yRoe >= 14.0 ? "good" : med5yRoe >= 10.0 ? "neutral" : med5yRoe > 0.0 ? "warn" : "bad";
    const roaSimple =
      roaPct >= 0.0
        ? `${ccySym}${peFmt(roaPct, 2)} profit per ${hundredUnit} of assets`
        : `Loss of ${ccySym}${peFmt(Math.abs(roaPct), 2)} per ${hundredUnit} of assets`;
    const roaTone =
      roaPct >= 1.2 ? "good" : roaPct >= 0.7 ? "neutral" : roaPct > 0.0 ? "warn" : "bad";

    const row3Fin =
      gnpaPct > 0.0
        ? {
            simple_label: "Unrecovered bad loans",
            pro_label: "Net NPA % (Gross NPA %)",
            simple_value: `${peFmt(nnpaPct, 2)}% net bad loans`,
            pro_value: `${peFmt(nnpaPct, 2)}% NNPA (${peFmt(gnpaPct, 2)}% GNPA)`,
            target_hint: "Below 1.0% shows clean lending quality",
            tone: nnpaPct <= 1.0 ? "good" : nnpaPct <= 1.5 ? "neutral" : "bad",
          }
        : {
            simple_label: "Toughest-year equity return",
            pro_label: "6Y Cycle-Floor ROE",
            simple_value: `${peFmt(cycleFloorRet, 1)}% in toughest recent year`,
            pro_value: `${peFmt(cycleFloorRet, 1)}% Cycle Floor (Stability ${peFmt(moatStability, 0)}/100)`,
            target_hint: "Staying above 10% in downturns is resilient",
            tone: cycleFloorRet >= 11.0 ? "good" : cycleFloorRet >= 7.0 ? "neutral" : "warn",
          };

    qualityRows = [
      {
        simple_label: "Return on shareholder money",
        pro_label: "5Y Median ROE (Latest ROE)",
        simple_value: roeSimple,
        pro_value: `${peFmt(med5yRoe, 1)}% 5Y Med (${peFmt(roeCur, 1)}% Latest)`,
        target_hint: "14%+ is strong for banks & financial leaders",
        tone: roeTone,
      },
      {
        simple_label: "Profit earned on total assets",
        pro_label: "Return on Total Assets (ROA)",
        simple_value: roaSimple,
        pro_value: `${peFmt(roaPct, 2)}% ROA`,
        target_hint: "1.2%+ signals high lending & asset quality",
        tone: roaTone,
      },
      row3Fin,
      {
        simple_label: "Consistent yearly profits",
        pro_label: "5-Year Profit Consistency",
        simple_value: `Profitable in ${profitableYrs} of last ${w5Len} years`,
        pro_value: `${profitableYrs}/${w5Len} FYs Profitable (Margin ${peFmt(opmCur, 1)}%)`,
        target_hint: "5 out of 5 profitable years is ideal",
        tone: profitableYrs === w5Len ? "good" : profitableYrs >= w5Len - 1 ? "neutral" : "bad",
      },
    ];
  } else if (buybackEquity) {
    const retMedB = isFin ? med5yRoe : med5yRoce;
    const retLatB = isFin ? roeCur : roceCur;
    const retBI = peRoundInt(retMedB);
    const cashBI = peRoundInt(cumCfoEbitda5y);
    qPlainWhy = `Earns ${ccySym}${retBI} per ${hundredUnit} invested; book equity looks small because of share buybacks while cash flow covers ${peFmt(cfoToDebtPct, 0)}% of total debt.`;
    qualityRows = [
      {
        simple_label: `Profit per ${hundredUnit} invested`,
        pro_label: isFin ? "5Y Median Return on Capital" : "5Y Median ROCE (Latest)",
        simple_value: `Earns ${ccySym}${retBI} per ${hundredUnit} invested`,
        pro_value: `${peFmt(retMedB, 1)}% 5Y Med (${peFmt(retLatB, 1)}% Latest)`,
        target_hint: "18%+ signals a powerful business moat",
        tone: "good",
      },
      {
        simple_label: "Debt safety (cash flow vs debt)",
        pro_label: "Annual Operating Cash Flow / Debt",
        simple_value: `Annual cash covers ${peFmt(cfoToDebtPct, 0)}% of total debt`,
        pro_value: `${peFmt(cfoToDebtPct, 1)}% CFO/Debt (Buyback-adjusted)`,
        target_hint: "35%+ yearly cash coverage comfortably services debt",
        tone: cfoToDebtPct >= 50.0 ? "good" : "neutral",
      },
      {
        simple_label: "Real cash collected from profits",
        pro_label: isFin ? "Operating Cash Conversion" : "5Y Cumulative CFO / EBITDA",
        simple_value: `Turns ${cashBI}% of operating profit into cash`,
        pro_value: isFin ? `${cashBI}% Cash Conversion` : `${cashBI}% 5Y CFO/EBITDA`,
        target_hint: "80%+ means profits arrive as real cash",
        tone: cumCfoEbitda5y >= 80.0 ? "good" : cumCfoEbitda5y >= 60.0 ? "neutral" : "warn",
      },
      {
        simple_label: "Operating profit kept per sale",
        pro_label: "Operating Margin & 5Y Consistency",
        simple_value: `Keeps ${ccySym}${peRoundInt(opmCur)} per ${hundredUnit} of sales (${profitableYrs}/${w5Len} yrs profitable)`,
        pro_value: `${peFmt(opmCur, 1)}% OPM (${profitableYrs}/${w5Len} FYs Profitable)`,
        target_hint: "15%+ margin with 5/5 profitable years is strong",
        tone: opmCur >= 15.0 && profitableYrs === w5Len ? "good" : "neutral",
      },
    ];
  } else {
    const cashI = peRoundInt(cumCfoEbitda5y);
    if (archetypeCode === "regulated_infra") {
      qPlainWhy = `Earns ${ccySym}${roceI} per ${hundredUnit} invested across regulated infrastructure assets with ${profitableYrs}/${w5Len} profitable years.`;
    } else if (archetypeCode === "cyclical_commodity") {
      qPlainWhy = `Earns ${ccySym}${roceI} per ${hundredUnit} on average, though returns swing to ${ccySym}${floorI} in industry downturns.`;
    } else if (med5yRoce <= 0.0) {
      qPlainWhy = `Operations have struggled to earn positive returns on invested money (${profitableYrs}/${w5Len} profitable years).`;
    } else {
      qPlainWhy = `Earns ${ccySym}${roceI} per ${hundredUnit} invested in the business and converts ${cashI}% of operating profit into real cash.`;
    }

    const roceSimple =
      roceI >= 0
        ? `Earns ${ccySym}${roceI} per ${hundredUnit} invested`
        : `Loses ${ccySym}${Math.abs(roceI)} per ${hundredUnit} invested`;
    const roceTone =
      archetypeCode === "regulated_infra"
        ? med5yRoce >= 9.5
          ? "good"
          : med5yRoce >= 6.5
          ? "neutral"
          : "warn"
        : med5yRoce >= 18.0
        ? "good"
        : med5yRoce >= 11.0
        ? "neutral"
        : med5yRoce > 0.0
        ? "warn"
        : "bad";
    const roceHint =
      archetypeCode === "regulated_infra"
        ? "8–14% is normal for regulated utilities"
        : "18%+ signals a strong competitive moat";

    let debtSimple;
    let debtPro;
    let debtTone;
    if (equityCr <= 0.0) {
      debtSimple = "Negative book net worth";
      debtPro = "Equity <= 0";
      debtTone = "bad";
    } else if (deCur <= 0.1) {
      debtSimple = "Virtually debt-free";
      debtPro = `${peFmt(deCur, 2)}x D/E`;
      debtTone = "good";
    } else if (deCur <= 0.5) {
      debtSimple = `Low debt (${peFmt(deCur, 2)}x shareholder equity)`;
      debtPro = `${peFmt(deCur, 2)}x D/E`;
      debtTone = "good";
    } else if (archetypeCode === "regulated_infra" && deCur <= 2.2) {
      debtSimple = `Long-term project debt (${peFmt(deCur, 2)}x equity)`;
      debtPro = `${peFmt(deCur, 2)}x D/E (Infra)`;
      debtTone = "neutral";
    } else if (deCur <= 1.2) {
      debtSimple = `Moderate debt (${peFmt(deCur, 2)}x equity)`;
      debtPro = `${peFmt(deCur, 2)}x D/E`;
      debtTone = "neutral";
    } else if (deCur <= 1.8) {
      debtSimple = `Elevated debt (${peFmt(deCur, 2)}x equity)`;
      debtPro = `${peFmt(deCur, 2)}x D/E`;
      debtTone = "warn";
    } else {
      debtSimple = `Heavy debt load (${peFmt(deCur, 2)}x equity)`;
      debtPro = `${peFmt(deCur, 2)}x D/E`;
      debtTone = "bad";
    }

    qualityRows = [
      {
        simple_label: `Profit per ${hundredUnit} invested`,
        pro_label: "5Y Median ROCE (Latest ROCE)",
        simple_value: roceSimple,
        pro_value: `${peFmt(med5yRoce, 1)}% 5Y Med (${peFmt(roceCur, 1)}% Latest)`,
        target_hint: roceHint,
        tone: roceTone,
      },
      {
        simple_label: "Debt vs company net worth",
        pro_label: "Corporate Debt-to-Equity (D/E)",
        simple_value: debtSimple,
        pro_value: debtPro,
        target_hint:
          archetypeCode === "regulated_infra"
            ? "Utilities commonly carry 1.0x–2.2x project debt"
            : "Under 0.5x means a conservative balance sheet",
        tone: debtTone,
      },
      {
        simple_label: "Real cash collected from profits",
        pro_label: "5Y Cumulative CFO / EBITDA",
        simple_value:
          cashI >= 0
            ? `Turns ${cashI}% of operating profit into cash`
            : "Operating cash flow is negative",
        pro_value: `${cashI}% 5Y CFO/EBITDA`,
        target_hint: "75%+ means reported profits arrive as real cash",
        tone: cumCfoEbitda5y >= 75.0 ? "good" : cumCfoEbitda5y >= 55.0 ? "neutral" : "bad",
      },
      {
        simple_label: "Steady profits across tough years",
        pro_label: "5Y Profit Consistency & Moat Stability",
        simple_value: `Profitable in ${profitableYrs}/${w5Len} years (toughest year ${floorI}%)`,
        pro_value: `${profitableYrs}/${w5Len} FYs Profitable • Stability ${peFmt(moatStability, 0)}/100`,
        target_hint: "5/5 profitable years without deep slumps",
        tone:
          profitableYrs === w5Len && moatStability >= 65.0
            ? "good"
            : profitableYrs >= w5Len - 1
            ? "neutral"
            : "bad",
      },
    ];
  }

  const sDir =
    revCagr5y >= 0.0
      ? `grew ${peFmt(revCagr5y, 1)}%/yr`
      : `declined ${peFmt(Math.abs(revCagr5y), 1)}%/yr`;
  const pDir =
    patCagr5y >= 0.0
      ? `grew ${peFmt(patCagr5y, 1)}%/yr`
      : `declined ${peFmt(Math.abs(patCagr5y), 1)}%/yr`;
  const gPlainWhy = `Over 5 years, annual sales ${sDir} while net profits ${pDir}.`;
  const qLblSfx = hasQtrData && latestQtrLabel ? ` (${latestQtrLabel})` : "";
  const hasFwd = stHasCov && stAnalystCnt >= 3 && stFwdFy1 !== 0.0;
  const growthRows = [
    {
      simple_label: "5-year annual sales growth",
      pro_label: "5Y & 3Y Revenue CAGR",
      simple_value: `${peSfmt(revCagr5y, 1)}% per year`,
      pro_value: `${peSfmt(revCagr5y, 1)}% (5Y) • ${peSfmt(revCagr3y, 1)}% (3Y)`,
      target_hint: "10%+ annual sales growth is healthy",
      tone: revCagr5y >= 10.0 ? "good" : revCagr5y >= 4.0 ? "neutral" : revCagr5y >= 0.0 ? "warn" : "bad",
    },
    {
      simple_label: "5-year annual profit growth",
      pro_label: "5Y & 3Y Net Profit CAGR",
      simple_value: `${peSfmt(patCagr5y, 1)}% per year`,
      pro_value: `${peSfmt(patCagr5y, 1)}% (5Y) • ${peSfmt(patCagr3y, 1)}% (3Y)`,
      target_hint: "12%+ steady profit compounding builds wealth",
      tone: patCagr5y >= 12.0 ? "good" : patCagr5y >= 5.0 ? "neutral" : patCagr5y >= 0.0 ? "warn" : "bad",
    },
    {
      simple_label: `Recent quarterly profit trend${qLblSfx}`,
      pro_label: "Latest YoY Quarterly Profit & Sales",
      simple_value: hasQtrData
        ? `${peSfmt(qtrPatYoy, 1)}% profit, ${peSfmt(qtrRevYoy, 1)}% sales vs last year`
        : `Tracking ~${peSfmt(patCagr3y, 1)}% recent annual pace`,
      pro_value: hasQtrData
        ? `${peSfmt(qtrPatYoy, 1)}% YoY Profit • ${peSfmt(qtrRevYoy, 1)}% YoY Sales`
        : "Annualized trajectory",
      target_hint: "Positive recent growth confirms business momentum",
      tone: qtrPatYoy >= 10.0 ? "good" : qtrPatYoy >= 0.0 ? "neutral" : qtrPatYoy > -12.0 ? "warn" : "bad",
    },
    {
      simple_label: "Expected profit growth next year",
      pro_label: "Consensus FY1 Forward EPS Growth",
      simple_value: hasFwd
        ? `Analysts expect ${peSfmt(stFwdFy1, 1)}% profit growth`
        : "Scored on verified multi-year history",
      pro_value: hasFwd ? `${peSfmt(stFwdFy1, 1)}% FY1 Consensus EPS` : "Historical CAGR anchor",
      target_hint: "10%+ expected growth supports future returns",
      tone: hasFwd ? (stFwdFy1 >= 10.0 ? "good" : stFwdFy1 >= 0.0 ? "neutral" : "warn") : "neutral",
    },
  ];

  let vPlainWhy;
  let valueRows;
  if (archetypeCode === "loss_turnaround") {
    const unprofMsg = isUnprofitableNow
      ? "Currently unprofitable — cannot be valued on current profits yet"
      : "Current profits are too small — cannot be valued on current profits yet";
    vPlainWhy = `${unprofMsg}; wait for earnings to normalize before judging price value.`;
    const vRow3 = isFin
      ? {
          simple_label: "Price vs shareholder book value",
          pro_label: "Price-to-Book Ratio (P/B)",
          simple_value:
            equityCr > 0.0 && pbRatio < 24.9
              ? `${peFmt(pbRatio, 2)}x shareholder book value`
              : "Book value compressed",
          pro_value:
            equityCr > 0.0 && pbRatio < 24.9 ? `${peFmt(pbRatio, 2)}x P/B` : "N/M (Compressed equity)",
          target_hint: "1.0x–2.5x book value is typical for lenders",
          tone: pbRatio <= 2.5 ? "neutral" : "warn",
        }
      : {
          simple_label: "Free cash generated vs stock price",
          pro_label: "Free Cash Flow (FCF) Yield",
          simple_value:
            fcfYieldPct > 0.0
              ? `${peFmt(fcfYieldPct, 1)}% yearly free cash yield`
              : "Burning free cash flow currently",
          pro_value: `${peFmt(fcfYieldPct, 2)}% FCF Yield`,
          target_hint: "3%+ free cash yield offers valuation support",
          tone: fcfYieldPct >= 3.0 ? "good" : fcfYieldPct > 0.0 ? "neutral" : "bad",
        };
    valueRows = [
      {
        simple_label: "Stock price vs annual profit",
        pro_label: "Trailing Earnings Valuation",
        simple_value: unprofMsg,
        pro_value: "N/M (Unprofitable / Turnaround)",
        target_hint: "Needs steady positive profits for a fair multiple",
        tone: "bad",
      },
      {
        simple_label: "Price paid for expected growth",
        pro_label: "Growth-Adjusted Valuation",
        simple_value: "Not meaningful until profits stabilize",
        pro_value: "N/M (Turnaround earnings base)",
        target_hint: "Evaluated once annual profits normalize",
        tone: "bad",
      },
      vRow3,
      {
        simple_label: "Buying price comfort",
        pro_label: "GARP Valuation Zone",
        simple_value: "High risk — wait for profit recovery",
        pro_value: valuationZone,
        target_hint: "Look for profitable margin of safety",
        tone: "bad",
      },
    ];
  } else {
    if (peRatio <= fairPe * 0.9) {
      vPlainWhy = `Trades at a bargain ${peFmt(peRatio, 1)}x annual profits versus a fair range near ~${peFmt(fairPe, 1)}x.`;
    } else if (peRatio <= fairPe * 1.2) {
      vPlainWhy = `Trades at ${peFmt(peRatio, 1)}x annual profits, reasonably aligned with its ~${peFmt(fairPe, 1)}x fair value range.`;
    } else if (peRatio <= fairPe * 1.55) {
      vPlainWhy = `Trades at ${peFmt(peRatio, 1)}x annual profits — above its ~${peFmt(fairPe, 1)}x fair range, favoring staggered buying.`;
    } else {
      vPlainWhy = `Trades at an expensive ${peFmt(peRatio, 1)}x annual profits versus a fair range near ~${peFmt(fairPe, 1)}x.`;
    }
    if (archetypeCode === "cyclical_commodity") {
      vPlainWhy = `${vPlainWhy} Cyclical multiples can look low near peak profits, so keep extra caution.`;
    }

    let pegSimple;
    if (pegRatio <= 1.25) pegSimple = "Attractive price for its growth speed";
    else if (pegRatio <= 1.85) pegSimple = "Reasonable price for its growth";
    else if (pegRatio <= 2.4) pegSimple = "Priced slightly ahead of growth";
    else pegSimple = "Expensive relative to its growth speed";

    const vRow3 =
      isFin && !buybackEquity
        ? {
            simple_label: "Price vs shareholder book value",
            pro_label: "Price-to-Book Ratio (P/B)",
            simple_value: `${peFmt(pbRatio, 2)}x shareholder book value`,
            pro_value: `${peFmt(pbRatio, 2)}x P/B`,
            target_hint: "1.0x–3.0x is reasonable for strong banks",
            tone: pbRatio <= 2.5 ? "good" : pbRatio <= 4.0 ? "neutral" : "warn",
          }
        : {
            simple_label: `Free cash earned per ${hundredUnit} of stock`,
            pro_label: "Free Cash Flow Yield & Earnings Yield",
            simple_value:
              fcfYieldPct >= 0.0
                ? `${ccySym}${peFmt(fcfYieldPct, 1)} free cash per ${hundredUnit} at today's price`
                : "Heavy reinvestment reducing free cash this year",
            pro_value: `${peFmt(fcfYieldPct, 2)}% FCF Yield (${peFmt(earningsYieldPct, 2)}% EY)`,
            target_hint: "3%+ cash yield rewards patient holders",
            tone: fcfYieldPct >= 3.0 ? "good" : fcfYieldPct >= 1.2 ? "neutral" : "warn",
          };

    let vzSimple;
    let vzTone;
    if (valuationZone === "Undervalued (Margin of Safety)") {
      vzSimple = "Good bargain with margin of safety";
      vzTone = "good";
    } else if (valuationZone === "Fair GARP Price") {
      vzSimple = "Fair price for long-term buyers";
      vzTone = "good";
    } else if (valuationZone === "Slightly Rich (Stagger SIP)") {
      vzSimple = "Slightly rich — stagger purchases slowly";
      vzTone = "warn";
    } else {
      vzSimple = "Expensive today — better to wait for a dip";
      vzTone = "bad";
    }

    valueRows = [
      {
        simple_label: "Stock price vs annual profit",
        pro_label: "Trailing P/E vs Quality-Adjusted Fair P/E",
        simple_value: `Pays ${peFmt(peRatio, 1)}x profits (fair range ~${peFmt(fairPe, 1)}x)`,
        pro_value: `${peFmt(peRatio, 1)}x P/E vs ~${peFmt(fairPe, 1)}x Fair P/E`,
        target_hint: "At or below fair range gives a safety cushion",
        tone:
          peRatio <= fairPe * 1.05
            ? "good"
            : peRatio <= fairPe * 1.25
            ? "neutral"
            : peRatio <= fairPe * 1.55
            ? "warn"
            : "bad",
      },
      {
        simple_label: "Price paid for expected growth",
        pro_label: "GARP PEG Ratio",
        simple_value: pegSimple,
        pro_value: `${peFmt(pegRatio, 2)}x PEG`,
        target_hint: "Under 1.5x means growth isn't overpriced",
        tone: pegRatio <= 1.35 ? "good" : pegRatio <= 1.9 ? "neutral" : pegRatio <= 2.4 ? "warn" : "bad",
      },
      vRow3,
      {
        simple_label: "Buying price comfort",
        pro_label: "GARP Valuation Zone",
        simple_value: vzSimple,
        pro_value: valuationZone,
        target_hint: "Avoid overpaying even for great companies",
        tone: vzTone,
      },
    ];
  }

  const ownSum = peRoundDec(promoterPct + instPct, 1);
  const buyI = peRoundInt(stBuyPct);
  const mPlainWhy =
    stHasCov && stAnalystCnt >= 3
      ? `Passes ${fScore} of 9 annual safety checks, with ${buyI}% Buy ratings across ${stAnalystCnt} covering bank analysts.`
      : `Passes ${fScore} of 9 annual financial safety checks with ${peFmt(ownSum, 0)}% long-term insider and institutional backing.`;

  const use30d = stUp30 + stDn30 >= 3;
  const rUp = use30d ? stUp30 : stUp90;
  const rDn = use30d ? stDn30 : stDn90;
  const rTot = rUp + rDn;
  const trendWord = above200dma ? "steady uptrend" : "below 200-day average";

  const momentumRows = [
    {
      simple_label: "Annual financial safety score",
      pro_label: "Piotroski F-Score (9-Point)",
      simple_value: `Passed ${fScore} out of 9 safety checks`,
      pro_value: `${fScore} / 9 F-Score`,
      target_hint: "7/9 or higher shows improving financial health",
      tone: fScore >= 7 ? "good" : fScore >= 5 ? "neutral" : "bad",
    },
    {
      simple_label: "Bank & Wall Street analyst view",
      pro_label: "Sell-Side Consensus & Target Upside",
      simple_value:
        stHasCov && stTargetMean > 0.0
          ? `${buyI}% Buy (${stAnalystCnt} analysts, ${peSfmt(stUpsidePct, 1)}% to target)`
          : stHasCov
          ? `${buyI}% Buy across ${stAnalystCnt} analysts`
          : "Limited analyst coverage",
      pro_value:
        stHasCov && stTargetMean > 0.0
          ? `${buyI}% Buy (N=${stAnalystCnt}) • Target ${ccySym}${peFmt(stTargetMean, 0)} (${peSfmt(stUpsidePct, 1)}%)`
          : stHasCov
          ? `${buyI}% Buy (N=${stAnalystCnt})`
          : "Uncovered",
      target_hint: "Broad analyst support adds conviction",
      tone: stHasCov ? (buyI >= 65 ? "good" : buyI >= 40 ? "neutral" : "warn") : "neutral",
    },
    {
      simple_label: "Recent analyst profit forecast changes",
      pro_label: "Street EPS Revision Breadth",
      simple_value:
        stHasCov && rTot >= 3
          ? `${rUp} raised vs ${rDn} cut profit forecasts recently`
          : stHasCov
          ? "Profit forecasts holding steady"
          : "Tracked via quarterly results",
      pro_value:
        stHasCov && rTot >= 3
          ? `${rUp} Up / ${rDn} Down (${peSfmt(stRevBreadth, 0)}% Breadth)`
          : "Neutral / Steady Revisions",
      target_hint: "More upgrades than cuts is a positive sign",
      tone:
        stHasCov && rTot >= 3
          ? stRevBreadth >= 25.0
            ? "good"
            : stRevBreadth <= -40.0
            ? "bad"
            : "neutral"
          : "neutral",
    },
    {
      simple_label: "Big-investor backing & price trend",
      pro_label: "Institutional/Promoter Stake & 200-DMA Trend",
      simple_value:
        marketCode === "US"
          ? `${peFmt(instPct, 0)}% institutional backing (${trendWord})`
          : `${peFmt(ownSum, 0)}% founder + institutional stake (${trendWord})`,
      pro_value:
        marketCode === "US"
          ? `${peFmt(instPct, 1)}% Inst + ${peFmt(promoterPct, 1)}% Insider • 1Y Mom ${peSfmt(mom121Pct, 1)}%`
          : `${peFmt(promoterPct, 1)}% Prom + ${peFmt(instPct, 1)}% FII/DII • 1Y Mom ${peSfmt(mom121Pct, 1)}%`,
      target_hint: "High long-term ownership aligns incentives",
      tone: ownSum >= 60.0 && above200dma ? "good" : ownSum >= 45.0 ? "neutral" : "warn",
    },
  ];

  const receiptSteps = [
    {
      key: "quality",
      simple_title: "1. Is it a strong, safe business?",
      pro_title: "1. Business Quality & Moat Longevity",
      score_100: peRoundInt(qualityScore),
      weight_pct: peRoundDec(safeFloat(weightsPct.quality, 45.0), 1),
      points_added: peRoundDec(safeFloat(contributions.quality, 0.0), 1),
      verdict_tag: peVerdictTag(qualityScore),
      plain_why: qPlainWhy,
      rows: qualityRows,
    },
    {
      key: "growth",
      simple_title: "2. Are sales & profits growing?",
      pro_title: "2. Multi-Year & Quarterly Growth",
      score_100: peRoundInt(growthScore),
      weight_pct: peRoundDec(safeFloat(weightsPct.growth, 25.0), 1),
      points_added: peRoundDec(safeFloat(contributions.growth, 0.0), 1),
      verdict_tag: peVerdictTag(growthScore),
      plain_why: gPlainWhy,
      rows: growthRows,
    },
    {
      key: "value",
      simple_title: "3. Is the stock fairly priced today?",
      pro_title: "3. GARP Valuation & Margin of Safety",
      score_100: peRoundInt(valueScore),
      weight_pct: peRoundDec(safeFloat(weightsPct.value, 20.0), 1),
      points_added: peRoundDec(safeFloat(contributions.value, 0.0), 1),
      verdict_tag: peVerdictTag(valueScore),
      plain_why: vPlainWhy,
      rows: valueRows,
    },
    {
      key: "momentum",
      simple_title: "4. Financial health & expert view",
      pro_title: "4. Financial Health, Ownership & Street Revisions",
      score_100: peRoundInt(momentumScore),
      weight_pct: peRoundDec(safeFloat(weightsPct.momentum, 10.0), 1),
      points_added: peRoundDec(safeFloat(contributions.momentum, 0.0), 1),
      verdict_tag: peVerdictTag(momentumScore),
      plain_why: mPlainWhy,
      rows: momentumRows,
    },
  ];

  return {
    archetype_code: archetypeCode,
    archetype_label: archetypeLabel,
    one_line_verdict: oneLineVerdict,
    what_it_does: whatItDoes,
    bottom_line_summary: [s1, s2, s3],
    receipt_steps: receiptSteps,
    safety_checks_plain: translatePiotroskiChecks(fChecks),
  };
}

function indexSnapshot(raw) {
  const fundsByTicker = new Map();
  for (const f of raw.fundamentals || []) {
    let list = fundsByTicker.get(f.ticker);
    if (!list) {
      list = [];
      fundsByTicker.set(f.ticker, list);
    }
    list.push(f);
  }
  for (const list of fundsByTicker.values()) {
    list.sort((a, b) => Number(a.fiscal_year) - Number(b.fiscal_year));
  }

  const stage1Lookup = new Map();
  for (const r of raw.stage1_funnel || []) {
    stage1Lookup.set(r.ticker, r);
  }

  const dateToIdx = new Map();
  const dates = raw.price_dates || [];
  dates.forEach((d, idx) => dateToIdx.set(d, idx));

  const firstValidIdx = new Map();
  const dailyRets = new Map();
  const pricesObj = raw.prices || {};
  for (const [tk, arr] of Object.entries(pricesObj)) {
    let first = -1;
    const rets = new Float64Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v !== null && v !== undefined && first === -1) {
        first = i;
      }
      if (i > 0 && arr[i] !== null && arr[i - 1] !== null && arr[i - 1] > 0) {
        rets[i] = arr[i] / arr[i - 1] - 1.0;
      }
    }
    firstValidIdx.set(tk, first);
    dailyRets.set(tk, rets);
  }

  raw._indexed = {
    fundsByTicker,
    stage1Lookup,
    dateToIdx,
    firstValidIdx,
    dailyRets,
  };
  return raw;
}

export async function getSnapshot() {
  if (!cachedSnapshotPromise) {
    cachedSnapshotPromise = window
      .fetch("/static/data/market_snapshot.json", { credentials: "same-origin" })
      .then((resp) => {
        if (!resp.ok) {
          throw new Error(`Failed to load market snapshot (${resp.status})`);
        }
        return resp.json();
      })
      .then((raw) => indexSnapshot(raw));
  }
  return cachedSnapshotPromise;
}

function findDateIndexOnOrBefore(dates, targetDate) {
  let lo = 0;
  let hi = dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= targetDate) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function scoreUniversePointInTime(
  snapshot,
  asOfDate,
  preset = "qglp_compounder",
  customWeights = null,
  includeQuarterlySignals = true,
  companiesOverride = null,
  streetSignalsOverride = null
) {
  const weights = resolveWeights(preset, customWeights);
  const idx = snapshot._indexed;
  const dates = snapshot.price_dates || [];
  const endIdx = idx.dateToIdx.has(asOfDate)
    ? idx.dateToIdx.get(asOfDate)
    : findDateIndexOnOrBefore(dates, asOfDate);

  if (endIdx < 0) return [];

  const qtrMap = includeQuarterlySignals ? snapshot.quarterly_signals || {} : {};
  const streetMap = streetSignalsOverride || snapshot.street_signals || {};
  const results = [];
  const companiesList = companiesOverride || snapshot.companies || [];

  for (const comp of companiesList) {
    const tk = comp.ticker;
    const pxArr = snapshot.prices[tk];
    if (!pxArr) continue;

    const s0 = idx.firstValidIdx.get(tk);
    if (s0 === undefined || s0 < 0 || endIdx - s0 + 1 < 65) continue;

    const curPrice = Number(pxArr[endIdx]);
    if (!curPrice || curPrice <= 0) continue;

    const allFunds = idx.fundsByTicker.get(tk);
    if (!allFunds || allFunds.length === 0) continue;

    const fundRecords = allFunds.filter((r) => String(r.reported_date) <= asOfDate);
    if (fundRecords.length === 0) continue;

    const window8y = fundRecords.slice(-8);
    const window6y = fundRecords.slice(-6);
    const window5y = fundRecords.slice(-5);
    const latest = fundRecords[fundRecords.length - 1];
    const prev = fundRecords.length >= 2 ? fundRecords[fundRecords.length - 2] : null;
    const isFin = Boolean(comp.is_financial);
    const { marketCode, indexTag, marketLabel, currency } = resolveMarketAndIndexTag(comp);
    const promoterPct = Number(comp.promoter_pct || 0.0);
    const instPct = Number(comp.inst_pct || 0.0);

    const qsig = qtrMap[tk];
    const useLiveQtr = Boolean(qsig && String(qsig.signals_reported_date || "9999-12-31") <= asOfDate);

    const ssig = streetMap[tk];
    const streetAvail = Boolean(ssig && String(ssig.signals_as_of_date || "9999-12-31") <= asOfDate);
    const streetAnalystCnt = streetAvail && ssig ? safeInt(ssig.analyst_count, 0) : 0;
    const useStreet = Boolean(streetAvail && ssig && streetAnalystCnt >= 3);
    const fwdG = useStreet && ssig ? clamp(safeFloat(ssig.fwd_eps_growth_fy1_pct, 0.0), -25.0, 45.0) : 0.0;

    const sharesCr = Math.max(0.01, Number(latest.shares_cr));
    const marketCapCr = curPrice * sharesCr;
    const netDebtCr = Number(latest.total_debt_cr) - Number(latest.current_assets_cr) * 0.25;
    const evCr = Math.max(marketCapCr * 0.5, marketCapCr + (isFin ? 0.0 : netDebtCr));

    const patFyCr = Number(latest.net_profit_cr);
    const ttmPatCr = useLiveQtr && qsig ? Number(qsig.ttm_pat_cr || 0.0) : 0.0;
    const patCr = useLiveQtr && ttmPatCr !== 0.0 ? ttmPatCr : patFyCr;

    const ebitCr = Number(latest.ebit_cr);
    const ebitdaCr = Number(latest.ebitda_cr);
    const fcfCr = Number(latest.fcf_cr);
    const equityCr = Number(latest.total_equity_cr);
    const totAssetsCr = Math.max(1.0, Number(latest.total_assets_cr));

    const peRatio = patCr > 0 ? marketCapCr / patCr : 99.9;
    const pbRatio = equityCr > 0 ? marketCapCr / equityCr : 25.0;
    const evEbitda = ebitdaCr > 0 ? evCr / ebitdaCr : 50.0;
    const earningsYieldPct = evCr > 0 ? ((isFin ? patCr : ebitCr) / evCr) * 100.0 : 0.0;
    const fcfYieldPct = marketCapCr > 0 ? (fcfCr / marketCapCr) * 100.0 : 0.0;
    const roaPct = (patFyCr / totAssetsCr) * 100.0;

    const roceCur = Number(latest.roce_pct);
    const roeCur = Number(latest.roe_pct);
    const opmCur = Number(latest.op_margin_pct);
    const deCur = Number(latest.debt_to_equity);

    const med5yRoce = median(window5y.map((r) => Number(r.roce_pct)));
    const med5yRoe = median(window5y.map((r) => Number(r.roe_pct)));
    const profitableYrs = window5y.filter((r) => Number(r.net_profit_cr) > 0).length;
    const profitConsistencyPct = (profitableYrs / Math.max(1, window5y.length)) * 100.0;

    const floorRets = window6y.map((r) => Number(isFin ? r.roe_pct : r.roce_pct));
    const cycleRets = window8y.map((r) => Number(isFin ? r.roe_pct : r.roce_pct));
    const cycleOpms = window8y.map((r) => Number(r.op_margin_pct));
    const sortedFloor = [...floorRets].sort((a, b) => a - b);
    const cycleFloorRet = sortedFloor.length >= 4 ? sortedFloor[1] : sortedFloor[0];
    const retStd8y = cycleRets.length >= 3 ? pstdev(cycleRets) : 3.5;
    const opmStd8y = cycleOpms.length >= 3 ? pstdev(cycleOpms) : 2.0;

    const moatStability = isFin
      ? clamp(0.65 * linearScore(cycleFloorRet, 4.0, 14.5) + 0.35 * linearScore(retStd8y, 8.5, 1.5))
      : clamp(
          0.45 * linearScore(cycleFloorRet, 6.0, 18.0) +
            0.35 * linearScore(opmStd8y, 8.5, 1.8) +
            0.2 * linearScore(retStd8y, 12.0, 2.5)
        );

    const nmLow = String(comp.name || "").toLowerCase();
    const isCommodityBiz = !isFin && COMMODITY_KEYWORDS.some((k) => nmLow.includes(k));
    const isCyclicalProfile =
      isCommodityBiz || (!isFin && (opmStd8y >= 6.0 || retStd8y >= 10.5 || cycleFloorRet < 8.5));

    const sumCfo5y = window5y.reduce((acc, r) => acc + Number(r.cfo_cr), 0);
    const sumEbitda5y = window5y.reduce((acc, r) => acc + Math.max(0.0, Number(r.ebitda_cr)), 0);
    let cumCfoEbitda5y =
      !isFin && sumEbitda5y > 1.0 ? (sumCfo5y / sumEbitda5y) * 100.0 : Number(latest.cfo_to_ebitda_pct);
    cumCfoEbitda5y = clamp(cumCfoEbitda5y, -25.0, 140.0);

    const revCagr3y = computeCagr(fundRecords, "revenue_cr", 3);
    const revCagr5y = computeCagr(fundRecords, "revenue_cr", 5);
    const patCagr3y = computeCagr(fundRecords, "net_profit_cr", 3);
    const patCagr5y = computeCagr(fundRecords, "net_profit_cr", 5);

    const blendedRevCagr = 0.55 * revCagr5y + 0.45 * revCagr3y;
    const blendedPatCagr = 0.5 * patCagr5y + 0.5 * patCagr3y;
    const normalizedPatCagr =
      cycleFloorRet < 9.5 && blendedPatCagr > 25.0 ? Math.min(blendedPatCagr, 19.0) : blendedPatCagr;

    const hasQtrData = Boolean(useLiveQtr && qsig && qsig.has_qtr_data);
    const hasShTrend = Boolean(useLiveQtr && qsig && qsig.has_sh_trend);
    const qtrRevYoy = hasQtrData ? Number(qsig.qtr_rev_yoy_pct) : blendedRevCagr;
    const qtrPatYoy = hasQtrData ? Number(qsig.qtr_pat_yoy_pct) : blendedPatCagr;
    const qtrOpmDelta = hasQtrData ? Number(qsig.qtr_opm_delta_pct) : 0.0;
    const promoterChg1y = hasShTrend ? Number(qsig.promoter_chg_1y_pct) : 0.0;
    const instChg1y = hasShTrend ? Number(qsig.inst_chg_1y_pct) : 0.0;
    const gnpaPct = useLiveQtr && qsig ? Number(qsig.gnpa_pct) : 0.0;
    const nnpaPct = useLiveQtr && qsig ? Number(qsig.nnpa_pct) : 0.0;
    const latestQtrLabel = useLiveQtr && qsig ? String(qsig.latest_qtr_label || "") : "";

    const validLen = endIdx - s0 + 1;
    const idx6m = endIdx - Math.min(validLen, 126) + 1;
    const ret6mPct = (curPrice / Number(pxArr[idx6m]) - 1.0) * 100.0;
    const mom12_1Pct =
      validLen >= 252 ? (Number(pxArr[endIdx - 20]) / Number(pxArr[endIdx - 251]) - 1.0) * 100.0 : ret6mPct;

    let sum200 = 0.0;
    const start200 = Math.max(s0, endIdx - 199);
    for (let i = start200; i <= endIdx; i++) sum200 += Number(pxArr[i]);
    const dma200 = sum200 / (endIdx - start200 + 1);
    const above200dma = curPrice >= dma200 * 0.96;

    const tkRets = idx.dailyRets.get(tk);
    const startVol = Math.max(s0 + 1, endIdx - 250);
    const volSlice = [];
    for (let i = startVol; i <= endIdx; i++) volSlice.push(tkRets[i]);
    const volAnnualPct = volSlice.length > 20 ? sampleStd(volSlice) * Math.sqrt(252.0) * 100.0 : 25.0;
    const riskAdjMom = mom12_1Pct / Math.max(12.0, volAnnualPct);

    const [fScore, fChecks] = computePiotroskiFScore(latest, prev, isFin);

    const sustainedRoce = 0.6 * med5yRoce + 0.4 * roceCur;
    const sustainedRoe = 0.6 * med5yRoe + 0.4 * roeCur;
    const cfoCur = Number(latest.cfo_cr);
    const cfoToDebtRatio = cfoCur / Math.max(1.0, Number(latest.total_debt_cr));
    const isPaymentNetwork = tk === "MA" || tk === "V";
    const buybackDistortedEquity = Boolean(
      (!isFin || isPaymentNetwork) &&
        (equityCr <= 0 || deCur > 1.8 || (marketCode === "US" && pbRatio >= 24.9)) &&
        patCr > 0 &&
        cfoCur > 0 &&
        cfoToDebtRatio >= 0.35 &&
        sustainedRoce >= 18.0
    );
    const cfoToDebtPct = peRoundDec(cfoToDebtRatio * 100.0, 1);

    let qReturn;
    let qLev;
    let qCash;
    let qMargin;
    if (isFin) {
      qReturn = 0.6 * linearScore(sustainedRoe, 8.0, 19.0) + 0.4 * linearScore(roaPct, 0.5, 2.2);
      qLev = buybackDistortedEquity
        ? linearScore(cfoToDebtRatio, 0.15, 0.65)
        : linearScore(deCur, 11.0, 2.0);
      qCash = profitConsistencyPct;
      if (gnpaPct > 0) {
        const qAssetQual = 0.55 * linearScore(nnpaPct, 1.8, 0.25) + 0.45 * linearScore(gnpaPct, 5.0, 1.3);
        qMargin = 0.5 * linearScore(opmCur, 8.0, 28.0) + 0.5 * qAssetQual;
      } else {
        qMargin = linearScore(opmCur, 8.0, 28.0);
      }
    } else {
      qReturn = 0.55 * linearScore(sustainedRoce, 8.0, 30.0) + 0.45 * linearScore(sustainedRoe, 8.0, 26.0);
      qLev = buybackDistortedEquity
        ? linearScore(cfoToDebtRatio, 0.15, 0.65)
        : linearScore(deCur, 1.8, 0.05);
      qCash = 0.65 * linearScore(cumCfoEbitda5y, 50.0, 95.0) + 0.35 * profitConsistencyPct;
      qMargin = linearScore(opmCur, 8.0, 26.0);
    }

    const qualityScore = clamp(
      0.34 * qReturn + 0.22 * moatStability + 0.16 * qLev + 0.18 * qCash + 0.1 * qMargin
    );

    let effectiveGrowthAnchor = clamp(
      0.7 * normalizedPatCagr + 0.3 * (hasQtrData ? qtrPatYoy : patCagr3y),
      5.0,
      !isCyclicalProfile ? 28.0 : 16.0
    );
    if (useStreet && fwdG !== 0.0) {
      effectiveGrowthAnchor = 0.8 * effectiveGrowthAnchor + 0.2 * clamp(fwdG, 5.0, 30.0);
    }
    const pegRatio = patCr > 0 ? peRatio / effectiveGrowthAnchor : 9.9;

    let fairPe;
    if (isFin) {
      fairPe =
        10.0 +
        clamp((sustainedRoe - 10.0) * 1.0, 0.0, 9.5) +
        clamp(normalizedPatCagr * 0.32, 0.0, 6.5);
      if (cycleFloorRet < 9.0) fairPe = Math.min(fairPe, 15.5);
    } else {
      fairPe =
        13.0 +
        clamp((sustainedRoce - 12.0) * 0.52, 0.0, 12.5) +
        clamp(normalizedPatCagr * 0.52, 0.0, 12.5);
      if (isCommodityBiz) fairPe = Math.min(fairPe, 15.5);
      else if (isCyclicalProfile) fairPe = Math.min(fairPe, 20.0);
    }
    fairPe = roundTo(clamp(fairPe, 10.0, 38.0), 1);

    const vPeg = patCr > 0 ? linearScore(pegRatio, 3.0, 0.95) : 0.0;
    const vEy = linearScore(earningsYieldPct, 2.0, 9.0);
    const vPeRel = patCr > 0 ? linearScore(peRatio / Math.max(8.0, fairPe), 1.75, 0.75) : 0.0;
    const vPb = equityCr > 0 ? linearScore(pbRatio, 4.5, 1.1) : 0.0;
    const vFcf = linearScore(fcfYieldPct, 0.5, 5.5);
    const effVPb = buybackDistortedEquity && (pbRatio >= 24.9 || equityCr <= 0) ? vFcf : vPb;

    const valueScore = isFin
      ? clamp(0.35 * effVPb + 0.35 * vPeRel + 0.3 * vPeg)
      : clamp(0.35 * vPeg + 0.3 * vPeRel + 0.2 * vEy + 0.15 * vFcf);

    let valuationZone;
    if (patCr <= 0 || peRatio > fairPe * 1.55 || (peRatio > 55.0 && pegRatio > 2.2)) {
      valuationZone = "Overvalued / Wait for Dip";
    } else if (peRatio <= fairPe * 0.9) {
      valuationZone = "Undervalued (Margin of Safety)";
    } else if (peRatio <= fairPe * 1.2) {
      valuationZone = "Fair GARP Price";
    } else {
      valuationZone = "Slightly Rich (Stagger SIP)";
    }

    const gRev = linearScore(blendedRevCagr, 4.0, 20.0);
    const gPat = linearScore(normalizedPatCagr, 5.0, 23.0);
    const annualGrowthScore = clamp(0.42 * gRev + 0.58 * gPat);
    let growthScore;
    let qtrGrowthScore = annualGrowthScore;
    if (hasQtrData) {
      const qGRev = linearScore(qtrRevYoy, -4.0, 20.0);
      const qGPat = linearScore(qtrPatYoy, -6.0, 24.0);
      const qGOpm = linearScore(qtrOpmDelta, -2.5, 2.5);
      qtrGrowthScore = clamp(0.4 * qGRev + 0.45 * qGPat + 0.15 * qGOpm);
      growthScore = clamp(0.68 * annualGrowthScore + 0.32 * qtrGrowthScore);
    } else {
      growthScore = annualGrowthScore;
    }
    if (useStreet && fwdG !== 0.0) {
      growthScore = clamp(0.2 * linearScore(fwdG, -2.0, 24.0) + 0.8 * growthScore);
    }

    const mPiotroski = (fScore / 9.0) * 100.0;
    const smartMoneyChg = promoterChg1y + instChg1y;
    const ownershipScore = hasShTrend
      ? clamp(
          0.55 * linearScore(smartMoneyChg, -4.0, 2.5) +
            0.45 * linearScore(promoterPct + instPct, 45.0, 82.0)
        )
      : promoterPct + instPct > 0
      ? linearScore(promoterPct + instPct, 40.0, 80.0)
      : 60.0;

    const up30 = useStreet && ssig ? safeInt(ssig.eps_rev_up_30d, 0) : 0;
    const dn30 = useStreet && ssig ? safeInt(ssig.eps_rev_down_30d, 0) : 0;
    const up90 = useStreet && ssig ? safeInt(ssig.eps_rev_up_90d, 0) : 0;
    const dn90 = useStreet && ssig ? safeInt(ssig.eps_rev_down_90d, 0) : 0;
    const use30dRevs = up30 + dn30 >= 3;
    const totRevs = use30dRevs ? up30 + dn30 : up90 + dn90;
    const revBreadth = useStreet && ssig ? safeFloat(ssig.rev_breadth_pct, 0.0) : 0.0;
    const buyPct = useStreet && ssig ? safeFloat(ssig.consensus_buy_pct, 50.0) : 50.0;

    let revisionScore = 50.0;
    let momentumScore;
    if (useStreet) {
      revisionScore = totRevs >= 3 ? linearScore(revBreadth, -60.0, 70.0) : linearScore(buyPct, 30.0, 85.0);
      if (preset === "qglp_compounder" || preset === "coffee_can") {
        const mTrend = above200dma ? 75.0 : 35.0;
        const mSteady = linearScore(mom12_1Pct, -18.0, 28.0);
        momentumScore = clamp(
          0.38 * mPiotroski + 0.25 * ownershipScore + 0.22 * revisionScore + 0.1 * mSteady + 0.05 * mTrend
        );
      } else {
        const m121 = linearScore(mom12_1Pct, -12.0, 38.0);
        const mRiskAdj = linearScore(riskAdjMom, -0.4, 1.5);
        momentumScore = clamp(
          0.3 * m121 + 0.2 * mRiskAdj + 0.2 * mPiotroski + 0.15 * ownershipScore + 0.15 * revisionScore
        );
      }
    } else if (preset === "qglp_compounder" || preset === "coffee_can") {
      const mTrend = above200dma ? 75.0 : 35.0;
      const mSteady = linearScore(mom12_1Pct, -18.0, 28.0);
      momentumScore = clamp(0.45 * mPiotroski + 0.3 * ownershipScore + 0.15 * mSteady + 0.1 * mTrend);
    } else {
      const m121 = linearScore(mom12_1Pct, -12.0, 38.0);
      const mRiskAdj = linearScore(riskAdjMom, -0.4, 1.5);
      momentumScore = clamp(0.35 * m121 + 0.25 * mRiskAdj + 0.25 * mPiotroski + 0.15 * ownershipScore);
    }

    const redFlags = [];
    const penaltyItems = [];
    const strengths = [];
    let penalty = 0.0;
    let valuationCapped = false;

    function addFlag(msg, pts) {
      redFlags.push(msg);
      penalty += pts;
      penaltyItems.push({ reason: msg, points: -roundTo(pts, 1) });
    }

    if (patCr <= 0 || patFyCr <= 0) {
      addFlag("Loss-making in latest fiscal year or TTM (PAT <= 0)", 20.0);
    }
    if (profitableYrs < Math.max(1, window5y.length - 1)) {
      addFlag(`Inconsistent profitability (${profitableYrs}/${window5y.length} profitable years)`, 10.0);
    }
    if (useStreet && streetAnalystCnt >= 5 && totRevs >= 5 && revBreadth <= -55.0) {
      const actUp = use30dRevs ? up30 : up90;
      const actDn = use30dRevs ? dn30 : dn90;
      const actWin = use30dRevs ? "30d" : "90d";
      addFlag(
        `Widespread sell-side EPS cuts (${actDn} down vs ${actUp} up over ${actWin}, ${jsRoundInt(revBreadth)}% breadth)`,
        6.0
      );
    }
    if (equityCr <= 0 && !buybackDistortedEquity) {
      addFlag("Negative net worth / eroded book equity", 15.0);
    }
    if (!isFin && deCur > 1.8 && !buybackDistortedEquity) {
      addFlag(`High corporate debt load (D/E ${deCur.toFixed(2)}x)`, 12.0);
    }
    if (!isFin && cumCfoEbitda5y < 55.0) {
      addFlag(`Weak 5Y cumulative cash conversion (${Math.round(cumCfoEbitda5y)}% CFO/EBITDA)`, 10.0);
    }
    if (patCagr3y < -10.0 && patCagr5y < -5.0) {
      addFlag(`Structural multi-year profit contraction (${patCagr3y.toFixed(1)}% 3Y PAT CAGR)`, 10.0);
    }
    if (hasQtrData && (qtrPatYoy <= -15.0 || (qtrRevYoy <= -6.0 && qtrPatYoy < 0.0))) {
      const sPat = `${qtrPatYoy >= 0 ? "+" : ""}${qtrPatYoy.toFixed(1)}%`;
      const sRev = `${qtrRevYoy >= 0 ? "+" : ""}${qtrRevYoy.toFixed(1)}%`;
      addFlag(`Recent 2Q earnings slowdown (${sPat} YoY PAT, ${sRev} YoY Sales in ${latestQtrLabel})`, 9.0);
    }
    if (
      hasShTrend &&
      ((smartMoneyChg <= -4.5 && promoterPct + instPct < 72.0) ||
        (promoterChg1y <= -3.5 && instChg1y < 0.5))
    ) {
      const sPr = `${promoterChg1y >= 0 ? "+" : ""}${promoterChg1y.toFixed(1)}%`;
      const sIn = `${instChg1y >= 0 ? "+" : ""}${instChg1y.toFixed(1)}%`;
      addFlag(`4Q Promoter/Institutional exit (${sPr} Promoter, ${sIn} FII+DII)`, 7.0);
    }
    if (isFin && gnpaPct > 0 && (nnpaPct > 1.5 || gnpaPct > 4.5)) {
      addFlag(`Elevated banking NPAs (Gross NPA ${gnpaPct.toFixed(2)}%, Net NPA ${nnpaPct.toFixed(2)}%)`, 10.0);
    }
    if (isCommodityBiz && moatStability < 55.0) {
      const maxCyc = Math.max(...cycleRets);
      addFlag(
        `Commodity cyclicality risk (8Y ROCE swung ${Math.round(cycleFloorRet)}%–${Math.round(maxCyc)}%)`,
        5.0
      );
    }
    if (fScore <= 3) {
      addFlag(`Weak Piotroski financial health (${fScore}/9)`, 10.0);
    }
    if (
      patCr > 0 &&
      peRatio < 99.0 &&
      ((peRatio > 56.0 && pegRatio > 2.1) || (isCyclicalProfile && peRatio > fairPe * 1.75))
    ) {
      addFlag(
        `Valuation rich at ${peRatio.toFixed(1)}x P/E (Fair ~${fairPe.toFixed(1)}x, PEG ${pegRatio.toFixed(1)}x) — wait for pullback`,
        8.0
      );
      valuationCapped = true;
    }

    if (isFin && sustainedRoe >= 14.5) {
      const npaNote = gnpaPct > 0 ? `, Net NPA ${nnpaPct.toFixed(2)}%` : "";
      strengths.push(
        `Consistent banking compounder (5Y Med ROE ${med5yRoe.toFixed(1)}%, Cycle Floor ${Math.round(cycleFloorRet)}%${npaNote})`
      );
    } else if (!isFin && sustainedRoce >= 18.0 && moatStability >= 65.0) {
      strengths.push(
        `All-weather moat (5Y Med ROCE ${med5yRoce.toFixed(1)}%, 8Y Cycle Floor ${Math.round(cycleFloorRet)}%, Stability ${Math.round(moatStability)}/100)`
      );
    } else if (!isFin && sustainedRoce >= 18.0) {
      strengths.push(
        `Strong capital return (5Y Med ROCE ${med5yRoce.toFixed(1)}%, Latest ${roceCur.toFixed(1)}%, ${profitableYrs}/${window5y.length} yrs profitable)`
      );
    }
    if (hasQtrData && qtrPatYoy >= 12.0 && qtrRevYoy >= 8.0) {
      strengths.push(
        `Healthy latest 2Q trajectory (+${qtrPatYoy.toFixed(1)}% YoY PAT, +${qtrRevYoy.toFixed(1)}% YoY Sales through ${latestQtrLabel})`
      );
    }
    if (useStreet && totRevs >= 5 && revBreadth >= 55.0) {
      const actUp = use30dRevs ? up30 : up90;
      const actDn = use30dRevs ? dn30 : dn90;
      const actWin = use30dRevs ? "30d" : "90d";
      strengths.push(
        `Strong Street EPS upgrade momentum (${actUp} up vs ${actDn} down over ${actWin}, +${jsRoundInt(revBreadth)}% breadth)`
      );
    }
    if (!isFin && cumCfoEbitda5y >= 82.0) {
      strengths.push(`Clean 5Y cash-flow conversion (${Math.round(cumCfoEbitda5y)}% cumulative CFO/EBITDA)`);
    }
    if (!isFin && deCur <= 0.25 && equityCr > 0) {
      strengths.push(`Fortress balance sheet with minimal debt (D/E ${deCur.toFixed(2)}x)`);
    }
    if (patCr > 0 && peRatio <= fairPe * 1.1) {
      strengths.push(
        `Reasonable GARP entry price (${peRatio.toFixed(1)}x P/E vs Fair ~${fairPe.toFixed(1)}x, PEG ${pegRatio.toFixed(2)}x)`
      );
    }
    if (hasShTrend && instChg1y >= 1.0 && promoterChg1y >= -0.4) {
      strengths.push(
        `Institutional accumulation (+${instChg1y.toFixed(1)}% FII+DII stake added over 4Q; Total Prom+Inst ${(promoterPct + instPct).toFixed(1)}%)`
      );
    } else if (promoterPct + instPct >= 65.0) {
      if (marketCode === "US") {
        strengths.push(
          `Strong institutional & insider ownership (${instPct.toFixed(1)}% Institutional + ${promoterPct.toFixed(1)}% Insider)`
        );
      } else {
        strengths.push(
          `High institutional & promoter skin-in-the-game (${promoterPct.toFixed(1)}% Promoter + ${instPct.toFixed(1)}% FII/DII)`
        );
      }
    }
    if (strengths.length === 0) {
      if (indexTag === "SP500") {
        strengths.push("Established S&P 500 operating franchise");
      } else if (indexTag === "NASDAQ100") {
        strengths.push("Established Nasdaq-100 operating franchise");
      } else {
        strengths.push("Established NSE Nifty-200 operating franchise");
      }
    }

    const rawComposite =
      weights.quality * qualityScore +
      weights.value * valueScore +
      weights.growth * growthScore +
      weights.momentum * momentumScore;
    const compositeScore = roundTo(clamp(rawComposite - penalty), 1);

    let rating;
    let conviction;
    let ratingRule;
    if (valuationCapped && compositeScore >= 45.0 && patCr > 0) {
      rating = "Hold";
      conviction = "Great Business, Rich Price — Buy on Dip";
      ratingRule = `Score ${compositeScore.toFixed(1)}/100 passes quality threshold, but Valuation Guardrail fired (P/E ${peRatio.toFixed(1)}x vs Fair ~${fairPe.toFixed(1)}x) → Capped at Hold until pullback.`;
    } else if (compositeScore >= 68.0 && redFlags.length === 0) {
      rating = "Strong Buy";
      conviction = "Core Long-Term Compounder";
      ratingRule = `Composite Score ${compositeScore.toFixed(1)}/100 ≥ 68.0 with 0 forensic or valuation red flags → Strong Buy.`;
    } else if (compositeScore >= 57.0 && patCr > 0 && profitableYrs >= window5y.length - 1) {
      rating = "Buy";
      conviction = "Accumulate for 3-5Y+";
      ratingRule =
        `Composite Score ${compositeScore.toFixed(1)}/100 ≥ 57.0 with ${profitableYrs}/${window5y.length} profitable years ` +
        (redFlags.length > 0 && compositeScore >= 68.0
          ? "(prevented from Strong Buy due to guardrail flag)"
          : "→ Buy.");
    } else if (compositeScore >= 45.0 && patCr > 0) {
      rating = "Hold";
      conviction = "Watchlist / Hold Existing";
      ratingRule = `Composite Score ${compositeScore.toFixed(1)}/100 is in the 45–57 neutral zone (or profit consistency < 4/5 yrs) → Hold.`;
    } else {
      rating = "Avoid";
      conviction = "Fundamental / Balance-Sheet Caution";
      ratingRule = `Composite Score ${compositeScore.toFixed(1)}/100 < 45.0 or negative TTM/FY profit → Avoid.`;
    }

    const scoreBreakdown = {
      preset_used: preset,
      weights_pct: {
        quality: roundTo(weights.quality * 100.0, 1),
        value: roundTo(weights.value * 100.0, 1),
        growth: roundTo(weights.growth * 100.0, 1),
        momentum: roundTo(weights.momentum * 100.0, 1),
      },
      contributions: {
        quality: roundTo(weights.quality * qualityScore, 1),
        value: roundTo(weights.value * valueScore, 1),
        growth: roundTo(weights.growth * growthScore, 1),
        momentum: roundTo(weights.momentum * momentumScore, 1),
      },
      raw_composite: roundTo(rawComposite, 1),
      total_penalty: roundTo(penalty, 1),
      penalty_items: penaltyItems,
      final_score: compositeScore,
      valuation_capped: valuationCapped,
      rating_rule: ratingRule,
      sub_scores: {
        capital_return: Math.round(qReturn),
        moat_stability: Math.round(moatStability),
        balance_sheet: Math.round(qLev),
        cash_conversion: Math.round(qCash),
        operating_margin: Math.round(qMargin),
        peg_attractiveness: Math.round(vPeg),
        fair_pe_discount: Math.round(vPeRel),
        multi_year_cagr: Math.round(annualGrowthScore),
        quarterly_momentum: Math.round(qtrGrowthScore),
        piotroski_health: Math.round(mPiotroski),
        ownership_conviction: Math.round(ownershipScore),
        eps_revision_momentum: Math.round(revisionScore),
      },
    };

    const s1 = idx.stage1Lookup.get(tk) || {};
    const pillarsPayload = {
      quality: roundTo(qualityScore, 1),
      value: roundTo(valueScore, 1),
      growth: roundTo(growthScore, 1),
      momentum: roundTo(momentumScore, 1),
    };
    const streetPayload = buildStreetPayload(ssig, streetAvail, curPrice);
    const plainEnglishPayload = buildPlainEnglish({
      ticker: tk,
      name: comp.name,
      sector: comp.sector,
      industry: comp.industry || s1.industry || "",
      business_summary: comp.business_summary || "",
      market_code: marketCode,
      currency,
      is_fin: isFin,
      is_commodity_biz: isCommodityBiz,
      is_cyclical: isCyclicalProfile,
      buyback_distorted_equity: buybackDistortedEquity,
      pat_cr: patCr,
      pat_fy_cr: patFyCr,
      equity_cr: equityCr,
      pe_ratio: peRatio,
      fair_pe: fairPe,
      peg_ratio: pegRatio,
      pb_ratio: pbRatio,
      fcf_yield_pct: fcfYieldPct,
      earnings_yield_pct: earningsYieldPct,
      roce_cur: roceCur,
      med_5y_roce: med5yRoce,
      roe_cur: roeCur,
      med_5y_roe: med5yRoe,
      sustained_roce: sustainedRoce,
      roa_pct: roaPct,
      cycle_floor_ret: cycleFloorRet,
      moat_stability: moatStability,
      opm_cur: opmCur,
      de_cur: deCur,
      cum_cfo_ebitda_5y: cumCfoEbitda5y,
      cfo_to_debt_pct: cfoToDebtPct,
      profitable_yrs: profitableYrs,
      window_5y_len: window5y.length,
      rev_cagr_3y: revCagr3y,
      rev_cagr_5y: revCagr5y,
      pat_cagr_3y: patCagr3y,
      pat_cagr_5y: patCagr5y,
      has_qtr_data: hasQtrData,
      qtr_rev_yoy: qtrRevYoy,
      qtr_pat_yoy: qtrPatYoy,
      latest_qtr_label: latestQtrLabel,
      gnpa_pct: gnpaPct,
      nnpa_pct: nnpaPct,
      f_score: fScore,
      f_checks: fChecks,
      promoter_pct: promoterPct,
      inst_pct: instPct,
      mom_12_1_pct: mom12_1Pct,
      above_200dma: above200dma,
      composite_score: compositeScore,
      rating,
      valuation_zone: valuationZone,
      valuation_capped: valuationCapped,
      pillars: pillarsPayload,
      score_breakdown: scoreBreakdown,
      street: streetPayload,
    });

    results.push({
      ticker: tk,
      name: comp.name,
      sector: comp.sector,
      market: marketCode,
      index_tag: indexTag,
      market_label: marketLabel,
      currency,
      cap_tier: comp.cap_tier || "Large Cap",
      data_source: comp.data_source || "real_nse_screener",
      is_financial: isFin,
      is_cyclical: isCyclicalProfile,
      price: roundTo(curPrice, 2),
      market_cap_cr: Math.round(marketCapCr),
      composite_score: compositeScore,
      stage1_rank: s1.stage1_rank ?? null,
      stage1_score: s1.stage1_score ?? null,
      rating,
      conviction,
      valuation_zone: valuationZone,
      pillars: pillarsPayload,
      metrics: {
        roce_pct: roundTo(isFin ? roeCur : roceCur, 1),
        med_5y_roce_pct: roundTo(isFin ? med5yRoe : med5yRoce, 1),
        cycle_floor_roce_pct: roundTo(cycleFloorRet, 1),
        moat_stability_score: Math.round(moatStability),
        roe_pct: roundTo(roeCur, 1),
        roa_pct: roundTo(roaPct, 2),
        op_margin_pct: roundTo(opmCur, 1),
        debt_to_equity: roundTo(deCur, 2),
        cfo_to_ebitda_pct: roundTo(cumCfoEbitda5y, 1),
        cfo_to_debt_pct: cfoToDebtPct,
        buyback_equity: buybackDistortedEquity,
        profit_consistency: `${profitableYrs}/${window5y.length}`,
        pe_ratio: roundTo(peRatio, 1),
        fair_pe: fairPe,
        peg_ratio: roundTo(pegRatio, 2),
        pb_ratio: roundTo(pbRatio, 2),
        ev_ebitda: roundTo(evEbitda, 1),
        earnings_yield_pct: roundTo(earningsYieldPct, 2),
        fcf_yield_pct: roundTo(fcfYieldPct, 2),
        rev_cagr_3y_pct: roundTo(revCagr3y, 1),
        rev_cagr_5y_pct: roundTo(revCagr5y, 1),
        pat_cagr_3y_pct: roundTo(patCagr3y, 1),
        pat_cagr_5y_pct: roundTo(patCagr5y, 1),
        qtr_rev_yoy_pct: roundTo(qtrRevYoy, 1),
        qtr_pat_yoy_pct: roundTo(qtrPatYoy, 1),
        qtr_opm_delta_pct: roundTo(qtrOpmDelta, 1),
        latest_qtr_label: latestQtrLabel,
        promoter_chg_1y_pct: roundTo(promoterChg1y, 2),
        inst_chg_1y_pct: roundTo(instChg1y, 2),
        gnpa_pct: roundTo(gnpaPct, 2),
        nnpa_pct: roundTo(nnpaPct, 2),
        ret_6m_pct: roundTo(ret6mPct, 1),
        mom_12_1_pct: roundTo(mom12_1Pct, 1),
        volatility_pct: roundTo(volAnnualPct, 1),
        piotroski_f_score: fScore,
        promoter_pct: roundTo(promoterPct, 1),
        inst_pct: roundTo(instPct, 1),
        latest_fy: Number(latest.fiscal_year),
      },
      street: streetPayload,
      strengths: strengths.slice(0, 5),
      red_flags: redFlags.slice(0, 5),
      piotroski_checks: fChecks,
      score_breakdown: scoreBreakdown,
      plain_english: plainEnglishPayload,
    });
  }

  results.sort((a, b) => b.composite_score - a.composite_score);
  results.forEach((item, i) => {
    item.rank = i + 1;
  });
  return results;
}

export async function runScreenerSnapshot(payload) {
  const snapshot = await getSnapshot();
  const dates = snapshot.price_dates || [];
  const asOf = dates[dates.length - 1] || snapshot.as_of_date;
  const preset = payload.preset || "qglp_compounder";
  const sector = payload.sector || "ALL";
  const minScore = Number(payload.min_score || 0);
  const market = ALLOWED_MARKETS.has(payload.market) ? payload.market : "ALL";

  const allScored = scoreUniversePointInTime(snapshot, asOf, preset, payload.weights || null, true);
  const countIn = allScored.filter((s) => s.market === "IN").length;
  const countUs = allScored.filter((s) => s.market === "US").length;
  const countNdx = allScored.filter((s) => s.index_tag === "NASDAQ100").length;
  const countSp500 = allScored.filter((s) => s.index_tag === "SP500").length;
  const marketCounts = {
    ALL: allScored.length,
    IN: countIn,
    US: countUs,
    NASDAQ100: countNdx,
    SP500: countSp500,
  };

  const normStage1 = (snapshot.stage1_funnel || []).map((r) => {
    const { marketCode, indexTag, marketLabel, currency } = resolveMarketAndIndexTag(r);
    return {
      ...r,
      market: marketCode,
      index_tag: indexTag,
      market_label: marketLabel,
      currency,
    };
  });

  let scored;
  let stage1View;
  let companiesView;
  if (market !== "ALL") {
    scored = allScored.filter((s) => matchesMarketFilter(s.market, s.index_tag, market));
    scored.forEach((item, idx) => {
      item.rank = idx + 1;
    });
    stage1View = normStage1.filter((r) => matchesMarketFilter(r.market, r.index_tag, market));
    companiesView = (snapshot.companies || []).filter((c) => {
      const { marketCode, indexTag } = resolveMarketAndIndexTag(c);
      return matchesMarketFilter(marketCode, indexTag, market);
    });
  } else {
    scored = allScored;
    stage1View = normStage1;
    companiesView = snapshot.companies || [];
  }

  const sectors = [...new Set(companiesView.map((c) => c.sector))].sort();
  const filtered = scored.filter(
    (s) => (sector === "ALL" || s.sector === sector) && s.composite_score >= minScore
  );
  const filteredStage1 = stage1View.filter((r) => sector === "ALL" || r.sector === sector);

  const ratingCounts = { "Strong Buy": 0, Buy: 0, Hold: 0, Avoid: 0 };
  for (const s of scored) {
    ratingCounts[s.rating] = (ratingCounts[s.rating] || 0) + 1;
  }

  const bmNifty = latestValidPrice(snapshot.prices[BENCHMARK_TICKER]);
  const bmSp500 = latestValidPrice(snapshot.prices[SP500_BENCHMARK_TICKER]);
  const bmNasdaq = latestValidPrice(snapshot.prices[NASDAQ_BENCHMARK_TICKER]);
  const unscoredRemaining = stage1View.filter((r) => !r.deep_scored).length;

  return {
    as_of_date: asOf,
    market,
    market_counts: marketCounts,
    benchmark_nifty50: roundTo(bmNifty, 2),
    benchmark_sp500: roundTo(bmSp500, 2),
    benchmark_nasdaq100: roundTo(bmNasdaq, 2),
    preset_weights: PRESET_WEIGHTS,
    sectors,
    rating_counts: ratingCounts,
    total_stage1_scanned: stage1View.length || companiesView.length,
    total_deep_scored: scored.length,
    unscored_funnel_remaining: unscoredRemaining,
    total_universe: scored.length,
    stocks: filtered,
    stage1_funnel: filteredStage1,
  };
}

export async function getCompanyDetailSnapshot(ticker, preset = "qglp_compounder", customWeights = null) {
  const snapshot = await getSnapshot();
  const cleaned = String(ticker || "").trim().toUpperCase();
  const companies = snapshot.companies || [];
  let comp = companies.find((c) => c.ticker === cleaned);
  let tk = cleaned;
  if (!comp && !cleaned.endsWith(".NS") && !cleaned.endsWith(".BO")) {
    const fallbackNs = `${cleaned}.NS`;
    comp = companies.find((c) => c.ticker === fallbackNs);
    if (comp) tk = fallbackNs;
  }
  if (!comp) {
    throw new Error(`Company ${cleaned} not found in snapshot.`);
  }
  const {
    marketCode: cMkt,
    indexTag: cIdxTag,
    marketLabel: cLabel,
    currency: cCcy,
  } = resolveMarketAndIndexTag(comp);
  const compOut = {
    ...comp,
    market: cMkt,
    index_tag: cIdxTag,
    market_label: cLabel,
    currency: cCcy,
  };

  const dates = snapshot.price_dates || [];
  const asOf = dates[dates.length - 1] || snapshot.as_of_date;
  const effPreset = preset === "custom" && customWeights ? "custom" : PRESET_WEIGHTS[preset] ? preset : "qglp_compounder";
  const scored = scoreUniversePointInTime(snapshot, asOf, effPreset, customWeights, true);
  const scorecard = scored.find((s) => s.ticker === tk) || null;
  const fundamentals = snapshot._indexed.fundsByTicker.get(tk) || [];

  const pxArr = snapshot.prices[tk] || [];
  const rawHistory = [];
  for (let i = 0; i < dates.length; i++) {
    if (pxArr[i] !== null && pxArr[i] !== undefined) {
      rawHistory.push({ trade_date: dates[i], close_price: pxArr[i] });
    }
  }
  const stride = Math.max(1, Math.floor(rawHistory.length / 160));
  const sampled = [];
  for (let i = 0; i < rawHistory.length; i += stride) {
    sampled.push(rawHistory[i]);
  }
  if (rawHistory.length > 0 && sampled[sampled.length - 1] !== rawHistory[rawHistory.length - 1]) {
    sampled.push(rawHistory[rawHistory.length - 1]);
  }

  return {
    company: compOut,
    scorecard,
    fundamentals,
    price_history: sampled,
  };
}

function computeBacktestWeights(selected, scheme) {
  if (!selected || selected.length === 0) return {};
  const n = selected.length;
  const raw = {};
  for (const s of selected) {
    if (scheme === "score") {
      raw[s.ticker] = Math.pow(Math.max(5.0, Number(s.composite_score) - 40.0), 1.4);
    } else if (scheme === "inv_vol") {
      raw[s.ticker] = 1.0 / Math.max(12.0, Number(s.metrics.volatility_pct));
    } else {
      raw[s.ticker] = 1.0 / n;
    }
  }
  const tot = Object.values(raw).reduce((a, b) => a + b, 0);
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v / tot;
  return out;
}

export async function runBacktestSnapshot(payload) {
  const snapshot = await getSnapshot();
  const allDates = snapshot.price_dates || [];
  const idx = snapshot._indexed;
  if (allDates.length < 130) {
    throw new Error("Insufficient price history in snapshot for backtesting.");
  }

  const effMarket = ALLOWED_MARKETS.has(payload.market) ? payload.market : "IN";
  const allCompanies = snapshot.companies || [];
  const evalCompanies =
    effMarket !== "ALL"
      ? allCompanies.filter((c) => {
          const { marketCode, indexTag } = resolveMarketAndIndexTag(c);
          return matchesMarketFilter(marketCode, indexTag, effMarket);
        })
      : allCompanies;
  if (evalCompanies.length === 0) {
    throw new Error(`No companies available in snapshot for market '${effMarket}'.`);
  }

  const hasNdx = countNonNullPrices(snapshot.prices[NASDAQ_BENCHMARK_TICKER]) >= 60;
  const hasGspc = countNonNullPrices(snapshot.prices[SP500_BENCHMARK_TICKER]) >= 60;
  let bmTicker;
  let riskFreeRate;
  let benchmarkName;
  let currency;
  if (effMarket === "NASDAQ100" && (hasNdx || hasGspc)) {
    bmTicker = hasNdx ? NASDAQ_BENCHMARK_TICKER : SP500_BENCHMARK_TICKER;
    riskFreeRate = US_RISK_FREE_RATE;
    benchmarkName = bmTicker === NASDAQ_BENCHMARK_TICKER ? "Nasdaq 100 (^NDX)" : "S&P 500 (^GSPC)";
    currency = "USD";
  } else if ((effMarket === "US" || effMarket === "SP500") && (hasGspc || hasNdx)) {
    bmTicker = hasGspc ? SP500_BENCHMARK_TICKER : NASDAQ_BENCHMARK_TICKER;
    riskFreeRate = US_RISK_FREE_RATE;
    benchmarkName = bmTicker === SP500_BENCHMARK_TICKER ? "S&P 500 (^GSPC)" : "Nasdaq 100 (^NDX)";
    currency = "USD";
  } else {
    if (!snapshot.prices[BENCHMARK_TICKER]) {
      throw new Error("Insufficient Nifty 50 benchmark price history in snapshot for backtesting.");
    }
    bmTicker = BENCHMARK_TICKER;
    riskFreeRate = INDIA_RISK_FREE_RATE;
    benchmarkName = "Nifty 50 (^NSEI)";
    currency = "INR";
  }

  const preset = payload.preset || "qglp_compounder";
  const lookbackYears = Number(payload.lookback_years || 5);
  const topN = Number(payload.top_n || 8);
  const rebalance = payload.rebalance || "annual";
  const weighting = payload.weighting || "equal";
  const isUsMode = effMarket === "US" || effMarket === "NASDAQ100" || effMarket === "SP500";
  const initialCapital = Number(payload.initial_capital || (isUsMode ? 10000 : 500000));
  const costBps = Number(payload.cost_bps ?? 25);

  const s0Bm = Math.max(0, idx.firstValidIdx.get(bmTicker) ?? 0);
  const availSpan = allDates.length - s0Bm;
  const targetDays = lookbackYears * 252;
  const relStart =
    availSpan <= targetDays + 65
      ? Math.min(252, Math.max(65, Math.floor(availSpan / 5)))
      : availSpan - targetDays;
  const startIdx = Math.min(allDates.length - 60, s0Bm + relStart);

  const simDates = allDates.slice(startIdx);
  if (simDates.length < 60) {
    throw new Error("Backtest window requires at least 60 trading sessions.");
  }
  const stepMap = { quarterly: 63, semiannual: 126, annual: 252 };
  const step = stepMap[rebalance] || 252;

  const rebalIndices = [];
  for (let i = 0; i < simDates.length - 1; i += step) rebalIndices.push(i);

  const portDailyRets = new Float64Array(simDates.length);
  const bmFullRets = idx.dailyRets.get(bmTicker);
  const bmDailyRets = new Float64Array(simDates.length);
  for (let i = 1; i < simDates.length; i++) {
    bmDailyRets[i] = bmFullRets[startIdx + i] || 0.0;
  }

  let prevWeights = {};
  const rebalanceLog = [];
  let latestHoldings = [];

  for (let pos = 0; pos < rebalIndices.length; pos++) {
    const rebOffset = rebalIndices[pos];
    const nextOffset = pos + 1 < rebalIndices.length ? rebalIndices[pos + 1] : simDates.length - 1;
    const rebDate = simDates[rebOffset];

    const ranked = scoreUniversePointInTime(
      snapshot,
      rebDate,
      preset,
      payload.weights || null,
      false,
      evalCompanies
    );
    let investable = ranked.filter((r) => r.rating !== "Avoid");
    if (investable.length < topN) investable = ranked;
    const selected = investable.slice(0, topN);
    const newWeights = computeBacktestWeights(selected, weighting);

    const allKeys = new Set([...Object.keys(prevWeights), ...Object.keys(newWeights)]);
    let oneWayTurnover = 0.0;
    for (const k of allKeys) {
      oneWayTurnover += 0.5 * Math.abs((newWeights[k] || 0.0) - (prevWeights[k] || 0.0));
    }
    if (Object.keys(prevWeights).length === 0) oneWayTurnover = 1.0;
    const rebalCostDrag = oneWayTurnover * (costBps / 10000.0);

    const tickers = Object.keys(newWeights);
    if (nextOffset > rebOffset && tickers.length > 0) {
      let curW = tickers.map((t) => newWeights[t]);
      let periodPortCum = 1.0;
      let periodBmCum = 1.0;

      for (let offset = rebOffset + 1; offset <= nextOffset; offset++) {
        const globalDayIdx = startIdx + offset;
        let dayR = 0.0;
        const grown = new Array(tickers.length);
        let sGrown = 0.0;
        for (let tIdx = 0; tIdx < tickers.length; tIdx++) {
          const r = (idx.dailyRets.get(tickers[tIdx]) || [])[globalDayIdx] || 0.0;
          dayR += curW[tIdx] * r;
          grown[tIdx] = curW[tIdx] * (1.0 + r);
          sGrown += grown[tIdx];
        }
        if (offset === rebOffset + 1) dayR -= rebalCostDrag;
        portDailyRets[offset] = dayR;
        periodPortCum *= 1.0 + dayR;
        periodBmCum *= 1.0 + bmDailyRets[offset];
        if (sGrown > 0) {
          curW = grown.map((g) => g / sGrown);
        }
      }

      rebalanceLog.push({
        rebalance_date: rebDate,
        end_date: simDates[nextOffset],
        top_picks: selected.slice(0, 5).map((s) => s.ticker.replace(".NS", "")),
        holdings_count: selected.length,
        turnover_pct: roundTo(oneWayTurnover * 100.0, 1),
        period_return_pct: roundTo((periodPortCum - 1.0) * 100.0, 2),
        benchmark_return_pct: roundTo((periodBmCum - 1.0) * 100.0, 2),
        excess_return_pct: roundTo((periodPortCum - periodBmCum) * 100.0, 2),
      });
    }

    prevWeights = newWeights;
    if (pos === rebalIndices.length - 1) {
      latestHoldings = selected.map((s) => {
        const { marketCode, indexTag, marketLabel, currency: sCcy } = resolveMarketAndIndexTag(s);
        return {
          ticker: s.ticker,
          name: s.name,
          sector: s.sector,
          market: marketCode,
          index_tag: indexTag,
          market_label: marketLabel,
          currency: sCcy,
          price: s.price,
          weight_pct: roundTo((newWeights[s.ticker] || 0.0) * 100.0, 2),
          composite_score: s.composite_score,
          rating: s.rating,
        };
      });
    }
  }

  const portNav = new Float64Array(simDates.length);
  const bmNav = new Float64Array(simDates.length);
  const portDd = new Float64Array(simDates.length);
  const bmDd = new Float64Array(simDates.length);
  let pCum = initialCapital;
  let bCum = initialCapital;
  let pMax = initialCapital;
  let bMax = initialCapital;
  let maxDd = 0.0;
  let bmMaxDd = 0.0;

  for (let i = 0; i < simDates.length; i++) {
    pCum *= 1.0 + portDailyRets[i];
    bCum *= 1.0 + bmDailyRets[i];
    portNav[i] = pCum;
    bmNav[i] = bCum;
    if (pCum > pMax) pMax = pCum;
    if (bCum > bMax) bMax = bCum;
    portDd[i] = (pCum / pMax - 1.0) * 100.0;
    bmDd[i] = (bCum / bMax - 1.0) * 100.0;
    if (portDd[i] < maxDd) maxDd = portDd[i];
    if (bmDd[i] < bmMaxDd) bmMaxDd = bmDd[i];
  }

  const yearsElapsed = Math.max(0.25, simDates.length / 252.0);
  const portCagr = (Math.pow(portNav[simDates.length - 1] / initialCapital, 1.0 / yearsElapsed) - 1.0) * 100.0;
  const bmCagr = (Math.pow(bmNav[simDates.length - 1] / initialCapital, 1.0 / yearsElapsed) - 1.0) * 100.0;

  const rfDaily = riskFreeRate / 252.0;
  const pRets = Array.from(portDailyRets.slice(1));
  const bRets = Array.from(bmDailyRets.slice(1));
  const pStd = Math.max(1e-8, sampleStd(pRets));
  const bStd = Math.max(1e-8, sampleStd(bRets));
  const pMean = pRets.reduce((a, b) => a + b, 0) / Math.max(1, pRets.length);
  const bMean = bRets.reduce((a, b) => a + b, 0) / Math.max(1, bRets.length);

  const sharpe = ((pMean - rfDaily) / pStd) * Math.sqrt(252.0);
  const bmSharpe = ((bMean - rfDaily) / bStd) * Math.sqrt(252.0);

  const downside = pRets.filter((r) => r < rfDaily).map((r) => r - rfDaily);
  const downsideDev =
    downside.length > 0
      ? Math.sqrt(downside.reduce((acc, d) => acc + d * d, 0) / downside.length) * Math.sqrt(252.0)
      : 0.1;
  const sortino = (portCagr / 100.0 - riskFreeRate) / Math.max(0.01, downsideDev);
  const calmar = maxDd < -0.5 ? portCagr / Math.abs(maxDd) : 0.0;

  let covPB = 0.0;
  let varB = 0.0;
  const activeRets = [];
  for (let i = 0; i < pRets.length; i++) {
    covPB += (pRets[i] - pMean) * (bRets[i] - bMean);
    varB += (bRets[i] - bMean) * (bRets[i] - bMean);
    activeRets.push(pRets[i] - bRets[i]);
  }
  const beta = varB > 1e-9 ? covPB / varB : 1.0;
  const activeMean = activeRets.reduce((a, b) => a + b, 0) / Math.max(1, activeRets.length);
  const activeStd = Math.max(1e-8, sampleStd(activeRets));
  const infoRatio = (activeMean / activeStd) * Math.sqrt(252.0);

  const wins = rebalanceLog.filter((r) => r.excess_return_pct > 0).length;
  const winRate = (wins / Math.max(1, rebalanceLog.length)) * 100.0;

  const stride = Math.max(1, Math.floor(simDates.length / 180));
  const curve = [];
  for (let i = 0; i < simDates.length; i += stride) {
    curve.push({
      date: simDates[i],
      portfolio_nav: Math.round(portNav[i]),
      benchmark_nav: Math.round(bmNav[i]),
      portfolio_dd_pct: roundTo(portDd[i], 2),
      benchmark_dd_pct: roundTo(bmDd[i], 2),
    });
  }
  const lastI = simDates.length - 1;
  if (curve.length === 0 || curve[curve.length - 1].date !== simDates[lastI]) {
    curve.push({
      date: simDates[lastI],
      portfolio_nav: Math.round(portNav[lastI]),
      benchmark_nav: Math.round(bmNav[lastI]),
      portfolio_dd_pct: roundTo(portDd[lastI], 2),
      benchmark_dd_pct: roundTo(bmDd[lastI], 2),
    });
  }

  return {
    summary: {
      market: effMarket,
      benchmark_ticker: bmTicker,
      benchmark_name: benchmarkName,
      currency,
      start_date: simDates[0],
      end_date: simDates[lastI],
      years_tested: roundTo(yearsElapsed, 2),
      initial_capital_inr: Math.round(initialCapital),
      final_portfolio_inr: Math.round(portNav[lastI]),
      final_benchmark_inr: Math.round(bmNav[lastI]),
      portfolio_cagr_pct: roundTo(portCagr, 2),
      benchmark_cagr_pct: roundTo(bmCagr, 2),
      alpha_annual_pct: roundTo(portCagr - bmCagr, 2),
      sharpe_ratio: roundTo(sharpe, 2),
      benchmark_sharpe: roundTo(bmSharpe, 2),
      sortino_ratio: roundTo(sortino, 2),
      calmar_ratio: roundTo(calmar, 2),
      max_drawdown_pct: roundTo(maxDd, 2),
      benchmark_max_dd_pct: roundTo(bmMaxDd, 2),
      volatility_pct: roundTo(pStd * Math.sqrt(252.0) * 100.0, 2),
      benchmark_vol_pct: roundTo(bStd * Math.sqrt(252.0) * 100.0, 2),
      beta: roundTo(beta, 2),
      information_ratio: roundTo(infoRatio, 2),
      win_rate_pct: roundTo(winRate, 1),
      risk_free_rate_pct: roundTo(riskFreeRate * 100.0, 1),
      reporting_lag_days: 60,
    },
    equity_curve: curve,
    rebalance_log: [...rebalanceLog].reverse(),
    latest_holdings: latestHoldings,
  };
}

function classifyPortfolioRole(stock) {
  const p = stock.pillars;
  const m = stock.metrics;
  if (stock.is_financial) return "Core Financial Compounder";
  if (p.quality >= 78 && m.debt_to_equity <= 0.35) return "Fortress Moat Compounder";
  if (p.growth >= 72 && m.peg_ratio <= 1.8) return "GARP Growth Leader";
  if (p.value >= 72) return "High-Cash-Yield Value Anchor";
  return "Quality Sector Leader";
}

function buildWhyBuyMemo(stock) {
  const m = stock.metrics;
  const stab = Number(m.moat_stability_score ?? 70);
  let capStr;
  if (stock.is_financial) {
    const npaStr = m.gnpa_pct > 0 ? `, NNPA ${Number(m.nnpa_pct).toFixed(2)}%` : "";
    const floorV = Number(m.cycle_floor_roce_pct ?? m.med_5y_roce_pct);
    capStr = `5Y Med ROE ${Number(m.med_5y_roce_pct).toFixed(1)}% (Floor ${floorV.toFixed(1)}%${npaStr})`;
  } else {
    capStr = `5Y Med ROCE ${Number(m.med_5y_roce_pct).toFixed(1)}% (8Y Stab ${stab}/100, D/E ${Number(m.debt_to_equity).toFixed(2)}x)`;
  }
  const qtrStr = m.latest_qtr_label
    ? `2Q PAT ${m.qtr_pat_yoy_pct >= 0 ? "+" : ""}${Number(m.qtr_pat_yoy_pct).toFixed(1)}% YoY`
    : `5Y PAT CAGR ${Number(m.pat_cagr_5y_pct).toFixed(1)}%`;
  const instChg = Number(m.inst_chg_1y_pct || 0);
  const ownStr =
    instChg !== 0 ? `4Q Inst ${instChg >= 0 ? "+" : ""}${instChg.toFixed(1)}%` : `Piotroski ${m.piotroski_f_score}/9`;
  return `${capStr} • ${qtrStr} • P/E ${Number(m.pe_ratio).toFixed(1)}x (Fair ~${Number(m.fair_pe).toFixed(1)}x, PEG ${Number(m.peg_ratio).toFixed(2)}x) • ${ownStr}`;
}

function createSeededNormal(seed) {
  let state = seed >>> 0;
  function nextUniform() {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296.0;
  }
  return function nextNormal(mu, sigma) {
    const u1 = Math.max(1e-12, nextUniform());
    const u2 = nextUniform();
    const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mu + sigma * z;
  };
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const pos = (p / 100.0) * (sortedArr.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sortedArr.length) {
    return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
  }
  return sortedArr[base];
}

export async function runPlannerSnapshot(payload) {
  const snapshot = await getSnapshot();
  const dates = snapshot.price_dates || [];
  const asOf = dates[dates.length - 1] || snapshot.as_of_date;
  const preset = PRESET_WEIGHTS[payload.preset] ? payload.preset : "qglp_compounder";
  const rankedStocks = scoreUniversePointInTime(snapshot, asOf, preset, null, true);

  const effMarket = ALLOWED_MARKETS.has(payload.market) ? payload.market : "ALL";
  const isUsPlan = effMarket === "US" || effMarket === "NASDAQ100" || effMarket === "SP500";
  const planCurrency = isUsPlan ? "USD" : "INR";
  const fxRate = resolveUsdInrRate(snapshot, payload && payload.usd_inr_rate);
  const poolStocks =
    effMarket !== "ALL"
      ? rankedStocks.filter((s) => {
          const { marketCode, indexTag } = resolveMarketAndIndexTag(s);
          return matchesMarketFilter(marketCode, indexTag, effMarket);
        })
      : rankedStocks;

  function pxInPlanCcy(stock) {
    const { currency: sCcy } = resolveMarketAndIndexTag(stock);
    const nativePx = Math.max(0.01, Number(stock.price));
    if (planCurrency === "USD") {
      return sCcy === "USD" ? nativePx : nativePx / fxRate;
    }
    return sCcy === "USD" ? nativePx * fxRate : nativePx;
  }

  const lumpSumInr = Number(payload.lump_sum_inr || 0);
  const monthlySipInr = Number(payload.monthly_sip_inr || 0);
  const horizonYears = Number(payload.horizon_years || 7);
  const targetCorpusInr = Number(payload.target_corpus_inr || (isUsPlan ? 25000 : 1300000));
  const riskProfile = payload.risk_profile || "equity_direct";
  const maxStocks = Number(payload.max_stocks || 8);

  const prof = resolveRiskProfile(riskProfile, effMarket);
  const equityShare =
    prof.allocation
      .filter((a) => ["Compounders", "Leaders", "Equity"].some((k) => a.asset.includes(k)))
      .reduce((acc, a) => acc + a.pct, 0) / 100.0;

  const equityLumpInr = lumpSumInr * equityShare;
  const equitySipInr = monthlySipInr * equityShare;

  const tier1 = poolStocks.filter(
    (s) =>
      (s.rating === "Strong Buy" || s.rating === "Buy") &&
      s.pillars.quality >= 58.0 &&
      (s.metrics.moat_stability_score ?? 70) >= 52 &&
      !s.is_cyclical
  );
  const tier2 = poolStocks.filter(
    (s) => (s.rating === "Strong Buy" || s.rating === "Buy") && !tier1.includes(s)
  );
  const tier3 = poolStocks.filter(
    (s) => s.rating !== "Avoid" && !tier1.includes(s) && !tier2.includes(s)
  );

  const selected = [];
  const sectorCounts = {};
  let cyclicalCount = 0;
  const maxPerSector = maxStocks <= 10 ? 2 : 3;

  const passes = [
    [tier1, maxPerSector, 0],
    [tier2, maxPerSector, 1],
    [[...tier1, ...tier2, ...tier3], maxPerSector + 1, 2],
  ];

  for (const [pool, secCap, cycCap] of passes) {
    if (selected.length >= maxStocks) break;
    for (const stock of pool) {
      if (selected.includes(stock)) continue;
      if (equityLumpInr > 0 && pxInPlanCcy(stock) > equityLumpInr * 0.22) continue;
      if (stock.is_cyclical && cyclicalCount >= cycCap) continue;
      const sec = stock.sector;
      if ((sectorCounts[sec] || 0) >= secCap) continue;
      selected.push(stock);
      sectorCounts[sec] = (sectorCounts[sec] || 0) + 1;
      if (stock.is_cyclical) cyclicalCount += 1;
      if (selected.length >= maxStocks) break;
    }
  }

  let weights = [];
  if (selected.length > 0) {
    const rawW = selected.map((s) => Math.max(12.0, Number(s.composite_score) - 42.0));
    const sumRaw = rawW.reduce((a, b) => a + b, 0);
    weights = rawW.map((w) => w / sumRaw);
    const cap = Math.max(0.16, 1.0 / selected.length + 0.025);
    for (let iter = 0; iter < 5; iter++) {
      let excessSum = 0.0;
      for (const w of weights) {
        if (w > cap) excessSum += w - cap;
      }
      if (excessSum <= 1e-6) break;
      weights = weights.map((w) => Math.min(w, cap));
      const uncappedSum = weights.filter((w) => w < cap).reduce((a, b) => a + b, 0);
      if (uncappedSum > 0) {
        weights = weights.map((w) => (w < cap ? w + excessSum * (w / uncappedSum) : w));
      }
    }
    const wTot = weights.reduce((a, b) => a + b, 0);
    weights = weights.map((w) => w / wTot);
  }

  const stockBasket = [];
  const sectorExposure = {};
  let deployedEquityInr = 0.0;
  let immediateTrancheInr = 0.0;

  selected.forEach((s, idx) => {
    const w = weights[idx];
    const targetAlloc = equityLumpInr * w;
    const allocSip = equitySipInr * w;
    const {
      marketCode: sMkt,
      indexTag: sIdxTag,
      marketLabel: sLabel,
      currency: sCcy,
    } = resolveMarketAndIndexTag(s);
    const pxPlan = Math.max(0.01, pxInPlanCcy(s));
    const remainingBudget = Math.max(0.0, equityLumpInr - deployedEquityInr);
    let sharesQty = Math.floor(Math.min(targetAlloc * 1.03, remainingBudget) / pxPlan);
    if (sharesQty * pxPlan > remainingBudget && sharesQty > 0) {
      sharesQty = Math.floor(remainingBudget / pxPlan);
    }
    const actualInr = Math.round(sharesQty * pxPlan);
    deployedEquityInr += actualInr;

    const m = s.metrics;
    let entryPlan;
    if (m.pe_ratio <= m.fair_pe * 1.08) {
      entryPlan = `Buy 100% Now (${sharesQty} sh)`;
      immediateTrancheInr += actualInr;
    } else {
      const nowSh = Math.max(1, Math.ceil(sharesQty * 0.6));
      const laterSh = Math.max(0, sharesQty - nowSh);
      entryPlan =
        laterSh > 0 ? `Stagger: ${nowSh} sh Now + ${laterSh} sh on 6-8% dip` : `Buy ${sharesQty} sh Now`;
      immediateTrancheInr += Math.round(nowSh * pxPlan);
    }

    sectorExposure[s.sector] = roundTo((sectorExposure[s.sector] || 0.0) + w * 100.0, 1);
    stockBasket.push({
      ticker: s.ticker,
      name: s.name,
      sector: s.sector,
      market: sMkt,
      index_tag: sIdxTag,
      market_label: sLabel,
      currency: sCcy,
      role: classifyPortfolioRole(s),
      rating: s.rating,
      composite_score: s.composite_score,
      price: s.price,
      price_plan_ccy: roundTo(pxPlan, 2),
      fair_pe: m.fair_pe,
      pe_ratio: m.pe_ratio,
      equity_weight_pct: roundTo(w * 100.0, 1),
      total_portfolio_weight_pct: roundTo(w * equityShare * 100.0, 1),
      lump_sum_inr: equityLumpInr > 0 ? actualInr : Math.round(targetAlloc),
      est_shares: sharesQty,
      monthly_sip_inr: Math.round(allocSip),
      entry_guidance: entryPlan,
      why_buy: buildWhyBuyMemo(s),
      strength_highlight: s.strengths && s.strengths.length > 0 ? s.strengths[0] : "",
    });
  });

  const unallocatedCashInr = Math.max(0, Math.round(equityLumpInr - deployedEquityInr));

  const nSims = 1000;
  const months = horizonYears * 12;
  const muM = (prof.blended_mu - 0.5 * prof.blended_sigma * prof.blended_sigma) / 12.0;
  const sigM = prof.blended_sigma / Math.sqrt(12.0);
  const randNorm = createSeededNormal(202611);

  const wealthPaths = new Float64Array(nSims);
  wealthPaths.fill(lumpSumInr);

  const projections = [
    {
      year: 0,
      invested_inr: Math.round(lumpSumInr),
      bear_10_inr: Math.round(lumpSumInr),
      base_50_inr: Math.round(lumpSumInr),
      bull_90_inr: Math.round(lumpSumInr),
    },
  ];

  for (let mIdx = 0; mIdx < months; mIdx++) {
    for (let s = 0; s < nSims; s++) {
      const gf = Math.exp(randNorm(muM, sigM));
      wealthPaths[s] = wealthPaths[s] * gf + monthlySipInr;
    }
    if ((mIdx + 1) % 12 === 0) {
      const yr = (mIdx + 1) / 12;
      const invested = lumpSumInr + monthlySipInr * (mIdx + 1);
      const sorted = Array.from(wealthPaths).sort((a, b) => a - b);
      projections.push({
        year: yr,
        invested_inr: Math.round(invested),
        bear_10_inr: Math.round(percentile(sorted, 10)),
        base_50_inr: Math.round(percentile(sorted, 50)),
        bull_90_inr: Math.round(percentile(sorted, 90)),
      });
    }
  }

  const finalSorted = Array.from(wealthPaths).sort((a, b) => a - b);
  const hits = finalSorted.filter((v) => v >= targetCorpusInr).length;
  const goalProbPct = (hits / nSims) * 100.0;
  const medianFinal = percentile(finalSorted, 50);
  const totalInvested = lumpSumInr + monthlySipInr * months;

  const rM = prof.blended_mu / 12.0;
  const fvFactor = rM > 0 ? (Math.pow(1.0 + rM, months) - 1.0) / rM : months;
  const shortfallInr = Math.max(0.0, targetCorpusInr - medianFinal);
  const recommendedExtraSip = shortfallInr > 0 ? Math.round(shortfallInr / Math.max(1.0, fvFactor)) : 0;

  return {
    market: effMarket,
    plan_currency: planCurrency,
    fx_usd_inr: fxRate,
    profile_label: prof.label,
    expected_cagr_pct: roundTo(prof.blended_mu * 100.0, 2),
    expected_volatility_pct: roundTo(prof.blended_sigma * 100.0, 2),
    deployment_summary: {
      total_lump_sum_inr: Math.round(lumpSumInr),
      equity_budget_inr: Math.round(equityLumpInr),
      deployed_in_shares_inr: Math.round(deployedEquityInr),
      immediate_tranche_inr: Math.round(immediateTrancheInr),
      staggered_dip_reserve_inr: Math.max(0, Math.round(deployedEquityInr - immediateTrancheInr)),
      residual_cash_inr: unallocatedCashInr,
      sectors_covered: Object.keys(sectorExposure).length,
    },
    monitoring_rules: [
      "Weekly Check (4s Price Refresh): Only deploy staggered dip tranches if a shortlisted stock pulls back 6–8%; ignore normal weekly price noise.",
      "Quarterly / Annual Fundamental Review: Continue holding as long as Composite Score stays >= 50 and 5Y Median ROCE/ROE remains above 14–15%.",
      "Sell / Replace Trigger: Exit only if a forensic red flag appears (PAT turns negative, corporate D/E > 1.8x, or Score drops below 45) or valuation stretches past 2.5x Fair P/E.",
    ],
    asset_allocation: prof.allocation.map((item) => ({
      ...item,
      lump_sum_inr: Math.round(lumpSumInr * (item.pct / 100.0)),
      monthly_sip_inr: Math.round(monthlySipInr * (item.pct / 100.0)),
    })),
    sector_exposure_pct: sectorExposure,
    stock_basket: stockBasket,
    yearly_projections: projections,
    goal_summary: {
      target_corpus_inr: Math.round(targetCorpusInr),
      total_invested_inr: Math.round(totalInvested),
      median_corpus_inr: Math.round(medianFinal),
      bear_10_corpus_inr: projections[projections.length - 1].bear_10_inr,
      bull_90_corpus_inr: projections[projections.length - 1].bull_90_inr,
      goal_probability_pct: roundTo(goalProbPct, 1),
      recommended_extra_sip_inr: recommendedExtraSip,
    },
  };
}

export async function importCsvInMemory(csvText) {
  const snapshot = await getSnapshot();
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error("CSV must include a header row and at least one data row.");
  }

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const required = [
    "ticker",
    "name",
    "sector",
    "fiscal_year",
    "revenue_cr",
    "ebitda_cr",
    "net_profit_cr",
    "roce_pct",
    "roe_pct",
    "debt_to_equity",
  ];
  for (const req of required) {
    if (!headers.includes(req)) {
      throw new Error(`Missing required CSV column: ${req}`);
    }
  }

  const colIdx = {};
  headers.forEach((h, i) => {
    colIdx[h] = i;
  });

  const importedTickers = new Set();
  let rowsImported = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map((p) => p.trim());
    if (parts.length < headers.length) continue;
    let tk = parts[colIdx.ticker].toUpperCase();
    if (!tk.endsWith(".NS") && !tk.endsWith(".BO")) tk = `${tk}.NS`;

    const name = parts[colIdx.name];
    const sector = parts[colIdx.sector] || "Diversified";
    const fy = Number(parts[colIdx.fiscal_year]);
    const rev = Number(parts[colIdx.revenue_cr]);
    const ebitda = Number(parts[colIdx.ebitda_cr]);
    const pat = Number(parts[colIdx.net_profit_cr]);
    const roce = Number(parts[colIdx.roce_pct]);
    const roe = Number(parts[colIdx.roe_pct]);
    const de = Number(parts[colIdx.debt_to_equity]);
    if (!Number.isFinite(fy) || !Number.isFinite(rev)) continue;

    if (!snapshot.companies.some((c) => c.ticker === tk)) {
      snapshot.companies.push({
        ticker: tk,
        name,
        sector,
        market: "IN",
        index_tag: "NIFTY200",
        currency: "INR",
        cap_tier: "Custom CSV",
        is_financial: sector.toLowerCase().includes("bank") || sector.toLowerCase().includes("fin"),
        promoter_pct: 55.0,
        inst_pct: 25.0,
        data_source: "custom_csv_session",
      });
    }

    const eqCr = roe > 0 && pat > 0 ? (pat / (roe / 100.0)) : Math.max(100.0, rev * 0.5);
    const debtCr = eqCr * Math.max(0.0, de);
    const rowObj = {
      ticker: tk,
      fiscal_year: fy,
      reported_date: `${fy}-05-30`,
      revenue_cr: rev,
      ebitda_cr: ebitda,
      ebit_cr: ebitda * 0.85,
      net_profit_cr: pat,
      cfo_cr: ebitda * 0.82,
      fcf_cr: ebitda * 0.52,
      total_debt_cr: debtCr,
      total_equity_cr: eqCr,
      total_assets_cr: eqCr + debtCr + rev * 0.25,
      current_assets_cr: rev * 0.35,
      current_liabilities_cr: rev * 0.22,
      shares_cr: colIdx.shares_cr !== undefined ? Number(parts[colIdx.shares_cr] || 10) : 10.0,
      roce_pct: roce,
      roe_pct: roe,
      op_margin_pct: rev > 0 ? (ebitda / rev) * 100.0 : 12.0,
      debt_to_equity: de,
      cfo_to_ebitda_pct: 82.0,
    };

    snapshot.fundamentals = snapshot.fundamentals.filter(
      (f) => !(f.ticker === tk && Number(f.fiscal_year) === fy)
    );
    snapshot.fundamentals.push(rowObj);

    if (!snapshot.prices[tk]) {
      const bm = snapshot.prices[BENCHMARK_TICKER] || [];
      const basePx = colIdx.price !== undefined ? Number(parts[colIdx.price] || 500) : 500.0;
      const bmLast = bm.length > 0 ? Number(bm[bm.length - 1] || 24000) : 24000;
      snapshot.prices[tk] = bm.map((v) => (v ? roundTo((v / bmLast) * basePx, 2) : basePx));
    }

    importedTickers.add(tk);
    rowsImported += 1;
  }

  indexSnapshot(snapshot);
  return {
    companies_imported: importedTickers.size,
    rows_imported: rowsImported,
  };
}
