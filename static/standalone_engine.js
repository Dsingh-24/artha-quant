// ArthaQuant Client-Side Institutional Engine (Netlify Cloud Snapshot Mode)
// Mirrors `app/factors.py`, `app/backtester.py`, and `app/planner.py` (V1.2)
// Security guarantees:
// - Zero innerHTML / outerHTML / insertAdjacentHTML / document.write
// - Zero localStorage / sessionStorage
// - Zero native alert() / confirm() / prompt()

const BENCHMARK_TICKER = "^NSEI";
const INDIA_RISK_FREE_RATE = 0.068;

export const PRESET_WEIGHTS = {
  qglp_compounder: { quality: 45.0, value: 20.0, growth: 25.0, momentum: 10.0 },
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
  includeQuarterlySignals = true
) {
  const weights = resolveWeights(preset, customWeights);
  const idx = snapshot._indexed;
  const dates = snapshot.price_dates || [];
  const endIdx = idx.dateToIdx.has(asOfDate)
    ? idx.dateToIdx.get(asOfDate)
    : findDateIndexOnOrBefore(dates, asOfDate);

  if (endIdx < 0) return [];

  const qtrMap = includeQuarterlySignals ? snapshot.quarterly_signals || {} : {};
  const results = [];

  for (const comp of snapshot.companies || []) {
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
    const promoterPct = Number(comp.promoter_pct || 0.0);
    const instPct = Number(comp.inst_pct || 0.0);

    const qsig = qtrMap[tk];
    const useLiveQtr = Boolean(qsig && String(qsig.signals_reported_date || "9999-12-31") <= asOfDate);

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

    let qReturn;
    let qLev;
    let qCash;
    let qMargin;
    if (isFin) {
      qReturn = 0.6 * linearScore(sustainedRoe, 8.0, 19.0) + 0.4 * linearScore(roaPct, 0.5, 2.2);
      qLev = linearScore(deCur, 11.0, 2.0);
      qCash = profitConsistencyPct;
      if (gnpaPct > 0) {
        const qAssetQual = 0.55 * linearScore(nnpaPct, 1.8, 0.25) + 0.45 * linearScore(gnpaPct, 5.0, 1.3);
        qMargin = 0.5 * linearScore(opmCur, 8.0, 28.0) + 0.5 * qAssetQual;
      } else {
        qMargin = linearScore(opmCur, 8.0, 28.0);
      }
    } else {
      qReturn = 0.55 * linearScore(sustainedRoce, 8.0, 30.0) + 0.45 * linearScore(sustainedRoe, 8.0, 26.0);
      qLev = linearScore(deCur, 1.8, 0.05);
      qCash = 0.65 * linearScore(cumCfoEbitda5y, 50.0, 95.0) + 0.35 * profitConsistencyPct;
      qMargin = linearScore(opmCur, 8.0, 26.0);
    }

    const qualityScore = clamp(
      0.34 * qReturn + 0.22 * moatStability + 0.16 * qLev + 0.18 * qCash + 0.1 * qMargin
    );

    const effectiveGrowthAnchor = clamp(
      0.7 * normalizedPatCagr + 0.3 * (hasQtrData ? qtrPatYoy : patCagr3y),
      5.0,
      !isCyclicalProfile ? 28.0 : 16.0
    );
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

    const valueScore = isFin
      ? clamp(0.35 * vPb + 0.35 * vPeRel + 0.3 * vPeg)
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
    if (hasQtrData) {
      const qGRev = linearScore(qtrRevYoy, -4.0, 20.0);
      const qGPat = linearScore(qtrPatYoy, -6.0, 24.0);
      const qGOpm = linearScore(qtrOpmDelta, -2.5, 2.5);
      const qtrGrowthScore = clamp(0.4 * qGRev + 0.45 * qGPat + 0.15 * qGOpm);
      growthScore = clamp(0.68 * annualGrowthScore + 0.32 * qtrGrowthScore);
    } else {
      growthScore = annualGrowthScore;
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

    let momentumScore;
    if (preset === "qglp_compounder" || preset === "coffee_can") {
      const mTrend = above200dma ? 75.0 : 35.0;
      const mSteady = linearScore(mom12_1Pct, -18.0, 28.0);
      momentumScore = clamp(0.45 * mPiotroski + 0.3 * ownershipScore + 0.15 * mSteady + 0.1 * mTrend);
    } else {
      const m121 = linearScore(mom12_1Pct, -12.0, 38.0);
      const mRiskAdj = linearScore(riskAdjMom, -0.4, 1.5);
      momentumScore = clamp(0.35 * m121 + 0.25 * mRiskAdj + 0.25 * mPiotroski + 0.15 * ownershipScore);
    }

    const redFlags = [];
    const strengths = [];
    let penalty = 0.0;
    let valuationCapped = false;

    if (patCr <= 0 || patFyCr <= 0) {
      redFlags.push("Loss-making in latest fiscal year or TTM (PAT <= 0)");
      penalty += 20.0;
    }
    if (profitableYrs < Math.max(1, window5y.length - 1)) {
      redFlags.push(`Inconsistent profitability (${profitableYrs}/${window5y.length} profitable years)`);
      penalty += 10.0;
    }
    if (equityCr <= 0) {
      redFlags.push("Negative net worth / eroded book equity");
      penalty += 15.0;
    }
    if (!isFin && deCur > 1.8) {
      redFlags.push(`High corporate debt load (D/E ${deCur.toFixed(2)}x)`);
      penalty += 12.0;
    }
    if (!isFin && cumCfoEbitda5y < 55.0) {
      redFlags.push(`Weak 5Y cumulative cash conversion (${Math.round(cumCfoEbitda5y)}% CFO/EBITDA)`);
      penalty += 10.0;
    }
    if (patCagr3y < -10.0 && patCagr5y < -5.0) {
      redFlags.push(`Structural multi-year profit contraction (${patCagr3y.toFixed(1)}% 3Y PAT CAGR)`);
      penalty += 10.0;
    }
    if (hasQtrData && (qtrPatYoy <= -15.0 || (qtrRevYoy <= -6.0 && qtrPatYoy < 0.0))) {
      const sPat = `${qtrPatYoy >= 0 ? "+" : ""}${qtrPatYoy.toFixed(1)}%`;
      const sRev = `${qtrRevYoy >= 0 ? "+" : ""}${qtrRevYoy.toFixed(1)}%`;
      redFlags.push(`Recent 2Q earnings slowdown (${sPat} YoY PAT, ${sRev} YoY Sales in ${latestQtrLabel})`);
      penalty += 9.0;
    }
    if (
      hasShTrend &&
      ((smartMoneyChg <= -4.5 && promoterPct + instPct < 72.0) ||
        (promoterChg1y <= -3.5 && instChg1y < 0.5))
    ) {
      const sPr = `${promoterChg1y >= 0 ? "+" : ""}${promoterChg1y.toFixed(1)}%`;
      const sIn = `${instChg1y >= 0 ? "+" : ""}${instChg1y.toFixed(1)}%`;
      redFlags.push(`4Q Promoter/Institutional exit (${sPr} Promoter, ${sIn} FII+DII)`);
      penalty += 7.0;
    }
    if (isFin && gnpaPct > 0 && (nnpaPct > 1.5 || gnpaPct > 4.5)) {
      redFlags.push(`Elevated banking NPAs (Gross NPA ${gnpaPct.toFixed(2)}%, Net NPA ${nnpaPct.toFixed(2)}%)`);
      penalty += 10.0;
    }
    if (isCommodityBiz && moatStability < 55.0) {
      const maxCyc = Math.max(...cycleRets);
      redFlags.push(
        `Commodity cyclicality risk (8Y ROCE swung ${Math.round(cycleFloorRet)}%–${Math.round(maxCyc)}%)`
      );
      penalty += 5.0;
    }
    if (fScore <= 3) {
      redFlags.push(`Weak Piotroski financial health (${fScore}/9)`);
      penalty += 10.0;
    }
    if ((peRatio > 56.0 && pegRatio > 2.1) || (isCyclicalProfile && peRatio > fairPe * 1.75)) {
      redFlags.push(
        `Valuation rich at ${peRatio.toFixed(1)}x P/E (Fair ~${fairPe}x, PEG ${pegRatio.toFixed(1)}x) — wait for pullback`
      );
      penalty += 8.0;
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
    if (!isFin && cumCfoEbitda5y >= 82.0) {
      strengths.push(`Clean 5Y cash-flow conversion (${Math.round(cumCfoEbitda5y)}% cumulative CFO/EBITDA)`);
    }
    if (!isFin && deCur <= 0.25 && equityCr > 0) {
      strengths.push(`Fortress balance sheet with minimal debt (D/E ${deCur.toFixed(2)}x)`);
    }
    if (patCr > 0 && peRatio <= fairPe * 1.1) {
      strengths.push(
        `Reasonable GARP entry price (${peRatio.toFixed(1)}x P/E vs Fair ~${fairPe}x, PEG ${pegRatio.toFixed(2)}x)`
      );
    }
    if (hasShTrend && instChg1y >= 1.0 && promoterChg1y >= -0.4) {
      strengths.push(
        `Institutional accumulation (+${instChg1y.toFixed(1)}% FII+DII stake added over 4Q; Total Prom+Inst ${(promoterPct + instPct).toFixed(1)}%)`
      );
    } else if (promoterPct + instPct >= 65.0) {
      strengths.push(
        `High institutional & promoter skin-in-the-game (${promoterPct.toFixed(1)}% Promoter + ${instPct.toFixed(1)}% FII/DII)`
      );
    }
    if (strengths.length === 0) {
      strengths.push("Established NSE Nifty-200 operating franchise");
    }

    const rawComposite =
      weights.quality * qualityScore +
      weights.value * valueScore +
      weights.growth * growthScore +
      weights.momentum * momentumScore;
    const compositeScore = roundTo(clamp(rawComposite - penalty), 1);

    let rating;
    let conviction;
    if (valuationCapped && compositeScore >= 45.0 && patCr > 0) {
      rating = "Hold";
      conviction = "Great Business, Rich Price — Buy on Dip";
    } else if (compositeScore >= 68.0 && redFlags.length === 0) {
      rating = "Strong Buy";
      conviction = "Core Long-Term Compounder";
    } else if (compositeScore >= 57.0 && patCr > 0 && profitableYrs >= window5y.length - 1) {
      rating = "Buy";
      conviction = "Accumulate for 3-5Y+";
    } else if (compositeScore >= 45.0 && patCr > 0) {
      rating = "Hold";
      conviction = "Watchlist / Hold Existing";
    } else {
      rating = "Avoid";
      conviction = "Fundamental / Balance-Sheet Caution";
    }

    const s1 = idx.stage1Lookup.get(tk) || {};
    results.push({
      ticker: tk,
      name: comp.name,
      sector: comp.sector,
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
      pillars: {
        quality: roundTo(qualityScore, 1),
        value: roundTo(valueScore, 1),
        growth: roundTo(growthScore, 1),
        momentum: roundTo(momentumScore, 1),
      },
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
      strengths: strengths.slice(0, 4),
      red_flags: redFlags.slice(0, 4),
      piotroski_checks: fChecks,
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

  const scored = scoreUniversePointInTime(snapshot, asOf, preset, payload.weights || null, true);
  const sectors = [...new Set((snapshot.companies || []).map((c) => c.sector))].sort();
  const filtered = scored.filter(
    (s) => (sector === "ALL" || s.sector === sector) && s.composite_score >= minScore
  );
  const stage1Rows = snapshot.stage1_funnel || [];
  const filteredStage1 = stage1Rows.filter((r) => sector === "ALL" || r.sector === sector);

  const ratingCounts = { "Strong Buy": 0, Buy: 0, Hold: 0, Avoid: 0 };
  for (const s of scored) {
    ratingCounts[s.rating] = (ratingCounts[s.rating] || 0) + 1;
  }

  const bmPrices = snapshot.prices[BENCHMARK_TICKER] || [];
  const bmLatest = bmPrices.length > 0 ? Number(bmPrices[bmPrices.length - 1] || 0) : 0;
  const unscoredRemaining = stage1Rows.filter((r) => !r.deep_scored).length;

  return {
    as_of_date: asOf,
    benchmark_nifty50: roundTo(bmLatest, 2),
    preset_weights: PRESET_WEIGHTS,
    sectors,
    rating_counts: ratingCounts,
    total_stage1_scanned: stage1Rows.length || snapshot.companies.length,
    total_deep_scored: scored.length,
    unscored_funnel_remaining: unscoredRemaining,
    total_universe: scored.length,
    stocks: filtered,
    stage1_funnel: filteredStage1,
  };
}

export async function getCompanyDetailSnapshot(ticker, preset = "qglp_compounder") {
  const snapshot = await getSnapshot();
  const tk = String(ticker || "").toUpperCase();
  const comp = (snapshot.companies || []).find((c) => c.ticker === tk);
  if (!comp) {
    throw new Error(`Company ${tk} not found in snapshot.`);
  }
  const dates = snapshot.price_dates || [];
  const asOf = dates[dates.length - 1] || snapshot.as_of_date;
  const effPreset = PRESET_WEIGHTS[preset] ? preset : "qglp_compounder";
  const scored = scoreUniversePointInTime(snapshot, asOf, effPreset, null, true);
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
    company: comp,
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
  if (allDates.length < 130 || !snapshot.prices[BENCHMARK_TICKER]) {
    throw new Error("Insufficient price history in snapshot for backtesting.");
  }

  const preset = payload.preset || "qglp_compounder";
  const lookbackYears = Number(payload.lookback_years || 5);
  const topN = Number(payload.top_n || 8);
  const rebalance = payload.rebalance || "annual";
  const weighting = payload.weighting || "equal";
  const initialCapital = Number(payload.initial_capital || 500000);
  const costBps = Number(payload.cost_bps ?? 25);

  const targetDays = lookbackYears * 252;
  const startIdx =
    allDates.length <= targetDays + 65
      ? Math.min(252, Math.max(65, Math.floor(allDates.length / 5)))
      : allDates.length - targetDays;

  const simDates = allDates.slice(startIdx);
  const stepMap = { quarterly: 63, semiannual: 126, annual: 252 };
  const step = stepMap[rebalance] || 252;

  const rebalIndices = [];
  for (let i = 0; i < simDates.length - 1; i += step) rebalIndices.push(i);

  const portDailyRets = new Float64Array(simDates.length);
  const bmFullRets = idx.dailyRets.get(BENCHMARK_TICKER);
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
      false
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
      latestHoldings = selected.map((s) => ({
        ticker: s.ticker,
        name: s.name,
        sector: s.sector,
        weight_pct: roundTo((newWeights[s.ticker] || 0.0) * 100.0, 2),
        composite_score: s.composite_score,
        rating: s.rating,
      }));
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

  const rfDaily = INDIA_RISK_FREE_RATE / 252.0;
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
  const sortino = (portCagr / 100.0 - INDIA_RISK_FREE_RATE) / Math.max(0.01, downsideDev);
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
      risk_free_rate_pct: roundTo(INDIA_RISK_FREE_RATE * 100.0, 1),
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
    const npaStr = m.gnpa_pct > 0 ? `, NNPA ${m.nnpa_pct}%` : "";
    capStr = `5Y Med ROE ${m.med_5y_roce_pct}% (Floor ${m.cycle_floor_roce_pct ?? m.med_5y_roce_pct}%${npaStr})`;
  } else {
    capStr = `5Y Med ROCE ${m.med_5y_roce_pct}% (8Y Stab ${stab}/100, D/E ${m.debt_to_equity}x)`;
  }
  const qtrStr = m.latest_qtr_label
    ? `2Q PAT ${m.qtr_pat_yoy_pct >= 0 ? "+" : ""}${m.qtr_pat_yoy_pct.toFixed(1)}% YoY`
    : `5Y PAT CAGR ${m.pat_cagr_5y_pct}%`;
  const instChg = Number(m.inst_chg_1y_pct || 0);
  const ownStr =
    instChg !== 0 ? `4Q Inst ${instChg >= 0 ? "+" : ""}${instChg.toFixed(1)}%` : `Piotroski ${m.piotroski_f_score}/9`;
  return `${capStr} • ${qtrStr} • P/E ${m.pe_ratio}x (Fair ~${m.fair_pe}x, PEG ${m.peg_ratio}x) • ${ownStr}`;
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

  const lumpSumInr = Number(payload.lump_sum_inr || 0);
  const monthlySipInr = Number(payload.monthly_sip_inr || 0);
  const horizonYears = Number(payload.horizon_years || 7);
  const targetCorpusInr = Number(payload.target_corpus_inr || 1300000);
  const riskProfile = payload.risk_profile || "equity_direct";
  const maxStocks = Number(payload.max_stocks || 8);

  const prof = RISK_PROFILES[riskProfile] || RISK_PROFILES.equity_direct;
  const equityShare =
    prof.allocation
      .filter((a) => ["Compounders", "Leaders", "Equity"].some((k) => a.asset.includes(k)))
      .reduce((acc, a) => acc + a.pct, 0) / 100.0;

  const equityLumpInr = lumpSumInr * equityShare;
  const equitySipInr = monthlySipInr * equityShare;

  const tier1 = rankedStocks.filter(
    (s) =>
      (s.rating === "Strong Buy" || s.rating === "Buy") &&
      s.pillars.quality >= 58.0 &&
      (s.metrics.moat_stability_score ?? 70) >= 52 &&
      !s.is_cyclical
  );
  const tier2 = rankedStocks.filter(
    (s) => (s.rating === "Strong Buy" || s.rating === "Buy") && !tier1.includes(s)
  );
  const tier3 = rankedStocks.filter(
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
      if (equityLumpInr > 0 && Number(stock.price) > equityLumpInr * 0.22) continue;
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
    const px = Math.max(1.0, Number(s.price));
    const remainingBudget = Math.max(0.0, equityLumpInr - deployedEquityInr);
    let sharesQty = Math.floor(Math.min(targetAlloc * 1.03, remainingBudget) / px);
    if (sharesQty * px > remainingBudget && sharesQty > 0) {
      sharesQty = Math.floor(remainingBudget / px);
    }
    const actualInr = Math.round(sharesQty * px);
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
      immediateTrancheInr += Math.round(nowSh * px);
    }

    sectorExposure[s.sector] = roundTo((sectorExposure[s.sector] || 0.0) + w * 100.0, 1);
    stockBasket.push({
      ticker: s.ticker,
      name: s.name,
      sector: s.sector,
      role: classifyPortfolioRole(s),
      rating: s.rating,
      composite_score: s.composite_score,
      price: s.price,
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
