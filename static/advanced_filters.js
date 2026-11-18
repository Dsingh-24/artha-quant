// ArthaQuant V5.0 — Pure 4-Group Advanced Filters & Multi-Factor Sort Engine
// Zero DOM dependencies — importable in both browser (`app.js`) and WebKit `jsc` tests.

export const DEFAULT_ADV_FILTERS = Object.freeze({
  valZone: "ALL",
  maxPe: "ALL",
  minRoce: "0",
  maxDe: "ALL",
  minGrowth: "0",
  archetype: "ALL",
  zeroFlags: false,
  street: "ALL",
  range52w: "ALL",
  capTier: "ALL",
  above200Dma: false,
});

const ARCHETYPE_CODE_LABELS = {
  secular_compounder: "Cash-Rich Compounder",
  financial_lender: "Banking & Financial Leader",
  buyback_compounder: "Share-Buyback Cash Cow",
  regulated_infra: "Regulated Infrastructure",
  cyclical_commodity: "Cyclical / Commodity Business",
  loss_turnaround: "Unprofitable / Turnaround",
};

const VAL_ZONE_CHIP_LABELS = {
  UNDERVALUED: "Valuation: Bargain / Undervalued",
  FAIR_OR_BETTER: "Valuation: Fair or Better",
  NOT_EXPENSIVE: "Valuation: Not Expensive",
};

const STREET_CHIP_LABELS = {
  UPSIDE_10: "Street Upside ≥ 10%",
  UPSIDE_20: "Street Upside ≥ 20%",
  BULLISH_REV: "Positive EPS Revisions",
  STRONG_CONSENSUS: "≥ 70% Analyst Buy",
};

const RANGE_52W_CHIP_LABELS = {
  NEAR_HIGH: "Within 10% of 52W High",
  DIP_10_25: "Pullback 10%–25% off High",
  DEEP_DIP_25: "Deep Dip >25% off High",
};

const CAP_TIER_CHIP_LABELS = {
  MEGA_LARGE: "Mega & Large Cap",
  MID: "Mid & Emerging Cap",
};

export function normalizeAdvFilters(raw) {
  const src = raw && typeof raw === "object" ? raw : {};

  const valZone =
    src.valZone && String(src.valZone).trim() !== "" ? String(src.valZone).trim() : "ALL";

  let maxPe = "ALL";
  if (
    src.maxPe !== undefined &&
    src.maxPe !== null &&
    String(src.maxPe).trim() !== "" &&
    String(src.maxPe).trim().toUpperCase() !== "ALL" &&
    Number(src.maxPe) > 0
  ) {
    maxPe = String(src.maxPe).trim();
  }

  let minRoce = "0";
  if (
    src.minRoce !== undefined &&
    src.minRoce !== null &&
    String(src.minRoce).trim() !== "" &&
    String(src.minRoce).trim().toUpperCase() !== "ALL" &&
    Number(src.minRoce) > 0
  ) {
    minRoce = String(src.minRoce).trim();
  }

  let maxDe = "ALL";
  if (
    src.maxDe !== undefined &&
    src.maxDe !== null &&
    String(src.maxDe).trim() !== "" &&
    String(src.maxDe).trim().toUpperCase() !== "ALL" &&
    Number.isFinite(Number(src.maxDe))
  ) {
    maxDe = String(src.maxDe).trim();
  }

  let minGrowth = "0";
  if (
    src.minGrowth !== undefined &&
    src.minGrowth !== null &&
    String(src.minGrowth).trim() !== "" &&
    String(src.minGrowth).trim().toUpperCase() !== "ALL" &&
    Number(src.minGrowth) > 0
  ) {
    minGrowth = String(src.minGrowth).trim();
  }

  let archetype = "ALL";
  if (src.archetype && typeof src.archetype === "object") {
    const picked = src.archetype.value || src.archetype.key || src.archetype.label || "ALL";
    archetype = String(picked).trim() || "ALL";
  } else if (src.archetype && String(src.archetype).trim() !== "") {
    archetype = String(src.archetype).trim();
  }

  const zeroFlags = Boolean(src.zeroFlags);

  const street =
    src.street && String(src.street).trim() !== "" ? String(src.street).trim() : "ALL";

  const range52w =
    src.range52w && String(src.range52w).trim() !== "" ? String(src.range52w).trim() : "ALL";

  const capTier =
    src.capTier && String(src.capTier).trim() !== "" ? String(src.capTier).trim() : "ALL";

  const above200Dma = Boolean(src.above200Dma);

  return {
    valZone,
    maxPe,
    minRoce,
    maxDe,
    minGrowth,
    archetype,
    zeroFlags,
    street,
    range52w,
    capTier,
    above200Dma,
  };
}

function lookupStage1Entry(stage1ByTickerMap, ticker) {
  if (!stage1ByTickerMap || !ticker) return null;
  if (typeof stage1ByTickerMap.get === "function") {
    return stage1ByTickerMap.get(ticker) || null;
  }
  if (Array.isArray(stage1ByTickerMap)) {
    for (const row of stage1ByTickerMap) {
      if (row && row.ticker === ticker) return row;
    }
    return null;
  }
  if (typeof stage1ByTickerMap === "object") {
    return stage1ByTickerMap[ticker] || null;
  }
  return null;
}

export function isProfitableWithValidPe(stock) {
  if (!stock || typeof stock !== "object") return false;
  const m = stock.metrics || {};
  const pe = Number(m.pe_ratio ?? stock.pe_ratio ?? 0);
  if (!Number.isFinite(pe) || pe <= 0 || pe >= 99) return false;
  if (m.pat_cr !== undefined && m.pat_cr !== null && Number(m.pat_cr) <= 0) return false;
  if (stock.pat_cr !== undefined && stock.pat_cr !== null && Number(stock.pat_cr) <= 0) {
    return false;
  }
  const peObj = stock.plain_english || {};
  if (peObj.archetype_code === "loss_turnaround" || peObj.archetype_key === "loss_turnaround") {
    return false;
  }
  const flags = Array.isArray(stock.red_flags) ? stock.red_flags : [];
  if (flags.some((flag) => String(flag || "").includes("Loss-making"))) {
    return false;
  }
  return true;
}

export function effectiveRoceOrRoe(stock) {
  if (!stock || typeof stock !== "object") return 0;
  const m = stock.metrics || {};
  if (stock.is_financial) {
    const roe = m.roe_pct ?? m.med_5y_roce_pct ?? m.roce_pct ?? 0;
    return Number.isFinite(Number(roe)) ? Number(roe) : 0;
  }
  const roce = m.med_5y_roce_pct ?? m.roce_pct ?? 0;
  return Number.isFinite(Number(roce)) ? Number(roce) : 0;
}

export function countActiveAdvFilters(filters) {
  const f = normalizeAdvFilters(filters);
  let count = 0;
  if (f.valZone !== "ALL") count += 1;
  if (f.maxPe !== "ALL") count += 1;
  if (Number(f.minRoce) > 0) count += 1;
  if (f.maxDe !== "ALL") count += 1;
  if (Number(f.minGrowth) > 0) count += 1;
  if (f.archetype !== "ALL") count += 1;
  if (f.zeroFlags) count += 1;
  if (f.street !== "ALL") count += 1;
  if (f.range52w !== "ALL") count += 1;
  if (f.capTier !== "ALL") count += 1;
  if (f.above200Dma) count += 1;
  return count;
}

export function describeActiveFilterChips(filters) {
  const f = normalizeAdvFilters(filters);
  const chips = [];

  if (f.valZone !== "ALL") {
    chips.push({
      key: "valZone",
      value: f.valZone,
      label: VAL_ZONE_CHIP_LABELS[f.valZone] || `Valuation: ${f.valZone}`,
    });
  }
  if (f.maxPe !== "ALL") {
    chips.push({
      key: "maxPe",
      value: f.maxPe,
      label: `Max P/E ≤ ${f.maxPe}x`,
    });
  }
  if (Number(f.minRoce) > 0) {
    chips.push({
      key: "minRoce",
      value: f.minRoce,
      label: `ROCE / ROE ≥ ${f.minRoce}%`,
    });
  }
  if (f.maxDe !== "ALL") {
    chips.push({
      key: "maxDe",
      value: f.maxDe,
      label: Number(f.maxDe) <= 0.1001 ? "Debt-Free (≤ 0.1x)" : `Max D/E ≤ ${f.maxDe}x`,
    });
  }
  if (Number(f.minGrowth) > 0) {
    chips.push({
      key: "minGrowth",
      value: f.minGrowth,
      label: `3Y Growth ≥ ${f.minGrowth}%`,
    });
  }
  if (f.archetype !== "ALL") {
    const prettyArch = ARCHETYPE_CODE_LABELS[f.archetype] || f.archetype;
    chips.push({
      key: "archetype",
      value: f.archetype,
      label: `Style: ${prettyArch}`,
    });
  }
  if (f.zeroFlags) {
    chips.push({
      key: "zeroFlags",
      value: true,
      label: "Zero Red Flags",
    });
  }
  if (f.street !== "ALL") {
    chips.push({
      key: "street",
      value: f.street,
      label: STREET_CHIP_LABELS[f.street] || `Street: ${f.street}`,
    });
  }
  if (f.range52w !== "ALL") {
    chips.push({
      key: "range52w",
      value: f.range52w,
      label: RANGE_52W_CHIP_LABELS[f.range52w] || `52W: ${f.range52w}`,
    });
  }
  if (f.capTier !== "ALL") {
    chips.push({
      key: "capTier",
      value: f.capTier,
      label: CAP_TIER_CHIP_LABELS[f.capTier] || `Cap: ${f.capTier}`,
    });
  }
  if (f.above200Dma) {
    chips.push({
      key: "above200Dma",
      value: true,
      label: "Above 200-DMA",
    });
  }

  return chips;
}

export function extractUniqueArchetypes(stocks) {
  const seen = new Set();
  for (const s of stocks || []) {
    const pe = (s && s.plain_english) || {};
    const label = String(pe.archetype_label || pe.archetype_key || pe.archetype_code || "").trim();
    if (label) {
      seen.add(label);
    }
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

export function matchesAdvancedFilters(stock, filters, stage1ByTickerMap) {
  if (!stock || typeof stock !== "object") return false;
  const f = normalizeAdvFilters(filters);
  const m = stock.metrics || {};
  const peObj = stock.plain_english || {};
  const st = stock.street || {};
  const s1 = lookupStage1Entry(stage1ByTickerMap, stock.ticker);

  // --- Group 1: Valuation & Quality ---
  if (f.valZone !== "ALL") {
    const rawZone = String(stock.valuation_zone || "");
    const zLow = rawZone.toLowerCase();
    const pe = Number(m.pe_ratio ?? stock.pe_ratio ?? 0);
    const fairPe = Number(
      m.fair_pe_ratio ?? m.fair_pe ?? stock.fair_pe_ratio ?? stock.fair_pe ?? 0
    );
    const hasPeField = m.pe_ratio !== undefined || stock.pe_ratio !== undefined;
    const validPe = !hasPeField || isProfitableWithValidPe(stock);

    if (f.valZone === "UNDERVALUED") {
      const zoneMatch = zLow === "undervalued" || zLow.includes("undervalued");
      const ratioMatch = validPe && fairPe > 0 && pe > 0 && pe < 99 && pe <= fairPe * 0.92;
      if (!zoneMatch && !ratioMatch) return false;
      if (hasPeField && !validPe) return false;
    } else if (f.valZone === "FAIR_OR_BETTER") {
      if (
        zLow.includes("expensive") ||
        zLow.includes("overvalued") ||
        zLow.includes("loss") ||
        zLow.includes("unprofitable") ||
        zLow.includes("rich")
      ) {
        return false;
      }
      if (hasPeField && !validPe) return false;
    } else if (f.valZone === "NOT_EXPENSIVE") {
      if (zLow.includes("expensive") || zLow.includes("overvalued")) {
        return false;
      }
    }
  }

  if (f.maxPe !== "ALL") {
    const maxPeVal = Number(f.maxPe);
    if (!isProfitableWithValidPe(stock)) return false;
    const pe = Number(m.pe_ratio ?? stock.pe_ratio ?? 0);
    if (pe > maxPeVal) return false;
  }

  if (Number(f.minRoce) > 0) {
    if (effectiveRoceOrRoe(stock) < Number(f.minRoce)) return false;
  }

  if (f.maxDe !== "ALL") {
    const maxDeVal = Number(f.maxDe);
    if (Boolean(stock.is_financial) && maxDeVal <= 0.1001) {
      return false;
    }
    const de = Number(m.debt_to_equity ?? stock.debt_to_equity ?? 0);
    if (!Number.isFinite(de) || de < 0 || de > maxDeVal) {
      return false;
    }
  }

  // --- Group 2: Growth & Safety ---
  if (Number(f.minGrowth) > 0) {
    const rev3 = Number(m.rev_cagr_3y_pct ?? -999);
    const pat3 = Number(m.pat_cagr_3y_pct ?? -999);
    const max3y = Math.max(
      Number.isFinite(rev3) ? rev3 : -999,
      Number.isFinite(pat3) ? pat3 : -999
    );
    if (max3y < Number(f.minGrowth)) return false;
  }

  if (f.archetype !== "ALL") {
    const target = f.archetype.toLowerCase();
    const aKey = String(peObj.archetype_key || "").trim().toLowerCase();
    const aCode = String(peObj.archetype_code || "").trim().toLowerCase();
    const aLbl = String(peObj.archetype_label || "").trim().toLowerCase();
    if (target !== aKey && target !== aCode && target !== aLbl) {
      return false;
    }
  }

  if (f.zeroFlags) {
    const flags = Array.isArray(stock.red_flags) ? stock.red_flags : [];
    if (flags.length !== 0) return false;
  }

  // --- Group 3: Street Consensus ---
  if (f.street !== "ALL") {
    if (f.street === "UPSIDE_10") {
      if (st.has_coverage === false) return false;
      if (Number(st.target_upside_pct ?? -999) < 10) return false;
    } else if (f.street === "UPSIDE_20") {
      if (st.has_coverage === false) return false;
      if (Number(st.target_upside_pct ?? -999) < 20) return false;
    } else if (f.street === "BULLISH_REV") {
      const breadth = Number(st.rev_breadth_pct || 0);
      const up = Number(st.eps_rev_up_30d || st.eps_rev_up_90d || 0);
      const dn = Number(st.eps_rev_down_30d || st.eps_rev_down_90d || 0);
      if (!(breadth > 0 || up > dn)) return false;
    } else if (f.street === "STRONG_CONSENSUS") {
      if (Number(st.consensus_buy_pct || 0) < 70 || Number(st.analyst_count || 0) < 3) {
        return false;
      }
    }
  }

  // --- Group 4: Technicals & Market Cap Tier ---
  if (f.range52w !== "ALL") {
    const rawDist =
      s1 && s1.dist_52w_high_pct !== undefined && s1.dist_52w_high_pct !== null
        ? s1.dist_52w_high_pct
        : m.dist_52w_high_pct ?? stock.dist_52w_high_pct;
    if (rawDist === undefined || rawDist === null || !Number.isFinite(Number(rawDist))) {
      return false;
    }
    const dist = Number(rawDist);
    if (f.range52w === "NEAR_HIGH" && !(dist >= -10)) return false;
    if (f.range52w === "DIP_10_25" && !(dist < -10 && dist >= -25)) return false;
    if (f.range52w === "DEEP_DIP_25" && !(dist < -25)) return false;
  }

  if (f.capTier !== "ALL") {
    const capStr = String((s1 && s1.cap_tier) || stock.cap_tier || "");
    if (f.capTier === "MEGA_LARGE") {
      if (!(capStr.includes("Mega") || capStr.includes("Large"))) return false;
    } else if (f.capTier === "MID") {
      if (!(capStr.includes("Mid") || capStr.includes("Small") || capStr.includes("Emerging"))) {
        return false;
      }
    }
  }

  if (f.above200Dma) {
    const flag200 =
      s1 && s1.above_200dma !== undefined ? Boolean(s1.above_200dma) : Boolean(stock.above_200dma);
    if (!s1 && stock.above_200dma === undefined) return false;
    if (flag200 !== true) return false;
  }

  return true;
}

function defaultMcapInr(stock) {
  const raw = Number((stock && stock.market_cap_cr) || 0);
  const tag = String((stock && stock.index_tag) || "").toUpperCase();
  const isUs =
    tag === "NASDAQ100" ||
    tag === "SP500" ||
    (stock && (stock.market === "US" || stock.currency === "USD"));
  return isUs ? raw * 9.344 : raw;
}

function sortableUpsidePct(stock) {
  const st = (stock && stock.street) || {};
  if (st.has_coverage === false && Number(st.target_upside_pct || 0) === 0) {
    return -9999;
  }
  const u = Number(st.target_upside_pct);
  return Number.isFinite(u) ? u : -9999;
}

export function sortFilteredStocks(stocks, sortBy = "composite", stage1ByTickerMap = null, mcapInrFn = null) {
  const copy = Array.isArray(stocks) ? [...stocks] : [];
  const mcapFn =
    typeof mcapInrFn === "function"
      ? mcapInrFn
      : typeof stage1ByTickerMap === "function"
      ? stage1ByTickerMap
      : defaultMcapInr;

  const tieBreak = (a, b) => Number((b && b.composite_score) || 0) - Number((a && a.composite_score) || 0);

  if (sortBy === "quality") {
    copy.sort(
      (a, b) =>
        Number((b.pillars && b.pillars.quality) || 0) -
          Number((a.pillars && a.pillars.quality) || 0) || tieBreak(a, b)
    );
  } else if (sortBy === "growth") {
    copy.sort(
      (a, b) =>
        Number((b.pillars && b.pillars.growth) || 0) -
          Number((a.pillars && a.pillars.growth) || 0) || tieBreak(a, b)
    );
  } else if (sortBy === "value") {
    copy.sort(
      (a, b) =>
        Number((b.pillars && b.pillars.value) || 0) -
          Number((a.pillars && a.pillars.value) || 0) || tieBreak(a, b)
    );
  } else if (sortBy === "mcap") {
    copy.sort((a, b) => Number(mcapFn(b) || 0) - Number(mcapFn(a) || 0) || tieBreak(a, b));
  } else if (sortBy === "upside") {
    copy.sort((a, b) => sortableUpsidePct(b) - sortableUpsidePct(a) || tieBreak(a, b));
  } else if (sortBy === "roce") {
    copy.sort((a, b) => effectiveRoceOrRoe(b) - effectiveRoceOrRoe(a) || tieBreak(a, b));
  } else if (sortBy === "pe_asc") {
    copy.sort((a, b) => {
      const aValid = isProfitableWithValidPe(a);
      const bValid = isProfitableWithValidPe(b);
      if (aValid !== bValid) return aValid ? -1 : 1;
      if (!aValid && !bValid) return tieBreak(a, b);
      const aPe = Number((a.metrics && a.metrics.pe_ratio) ?? a.pe_ratio ?? 999);
      const bPe = Number((b.metrics && b.metrics.pe_ratio) ?? b.pe_ratio ?? 999);
      return aPe - bPe || tieBreak(a, b);
    });
  } else {
    copy.sort((a, b) => tieBreak(a, b));
  }
  return copy;
}
