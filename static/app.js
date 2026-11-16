// ArthaQuant V2.0 Frontend Controller
// Built exclusively with safe DOM creation (createElement, createElementNS, textContent)
// and CSS class toggling.

import {
  createContributionBarSvg,
  createProgressSvg,
  createScoreRingSvg,
  formatCurrencyCompact,
  formatMarketCap,
  formatStockPrice,
  renderMultiLineChart,
} from "/static/charts.js";
import {
  getCompanyDetailSnapshot,
  importCsvInMemory,
  runBacktestSnapshot,
  runPlannerSnapshot,
  runScreenerSnapshot,
} from "/static/standalone_engine.js";

const DEFAULT_PRESET_WEIGHTS = {
  qglp_compounder: { quality: 45.0, value: 20.0, growth: 25.0, momentum: 10.0 },
  coffee_can: { quality: 55.0, value: 10.0, growth: 30.0, momentum: 5.0 },
  magic_formula: { quality: 45.0, value: 45.0, growth: 5.0, momentum: 5.0 },
  artha_blend: { quality: 35.0, value: 25.0, growth: 20.0, momentum: 20.0 },
  value_momentum: { quality: 10.0, value: 45.0, growth: 5.0, momentum: 40.0 },
};

const PRESET_NAMES = {
  qglp_compounder: "Long-Term QGLP Compounder",
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
  funnelView: "stage2",
  screenerMarket: "ALL",
  plannerMarket: "ALL",
  backtestMarket: "IN",
  ratingFilter: "ALL",
  stocks: [],
  visibleStocks: [],
  stage1Funnel: [],
  marketCounts: { ALL: 0, IN: 0, US: 0 },
  presetWeightsMap: DEFAULT_PRESET_WEIGHTS,
  selectedTicker: null,
  drawerOpen: false,
  backtestLoaded: false,
  plannerLoaded: false,
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

function isUSStock(item) {
  if (!item) return false;
  if (item.market) return item.market === "US";
  if (item.currency) return item.currency === "USD";
  return false;
}

function stockCurrency(item) {
  return isUSStock(item) ? "USD" : "INR";
}

function displaySymbol(ticker) {
  return String(ticker || "").replace(".NS", "").replace(".BO", "");
}

function createMarketTag(item) {
  const us = isUSStock(item);
  return el(
    "span",
    us ? "tag-market tag-market-us" : "tag-market tag-market-in",
    us ? "US Stock · NASDAQ" : "Indian Stock · NSE"
  );
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
  const fair = Number(metrics.fair_pe || 0);
  if (pe >= 99 || pe <= 0) return `N/M (Fair ~${fair}x)`;
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
  else if (z.includes("Overvalued")) cls = "val-zone-pill zone-over";
  else if (z.includes("Rich")) cls = "val-zone-pill zone-rich";
  return el("span", cls, z);
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

async function initAuth() {
  try {
    const status = await apiRequest("/api/auth/status");
    state.csrfToken = status.csrf_token;
    state.needsSetup = Boolean(status.needs_setup);

    if (status.authenticated) {
      state.username = status.username;
      await enterWorkspace();
    } else {
      showAuthGate();
    }
  } catch (_err) {
    state.staticMode = true;
    state.username = "Cloud Snapshot";
    document.getElementById("logout-btn").classList.add("hidden");
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
    ? "Mode: Cloud Snapshot (NSE + Nasdaq)"
    : `Advisor: ${state.username}`;
  await loadScreener(true);
}

// --- Navigation & Market Switchers ---

function switchTab(tabName) {
  for (const btn of document.querySelectorAll(".nav-tab")) {
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
  if (market === "IN") {
    searchEl.placeholder =
      "Search Indian NSE stocks (e.g. Muthoot, ICICI, Polycab, TCS, Dixon)...";
    secLabel.textContent = "NSE Sector";
  } else if (market === "US") {
    searchEl.placeholder =
      "Search US Nasdaq-100 stocks (e.g. NVDA, MSFT, AAPL, COST, META, AVGO)...";
    secLabel.textContent = "Nasdaq-100 Sector";
  } else {
    searchEl.placeholder =
      "Search NSE & Nasdaq-100 stocks (e.g. Muthoot, NVDA, MSFT, ICICI, Apple, Dixon)...";
    secLabel.textContent = "Sector Filter";
  }

  document.getElementById("screener-sector").value = "ALL";
  await loadScreener(true);
}

async function setPlannerMarket(market) {
  const prevMarket = state.plannerMarket;
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

  if (market === "US") {
    lumpLbl.textContent = "Capital to Deploy Today ($ USD)";
    sipLbl.textContent = "Optional Monthly SIP ($ USD)";
    targetLbl.textContent = "Target Corpus Goal ($ USD)";
    runBtn.textContent = "Build $ Blueprint";
    coneTitle.textContent = "1,000-Path Wealth Projection Cone ($ USD)";
    navTab.textContent = "$10K Investment Planner";
    marketSub.textContent =
      "Deploying USD directly into whole Nasdaq-100 US compounder shares";

    if (prevMarket !== "US" || Number(lumpInput.value) >= 100000) {
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
        ? "Deploying ₹ INR across audited Indian NSE Nifty-200 compounders"
        : "Deploying ₹ INR across Global All-Market leaders (US prices sized at ₹84.5/$)";

    if (prevMarket === "US" || Number(lumpInput.value) <= 50000) {
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

    const mc = data.market_counts || {
      ALL: data.total_deep_scored || state.stocks.length,
      IN: state.stocks.filter((s) => !isUSStock(s)).length,
      US: state.stocks.filter((s) => isUSStock(s)).length,
    };
    state.marketCounts = mc;

    document.getElementById("mkt-count-all").textContent = String(mc.ALL || 0);
    document.getElementById("mkt-count-in").textContent = String(mc.IN || 0);
    document.getElementById("mkt-count-us").textContent = String(mc.US || 0);

    const niftyVal = Number(data.benchmark_nifty50 || 0);
    const ndxVal = Number(data.benchmark_nasdaq100 || 0);
    const niftyPart = niftyVal > 0 ? `Nifty 50: ${niftyVal.toLocaleString("en-IN")}` : "";
    const ndxPart =
      ndxVal > 0
        ? `Nasdaq 100: ${ndxVal.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
        : "";
    const idxJoined = [niftyPart, ndxPart].filter(Boolean).join("  •  ");
    const countPart =
      mc.US > 0
        ? `Audited Universe: ${mc.IN} Indian (NSE) + ${mc.US} US (Nasdaq-100)`
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
        mc.US > 0
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
          ? "All Indian Sectors"
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
    el("span", "muted-note", `${PRESET_NAMES[preset] || "Model"} Formula:`)
  );

  const items = [
    ["dot-emerald", `Quality & 8Y Moat ${w.quality.toFixed(0)}%`],
    ["dot-indigo", `5Y + 2Q Growth ${w.growth.toFixed(0)}%`],
    ["dot-cyan", `GARP Valuation ${w.value.toFixed(0)}%`],
    ["dot-amber", `Piotroski & Smart Money ${w.momentum.toFixed(0)}%`],
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
  penChip.appendChild(el("span", "", "Guardrail Penalties"));
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
  const hay = [
    item.name || "",
    item.ticker || "",
    item.sector || "",
    item.market_label || (isUSStock(item) ? "US Stock NASDAQ" : "Indian Stock NSE"),
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
      sub: "Complete filtered universe",
      colorCls: "",
    },
    {
      key: "Strong Buy",
      title: "Strong Buy",
      count: counts["Strong Buy"],
      sub: "Score ≥ 68 • Zero Red Flags",
      colorCls: "text-pos",
    },
    {
      key: "Buy",
      title: "Buy",
      count: counts.Buy,
      sub: "Score ≥ 57 • Accumulate 3-5Y+",
      colorCls: "text-cyan",
    },
    {
      key: "Hold",
      title: "Hold / Buy on Dip",
      count: counts.Hold,
      sub: "Watchlist or Valuation Cap",
      colorCls: "text-warn",
    },
    {
      key: "Avoid",
      title: "Avoid",
      count: counts.Avoid,
      sub: "Forensic or Balance-Sheet Caution",
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
      ? "Top Indian NSE Conviction Leaders"
      : state.screenerMarket === "US"
      ? "Top US Nasdaq-100 Conviction Leaders"
      : "Top Global Conviction Leaders";
  document.getElementById("podium-heading").textContent = marketTitle;

  const top3 = visibleStocks.slice(0, 3);
  top3.forEach((s, idx) => {
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
        `${displaySymbol(s.ticker)} • ${s.sector} • MCap ${formatMarketCap(
          s.market_cap_cr,
          s.market,
          s.currency
        )}`
      )
    );

    top.appendChild(left);
    top.appendChild(createScoreRingSvg(s.composite_score, s.rating, 60));
    card.appendChild(top);

    const metricsRow = el("div", "podium-metrics-row");
    metricsRow.appendChild(el("span", ratingBadgeClass(s.rating), s.rating));
    metricsRow.appendChild(
      el("span", "mini-stat-pill", `CMP ${formatStockPrice(s.price, stockCurrency(s))}`)
    );
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
    card.appendChild(metricsRow);

    const thesisLine =
      (s.strengths && s.strengths.length > 0 ? s.strengths[0] : s.conviction) || "";
    card.appendChild(el("div", "podium-thesis", thesisLine));

    const footer = el("div", "podium-footer");
    footer.appendChild(createValZonePill(s.valuation_zone));
    const btn = el("button", "btn-deep-dive", "View Score Reasoning →");
    btn.type = "button";
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openDeepDive(s.ticker);
    });
    footer.appendChild(btn);
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
      ? "Indian Stocks — NSE Nifty-200 Fundamental Rankings"
      : state.screenerMarket === "US"
      ? "US Stocks — Nasdaq-100 Fundamental Rankings"
      : "Global Multi-Market Fundamental Rankings (NSE + Nasdaq-100)";
  document.getElementById("table-panel-title").textContent = marketHeadline;
  document.getElementById("table-panel-sub").textContent =
    "Scored on 8Y Anti-Cyclical Moat, Latest 2Q YoY Earnings, GARP Fair P/E & Piotroski Health — click any row for exact score math";
  document.getElementById("visible-count-badge").textContent =
    `Showing ${stocks.length} of ${state.stocks.length} Ranked`;

  setTableHeaders([
    "Rank",
    "Company & Market Tag",
    "Verdict & Conviction",
    "Composite Score & Pillar Contribution",
    "Price vs Fair P/E",
    "Core Fundamentals",
    "Score Reasoning",
  ]);

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

    // 2. Company & Market Tag
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
        `${s.sector} • MCap ${formatMarketCap(s.market_cap_cr, s.market, s.currency)}`
      )
    );
    tr.appendChild(compTd);

    // 3. Verdict & Conviction
    const rateTd = document.createElement("td");
    rateTd.appendChild(el("span", ratingBadgeClass(s.rating), s.rating));
    rateTd.appendChild(el("span", "conviction-sub", s.conviction || ""));
    tr.appendChild(rateTd);

    // 4. Composite Score & Pillar Contribution Bar
    const bd = resolveScoreBreakdown(s);
    const scoreTd = document.createElement("td");
    const scoreWrap = el("div", "score-cell-wrap");
    const topLine = el("div", "score-top-line");
    const bigSpan = el("span", "score-big", `${s.composite_score.toFixed(1)}`);
    topLine.appendChild(bigSpan);
    if (Number(bd.total_penalty || 0) > 0) {
      topLine.appendChild(
        el("span", "penalty-tag", `−${Number(bd.total_penalty).toFixed(1)} Guardrail`)
      );
    } else {
      topLine.appendChild(el("span", "muted-note", "/ 100"));
    }
    scoreWrap.appendChild(topLine);
    scoreWrap.appendChild(createContributionBarSvg(bd.contributions, 8));

    const miniBreak = el("div", "score-mini-breakdown");
    miniBreak.appendChild(
      el("span", "text-pos", `Q +${Number(bd.contributions.quality).toFixed(1)}`)
    );
    miniBreak.appendChild(
      el("span", "text-indigo", `G +${Number(bd.contributions.growth).toFixed(1)}`)
    );
    miniBreak.appendChild(
      el("span", "text-cyan", `V +${Number(bd.contributions.value).toFixed(1)}`)
    );
    miniBreak.appendChild(
      el("span", "text-warn", `H +${Number(bd.contributions.momentum).toFixed(1)}`)
    );
    scoreWrap.appendChild(miniBreak);
    scoreTd.appendChild(scoreWrap);
    tr.appendChild(scoreTd);

    // 5. Price vs Fair P/E
    const valTd = document.createElement("td");
    valTd.appendChild(
      el("div", "company-primary", formatStockPrice(s.price, stockCurrency(s)))
    );
    valTd.appendChild(
      el(
        "span",
        "sector-sub",
        `P/E ${formatPeVsFair(s.metrics)} • PEG ${s.metrics.peg_ratio}x`
      )
    );
    valTd.appendChild(createValZonePill(s.valuation_zone));
    tr.appendChild(valTd);

    // 6. Core Fundamentals
    const fundTd = document.createElement("td");
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
        `8Y Moat Stability: ${stab}/100`
      )
    );
    fundList.appendChild(
      el(
        "span",
        qPat >= 12 ? "text-pos" : qPat < 0 ? "text-neg" : "",
        `2Q PAT YoY: ${fmtSigned(qPat)}% • F-Score ${s.metrics.piotroski_f_score}/9`
      )
    );
    fundTd.appendChild(fundList);
    tr.appendChild(fundTd);

    // 7. Deep Dive Button
    const actionTd = document.createElement("td");
    const ddBtn = el("button", "btn-deep-dive", "Deep Dive →");
    ddBtn.type = "button";
    ddBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openDeepDive(s.ticker);
    });
    actionTd.appendChild(ddBtn);
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
  state.selectedTicker = ticker;
  state.drawerOpen = true;

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
    renderCompanyDetail(detail);
  } catch (err) {
    showToast(err.message, true);
  }
}

function buildEvidenceMetricRow(name, target, valueText, valueColorClass = "") {
  const row = el("div", "ev-metric-row");
  const left = el("div", "ev-m-name");
  left.appendChild(el("span", "", name));
  if (target) left.appendChild(el("span", "ev-target", target));
  row.appendChild(left);
  row.appendChild(el("div", `ev-m-val ${valueColorClass}`.trim(), valueText));
  return row;
}

function renderCompanyDetail(detail) {
  const container = document.getElementById("company-detail-content");
  container.replaceChildren();
  const sc = detail.scorecard;
  if (!sc) {
    container.appendChild(
      el("div", "empty-state-box", "Scorecard unavailable for this company.")
    );
    return;
  }

  const comp = detail.company || {};
  const mergedMarketObj = {
    market: sc.market || comp.market || "IN",
    currency: sc.currency || comp.currency || "INR",
  };
  const us = isUSStock(mergedMarketObj);
  const ccy = stockCurrency(mergedMarketObj);
  const m = sc.metrics || {};
  const bd = resolveScoreBreakdown(sc);

  // a) Hero Summary Card
  const hero = el("div", "dd-hero-card");
  const heroLeft = el("div", "dd-hero-left");
  heroLeft.appendChild(createScoreRingSvg(sc.composite_score, sc.rating, 72));

  const heroMetaWrap = document.createElement("div");
  const heroBadges = el("div", "dd-hero-badges");
  heroBadges.appendChild(el("span", "ticker-tag", sc.ticker));
  heroBadges.appendChild(createMarketTag(mergedMarketObj));
  heroBadges.appendChild(el("span", "pill", sc.sector));
  heroMetaWrap.appendChild(heroBadges);
  heroMetaWrap.appendChild(el("div", "dd-hero-title", sc.name));
  heroMetaWrap.appendChild(
    el(
      "div",
      "muted-note",
      `Market Cap: ${formatMarketCap(sc.market_cap_cr, mergedMarketObj.market, ccy)} • ${
        sc.cap_tier || "Large Cap"
      }${sc.rank ? ` • Rank #${sc.rank}` : ""}`
    )
  );
  heroLeft.appendChild(heroMetaWrap);

  const heroRight = el("div", "dd-hero-right");
  heroRight.appendChild(el("div", "dd-cmp", formatStockPrice(sc.price, ccy)));
  const ratingWrap = el("div", "top-gap");
  ratingWrap.appendChild(el("span", ratingBadgeClass(sc.rating), sc.rating));
  heroRight.appendChild(ratingWrap);
  if (sc.conviction) {
    heroRight.appendChild(el("span", "conviction-sub", sc.conviction));
  }
  heroRight.appendChild(createValZonePill(sc.valuation_zone));

  hero.appendChild(heroLeft);
  hero.appendChild(heroRight);
  container.appendChild(hero);

  // b) Step-by-Step Score Waterfall
  const wfCard = el("div", "dd-section-card");
  wfCard.appendChild(
    el("div", "dd-section-title", `Why This Stock Scored ${sc.composite_score.toFixed(1)} / 100`)
  );
  wfCard.appendChild(
    el(
      "div",
      "dd-section-sub",
      `Exact weighted pillar contribution & guardrail waterfall under ${
        PRESET_NAMES[bd.preset_used] || "Active Philosophy"
      }`
    )
  );
  wfCard.appendChild(createContributionBarSvg(bd.contributions, 10));

  const wfList = el("div", "waterfall-list");
  const pillarRows = [
    [
      "1. Quality & 8Y Anti-Cyclical Moat",
      sc.pillars.quality,
      bd.weights_pct.quality,
      bd.contributions.quality,
      "text-pos",
    ],
    [
      "2. 5Y Compounding + Latest 2Q Growth",
      sc.pillars.growth,
      bd.weights_pct.growth,
      bd.contributions.growth,
      "text-indigo",
    ],
    [
      "3. GARP & Cyclical Fair P/E Valuation",
      sc.pillars.value,
      bd.weights_pct.value,
      bd.contributions.value,
      "text-cyan",
    ],
    [
      "4. Piotroski 9-Point & Smart Money",
      sc.pillars.momentum,
      bd.weights_pct.momentum,
      bd.contributions.momentum,
      "text-warn",
    ],
  ];

  for (const [label, pScore, wPct, contrib, cls] of pillarRows) {
    const row = el("div", "waterfall-row");
    row.appendChild(el("div", "wf-label", label));
    row.appendChild(
      el(
        "div",
        "wf-math",
        `${Number(pScore).toFixed(1)} / 100 × ${Number(wPct).toFixed(1)}% weight`
      )
    );
    row.appendChild(el("div", `wf-pts ${cls}`, `+${Number(contrib).toFixed(1)} pts`));
    wfList.appendChild(row);
  }

  const rawRow = el("div", "waterfall-row");
  rawRow.appendChild(el("div", "wf-label", "Raw Weighted Score (Pre-Guardrails)"));
  rawRow.appendChild(el("div", "wf-math", "Sum of 4 weighted institutional pillars"));
  rawRow.appendChild(el("div", "wf-pts", `${Number(bd.raw_composite).toFixed(1)} pts`));
  wfList.appendChild(rawRow);

  const penItems = bd.penalty_items || [];
  if (penItems.length > 0) {
    for (const item of penItems) {
      const pRow = el("div", "waterfall-row penalty-row");
      pRow.appendChild(el("div", "wf-label text-neg", "Guardrail Penalty"));
      pRow.appendChild(el("div", "wf-math", item.reason));
      const ptsNum = Number(item.points || 0);
      const ptsStr = ptsNum < 0 ? `${ptsNum.toFixed(1)} pts` : `-${ptsNum.toFixed(1)} pts`;
      pRow.appendChild(el("div", "wf-pts text-neg", ptsStr));
      wfList.appendChild(pRow);
    }
  } else {
    const cleanRow = el("div", "waterfall-row");
    cleanRow.appendChild(el("div", "wf-label text-pos", "Forensic & Valuation Guardrails"));
    cleanRow.appendChild(
      el("div", "wf-math", "Zero balance-sheet, cash-flow, or valuation penalties triggered")
    );
    cleanRow.appendChild(el("div", "wf-pts text-pos", "0.0 pts"));
    wfList.appendChild(cleanRow);
  }

  const totalRow = el("div", "waterfall-row total-row");
  totalRow.appendChild(el("div", "wf-label", "Final Composite Score"));
  totalRow.appendChild(
    el(
      "div",
      "wf-math",
      `${Number(bd.raw_composite).toFixed(1)} raw − ${Number(bd.total_penalty || 0).toFixed(
        1
      )} penalties`
    )
  );
  totalRow.appendChild(
    el("div", "wf-pts text-pos", `${sc.composite_score.toFixed(1)} / 100`)
  );
  wfList.appendChild(totalRow);
  wfCard.appendChild(wfList);

  if (bd.rating_rule) {
    wfCard.appendChild(el("div", "rule-verdict-box", `Verdict Rule: ${bd.rating_rule}`));
  }
  container.appendChild(wfCard);

  // c) Bull Thesis vs Forensic/Valuation Guardrails (2-column cards)
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
      el("li", "", `✓ Profitable in ${m.profit_consistency || "5/5"} recent audited fiscal years`)
    );
    flagList.appendChild(
      el("li", "", `✓ Valuation check: ${sc.valuation_zone || "Fair GARP Price"}`)
    );
  }
  flagBox.appendChild(flagList);
  thesisGrid.appendChild(flagBox);
  container.appendChild(thesisGrid);

  // d) 4-Pillar Evidence Breakdown (2x2 Grid)
  const evGrid = el("div", "dd-two-col");

  // Card 1: Quality & 8Y Moat
  const qCard = el("div", "evidence-card");
  const qHead = el("div", "ev-header");
  qHead.appendChild(el("span", "ev-title", "Quality & 8Y Anti-Cyclical Moat"));
  qHead.appendChild(el("span", "ev-score text-pos", `${sc.pillars.quality.toFixed(1)} / 100`));
  qCard.appendChild(qHead);
  qCard.appendChild(createProgressSvg(sc.pillars.quality, "#10b981"));
  const qMetrics = el("div", "ev-metrics");
  qMetrics.appendChild(
    buildEvidenceMetricRow(
      `5Y Median ${sc.is_financial ? "ROE" : "ROCE"}`,
      `Target: ≥ ${sc.is_financial ? "15%" : "18%"} across cycle`,
      `${m.med_5y_roce_pct}% (Latest ${m.roce_pct}%)`,
      m.med_5y_roce_pct >= (sc.is_financial ? 15 : 18) ? "text-pos" : ""
    )
  );
  qMetrics.appendChild(
    buildEvidenceMetricRow(
      "8Y Cycle Floor & Moat Stability",
      "Target: Floor ≥ 10% • Stability ≥ 65/100",
      `Floor ${m.cycle_floor_roce_pct}% • ${m.moat_stability_score}/100`,
      m.moat_stability_score >= 65 ? "text-pos" : ""
    )
  );
  if (sc.is_financial) {
    const npaText =
      m.gnpa_pct > 0
        ? `GNPA ${m.gnpa_pct}% / NNPA ${m.nnpa_pct}%`
        : `ROA ${m.roa_pct}% (${m.profit_consistency} yrs PAT > 0)`;
    qMetrics.appendChild(
      buildEvidenceMetricRow(
        "Banking Asset Quality & ROA",
        "Target: ROA ≥ 1.2% • Net NPA ≤ 1.0%",
        npaText,
        m.roa_pct >= 1.2 ? "text-pos" : ""
      )
    );
  } else {
    qMetrics.appendChild(
      buildEvidenceMetricRow(
        "5Y Cumulative CFO / EBITDA",
        "Target: ≥ 80% cash conversion",
        `${m.cfo_to_ebitda_pct}% (${m.profit_consistency} yrs PAT > 0)`,
        m.cfo_to_ebitda_pct >= 80 ? "text-pos" : m.cfo_to_ebitda_pct < 55 ? "text-neg" : ""
      )
    );
  }
  qMetrics.appendChild(
    buildEvidenceMetricRow(
      "Debt / Equity & Operating Margin",
      sc.is_financial ? "Capitalised leverage • OPM" : "Target: D/E ≤ 0.5x • OPM ≥ 15%",
      `D/E ${m.debt_to_equity}x • OPM ${m.op_margin_pct}%`,
      !sc.is_financial && m.debt_to_equity <= 0.5 ? "text-pos" : ""
    )
  );
  qCard.appendChild(qMetrics);
  evGrid.appendChild(qCard);

  // Card 2: GARP Valuation
  const vCard = el("div", "evidence-card");
  const vHead = el("div", "ev-header");
  vHead.appendChild(el("span", "ev-title", "GARP & Fair P/E Valuation"));
  vHead.appendChild(el("span", "ev-score text-cyan", `${sc.pillars.value.toFixed(1)} / 100`));
  vCard.appendChild(vHead);
  vCard.appendChild(createProgressSvg(sc.pillars.value, "#38bdf8"));
  const vMetrics = el("div", "ev-metrics");
  vMetrics.appendChild(
    buildEvidenceMetricRow(
      "Current P/E vs Fair GARP P/E",
      "Target: CMP P/E ≤ 1.1x Fair P/E",
      formatPeVsFair(m),
      m.pe_ratio <= m.fair_pe * 1.1 ? "text-pos" : m.pe_ratio > m.fair_pe * 1.5 ? "text-warn" : ""
    )
  );
  vMetrics.appendChild(
    buildEvidenceMetricRow(
      "PEG Ratio (Growth-Adjusted)",
      "Target: PEG ≤ 1.5x",
      `${m.peg_ratio}x`,
      m.peg_ratio <= 1.5 ? "text-pos" : m.peg_ratio > 2.2 ? "text-warn" : ""
    )
  );
  vMetrics.appendChild(
    buildEvidenceMetricRow(
      "Earnings Yield & FCF Yield",
      "Target: EY ≥ 4.5% • FCF ≥ 2.5%",
      `EY ${m.earnings_yield_pct}% • FCF ${m.fcf_yield_pct}%`
    )
  );
  vMetrics.appendChild(
    buildEvidenceMetricRow(
      "Price / Book & EV / EBITDA",
      "Balance-sheet & enterprise multiple",
      `P/B ${m.pb_ratio}x • EV/EBITDA ${m.ev_ebitda}x`
    )
  );
  vCard.appendChild(vMetrics);
  evGrid.appendChild(vCard);

  // Card 3: 5Y + 2Q Growth
  const gCard = el("div", "evidence-card");
  const gHead = el("div", "ev-header");
  gHead.appendChild(el("span", "ev-title", "5Y Compounding + Latest 2Q Growth"));
  gHead.appendChild(el("span", "ev-score text-indigo", `${sc.pillars.growth.toFixed(1)} / 100`));
  gCard.appendChild(gHead);
  gCard.appendChild(createProgressSvg(sc.pillars.growth, "#818cf8"));
  const gMetrics = el("div", "ev-metrics");
  gMetrics.appendChild(
    buildEvidenceMetricRow(
      "Sales CAGR (5Y / 3Y)",
      "Target: ≥ 12% structural top-line",
      `${m.rev_cagr_5y_pct}% (5Y) • ${m.rev_cagr_3y_pct}% (3Y)`,
      m.rev_cagr_5y_pct >= 12 ? "text-pos" : ""
    )
  );
  gMetrics.appendChild(
    buildEvidenceMetricRow(
      "Net Profit CAGR (5Y / 3Y)",
      "Target: ≥ 15% earnings compounding",
      `${m.pat_cagr_5y_pct}% (5Y) • ${m.pat_cagr_3y_pct}% (3Y)`,
      m.pat_cagr_5y_pct >= 15 ? "text-pos" : m.pat_cagr_3y_pct < 0 ? "text-neg" : ""
    )
  );
  gMetrics.appendChild(
    buildEvidenceMetricRow(
      `Latest 2Q Sales & PAT YoY${m.latest_qtr_label ? ` (${m.latest_qtr_label})` : ""}`,
      "Target: Positive quarterly trajectory",
      `Sales ${fmtSigned(m.qtr_rev_yoy_pct)}% • PAT ${fmtSigned(m.qtr_pat_yoy_pct)}%`,
      m.qtr_pat_yoy_pct >= 12 ? "text-pos" : m.qtr_pat_yoy_pct < 0 ? "text-neg" : ""
    )
  );
  gMetrics.appendChild(
    buildEvidenceMetricRow(
      "Quarterly Margin Δ YoY",
      "Target: Stable / expanding OPM",
      `${fmtSigned(m.qtr_opm_delta_pct)} pp`,
      m.qtr_opm_delta_pct >= 0 ? "text-pos" : "text-warn"
    )
  );
  gCard.appendChild(gMetrics);
  evGrid.appendChild(gCard);

  // Card 4: Piotroski & Smart Money
  const mCard = el("div", "evidence-card");
  const mHead = el("div", "ev-header");
  mHead.appendChild(el("span", "ev-title", "Piotroski 9-Point & Smart Money"));
  mHead.appendChild(el("span", "ev-score text-warn", `${sc.pillars.momentum.toFixed(1)} / 100`));
  mCard.appendChild(mHead);
  mCard.appendChild(createProgressSvg(sc.pillars.momentum, "#f59e0b"));
  const mMetrics = el("div", "ev-metrics");
  mMetrics.appendChild(
    buildEvidenceMetricRow(
      "Piotroski F-Score",
      "Target: ≥ 7 / 9 institutional grade",
      `${m.piotroski_f_score} / 9`,
      m.piotroski_f_score >= 7 ? "text-pos" : m.piotroski_f_score <= 4 ? "text-neg" : ""
    )
  );
  const ownVal = us
    ? `Inst ${m.inst_pct}%${m.promoter_pct > 0 ? ` • Insider ${m.promoter_pct}%` : ""}`
    : `Prom ${m.promoter_pct}% • Inst ${m.inst_pct}% (4Q Δ ${fmtSigned(m.inst_chg_1y_pct)}%)`;
  mMetrics.appendChild(
    buildEvidenceMetricRow(
      us ? "Institutional & Insider Ownership" : "Promoter & Institutional Ownership",
      "Long-term alignment & 4Q flow",
      ownVal
    )
  );
  mMetrics.appendChild(
    buildEvidenceMetricRow(
      "12M-1M Momentum & Volatility",
      "Target: Steady trend • Vol ≤ 30%",
      `${fmtSigned(m.mom_12_1_pct)}% Mom • ${m.volatility_pct}% Vol`,
      m.mom_12_1_pct >= 0 ? "text-pos" : "text-warn"
    )
  );
  mCard.appendChild(mMetrics);

  if (sc.piotroski_checks && sc.piotroski_checks.length > 0) {
    const checksWrap = el("div", "fscore-checks-wrap");
    for (const chk of sc.piotroski_checks) {
      checksWrap.appendChild(el("span", "check-pill", `✓ ${chk}`));
    }
    mCard.appendChild(checksWrap);
  }
  evGrid.appendChild(mCard);
  container.appendChild(evGrid);

  // e1) 5-Year Price Chart
  const chartCard = el("div", "dd-section-card");
  chartCard.appendChild(
    el(
      "div",
      "dd-section-title",
      `5-Year Historical Price Trajectory (${us ? "NASDAQ · USD $" : "NSE · INR ₹"})`
    )
  );
  chartCard.appendChild(
    el("div", "dd-section-sub", "Daily adjusted close history used for point-in-time valuation & momentum")
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
        color: us ? "#818cf8" : "#38bdf8",
        areaFill: us ? "rgba(129, 140, 248, 0.14)" : "rgba(56, 189, 248, 0.12)",
      },
    ],
    ph.map((p) => p.trade_date),
    (v) => formatStockPrice(v, ccy),
    { height: 185 }
  );

  // e2) 6-Year Audited Financials Table
  const finCard = el("div", "dd-section-card");
  finCard.appendChild(
    el(
      "div",
      "dd-section-title",
      `6-Year Audited Consolidated Financials (${us ? "USD Millions · $M" : "INR Crores · ₹Cr"})`
    )
  );
  finCard.appendChild(
    el(
      "div",
      "dd-section-sub",
      us
        ? "Official SEC EDGAR XBRL 10-K audited annual statements"
        : "Audited consolidated NSE annual filings"
    )
  );

  const fTableWrap = el("div", "table-scroll");
  const fTable = el("table", "quant-table");
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  const unitTag = us ? "($M)" : "(₹Cr)";
  for (const col of [
    "FY",
    `Sales ${unitTag}`,
    `EBITDA ${unitTag}`,
    `PAT ${unitTag}`,
    sc.is_financial ? "ROE %" : "ROCE %",
    "OPM %",
    sc.is_financial ? "D/E" : "CFO/EBITDA",
  ]) {
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
    r.appendChild(
      el(
        "td",
        "",
        sc.is_financial ? `${f.debt_to_equity}x` : `${Math.round(Number(f.cfo_to_ebitda_pct || 0))}%`
      )
    );
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
  const isUsdMode = state.plannerMarket === "US";
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
    btn.textContent = state.plannerMarket === "US" ? "Build $ Blueprint" : "Build ₹ Blueprint";
    btn.disabled = false;
  }
}

function renderPlannerResults(plan) {
  const planCcy = plan.plan_currency || (state.plannerMarket === "US" ? "USD" : "INR");
  const g = plan.goal_summary || {};
  const d = plan.deployment_summary || {};
  const kpis = document.getElementById("pl-kpis");
  kpis.replaceChildren();

  const basketTitle = document.getElementById("pl-basket-title");
  if (state.plannerMarket === "US") {
    basketTitle.textContent = "Recommended US Nasdaq-100 Buy Basket — Where to Invest & Why";
  } else if (state.plannerMarket === "IN") {
    basketTitle.textContent = "Recommended Indian NSE Buy Basket — Where to Invest & Why";
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
      el("span", "sector-sub", `P/E ${s.pe_ratio}x vs Fair ~${s.fair_pe}x`)
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

    // 8. Deep Dive Button
    const ddTd = document.createElement("td");
    const ddBtn = el("button", "btn-deep-dive", "Deep Dive →");
    ddBtn.type = "button";
    ddBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openDeepDive(s.ticker);
    });
    ddTd.appendChild(ddBtn);
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
    const isUsBt = state.backtestMarket === "US";
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
  const btCcy = s.currency || (state.backtestMarket === "US" ? "USD" : "INR");
  const bmName =
    s.benchmark_name || (btCcy === "USD" ? "Nasdaq 100 (^NDX)" : "Nifty 50 (^NSEI)");
  const bmShort = bmName.includes("Nasdaq") ? "Nasdaq 100" : "Nifty 50";
  const initLabel = btCcy === "USD" ? "$10,000" : "₹5,00,000";

  document.getElementById("bt-equity-title").textContent =
    `${initLabel} Wealth Growth vs. ${bmName}`;
  document.getElementById("bt-bm-legend").textContent = `${bmShort} Benchmark`;
  document.getElementById("bt-ledger-sub").textContent =
    `Point-in-time period returns vs. ${bmShort}`;
  document.getElementById("bt-ledger-bm-th").textContent = bmShort;

  document.getElementById("bt-guardrail-note").textContent =
    btCcy === "USD"
      ? `Bias Guardrails Active: 60-day SEC 10-K/10-Q point-in-time reporting lag enforced • 25 bps US execution slippage/friction per turnover • ${
          s.risk_free_rate_pct || 4.3
        }% US 10Y Treasury Sharpe risk-free rate.`
      : `Bias Guardrails Active: 60-day SEBI LODR reporting lag enforced on annual statements • 25 bps delivery friction/slippage per turnover • ${
          s.risk_free_rate_pct || 6.8
        }% India 10Y G-Sec Sharpe risk-free rate.`;

  const kpis = document.getElementById("bt-kpis");
  kpis.replaceChildren();

  kpis.appendChild(
    buildKpiCard(
      `Strategy CAGR (${state.backtestMarket === "US" ? "Nasdaq-100" : state.backtestMarket === "IN" ? "NSE" : "Global"})`,
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

// --- Event Listeners ---

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("auth-form").addEventListener("submit", handleAuthSubmit);
  document.getElementById("logout-btn").addEventListener("click", handleLogout);

  for (const tabBtn of document.querySelectorAll(".nav-tab")) {
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

  // Planner & Backtest Controls
  document.getElementById("run-planner-btn").addEventListener("click", runPlanner);
  document.getElementById("run-backtest-btn").addEventListener("click", runBacktest);

  // Slide-Over Deep Dive Drawer Controls
  document.getElementById("dd-close-btn").addEventListener("click", closeDeepDive);
  document.getElementById("deep-dive-backdrop").addEventListener("click", closeDeepDive);
  document.getElementById("dd-prev-btn").addEventListener("click", () => stepDeepDive(-1));
  document.getElementById("dd-next-btn").addEventListener("click", () => stepDeepDive(1));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && state.drawerOpen) {
      closeDeepDive();
    }
  });

  initAuth();
});
