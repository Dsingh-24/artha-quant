// ArthaQuant Frontend Controller
// Security guarantees:
// - Zero innerHTML / outerHTML / insertAdjacentHTML / document.write
// - Zero localStorage / sessionStorage token persistence (in-memory CSRF + HttpOnly session cookie)
// - Zero native alert() / confirm() / prompt() modals

import { createProgressSvg, formatINRCompact, renderMultiLineChart } from "/static/charts.js";
import {
  getCompanyDetailSnapshot,
  importCsvInMemory,
  runBacktestSnapshot,
  runPlannerSnapshot,
  runScreenerSnapshot,
} from "/static/standalone_engine.js";

const state = {
  staticMode: false,
  csrfToken: null,
  needsSetup: false,
  username: null,
  funnelView: "stage2", // "stage2" (deep fundamentals) or "stage1" (all 200 bulk funnel)
  stocks: [],
  stage1Funnel: [],
  selectedTicker: null,
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

function ratingBadgeClass(rating) {
  if (rating === "Strong Buy") return "badge badge-strong-buy";
  if (rating === "Buy") return "badge badge-buy";
  if (rating === "Hold") return "badge badge-hold";
  return "badge badge-avoid";
}

function buildKpiCard(label, value, sub, valueColorClass = "") {
  const card = el("div", "kpi-card");
  card.appendChild(el("div", "kpi-label", label));
  card.appendChild(el("div", `kpi-value ${valueColorClass}`.trim(), value));
  if (sub) card.appendChild(el("div", "kpi-sub", sub));
  return card;
}

// --- Auth & Session Bootstrapping ---

async function initAuth() {
  try {
    const status = await apiRequest("/api/auth/status");
    state.csrfToken = status.csrf_token;
    state.needsSetup = Boolean(status.needs_setup);

    if (status.authenticated) {
      state.username = status.username;
      enterWorkspace();
    } else {
      showAuthGate();
    }
  } catch (_err) {
    // Seamless fallback to Netlify / Static Cloud Snapshot Mode when FastAPI is not mounted
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
    enterWorkspace();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  }
}

async function handleLogout() {
  try {
    await apiRequest("/api/auth/logout", { method: "POST", jsonBody: {} });
  } catch (_e) {
    // Full state reset regardless
  }
  state.csrfToken = null;
  state.username = null;
  state.stocks = [];
  window.location.href = "/";
}

async function enterWorkspace() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("user-badge").textContent = state.staticMode
    ? "Mode: Cloud Snapshot (195 NSE Audited)"
    : `Advisor: ${state.username}`;
  await loadScreener(true);
}

// --- Tab Switching ---

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

// --- Tab 1: Two-Stage Funnel & Deep Fundamental Screener ---

function currentScreenerPayload() {
  const preset = document.getElementById("screener-preset").value;
  const sector = document.getElementById("screener-sector").value;
  const minScore = Number(document.getElementById("screener-min-score").value || 0);
  const payload = { preset, sector, min_score: minScore };

  if (preset === "custom") {
    payload.weights = {
      quality: Number(document.getElementById("w-quality").value || 35),
      value: Number(document.getElementById("w-value").value || 25),
      growth: Number(document.getElementById("w-growth").value || 20),
      momentum: Number(document.getElementById("w-momentum").value || 20),
    };
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

    document.getElementById("market-status-line").textContent =
      `Nifty 50 (^NSEI): ${Number(data.benchmark_nifty50).toLocaleString("en-IN")}  •  Live NSE Date: ${data.as_of_date}  •  Funnel: ${data.total_stage1_scanned} Bulk Scanned → ${data.total_deep_scored} Deep Scored`;

    document.getElementById("funnel-stage1-pill").textContent =
      `Stage 1 Bulk Scan: ${data.total_stage1_scanned} Nifty-200 Stocks`;
    document.getElementById("funnel-stage2-pill").textContent =
      `Stage 2 Deep Scored: ${data.total_deep_scored} Shortlisted Stocks`;

    const expandBtn = document.getElementById("expand-funnel-btn");
    if (data.unscored_funnel_remaining > 0) {
      expandBtn.textContent = `+ Deep-Score Next ${Math.min(30, data.unscored_funnel_remaining)} (${data.unscored_funnel_remaining} left)`;
      expandBtn.disabled = false;
    } else {
      expandBtn.textContent = "All 200 Stocks Deep-Scored ✓";
      expandBtn.disabled = true;
    }

    if (populateSectors) {
      const sel = document.getElementById("screener-sector");
      const cur = sel.value;
      sel.replaceChildren(el("option", "", "All Indian Sectors"));
      sel.firstChild.value = "ALL";
      for (const sec of data.sectors) {
        const opt = el("option", "", sec);
        opt.value = sec;
        sel.appendChild(opt);
      }
      sel.value = cur || "ALL";
    }

    renderScreenerKpis(data);
    renderActiveFunnelTable();

    if (state.stocks.length > 0) {
      const targetTicker =
        state.selectedTicker && state.stocks.some((s) => s.ticker === state.selectedTicker)
          ? state.selectedTicker
          : state.stocks[0].ticker;
      await selectCompany(targetTicker);
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

function setFunnelView(mode) {
  state.funnelView = mode;
  const s2Btn = document.getElementById("view-stage2-btn");
  const s1Btn = document.getElementById("view-stage1-btn");
  s2Btn.className = mode === "stage2" ? "btn btn-primary" : "btn btn-ghost";
  s1Btn.className = mode === "stage1" ? "btn btn-primary" : "btn btn-ghost";
  renderActiveFunnelTable();
}

function renderScreenerKpis(data) {
  const kpis = document.getElementById("screener-kpis");
  kpis.replaceChildren();
  const rc = data.rating_counts || {};
  const topPick = (data.stocks || [])[0];

  kpis.appendChild(
    buildKpiCard(
      "Nifty 200 Funnel Coverage",
      `${data.total_stage1_scanned} → ${data.total_deep_scored}`,
      "Stage-1 Bulk Price/Mom → Stage-2 Audited Financials",
      "text-cyan"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Strong Buy Ideas",
      String(rc["Strong Buy"] || 0),
      `+${rc["Buy"] || 0} Accumulate / Buy`,
      "text-pos"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Hold / Core Watchlist",
      String(rc["Hold"] || 0),
      `Avoid / Red-Flagged: ${rc["Avoid"] || 0}`,
      "text-warn"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "#1 Rated Opportunity",
      topPick ? topPick.ticker.replace(".NS", "") : "—",
      topPick ? `Score ${topPick.composite_score}/100 • CMP ₹${topPick.price.toLocaleString("en-IN")}` : "No matches",
      "text-pos"
    )
  );
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

function renderActiveFunnelTable() {
  if (state.funnelView === "stage1") {
    renderStage1Table(state.stage1Funnel);
  } else {
    renderStage2Table(state.stocks);
  }
}

function renderStage2Table(stocks) {
  document.getElementById("table-panel-title").textContent =
    `Stage 2: Deep Fundamental Ratings (${stocks.length} Real Consolidated NSE Companies)`;
  document.getElementById("table-panel-sub").textContent =
    "Scored on 8Y Anti-Cyclical Moat, Latest 2Q YoY Earnings, 4Q Inst Trend, GARP Fair P/E & Piotroski";

  setTableHeaders([
    "#",
    "Company",
    "Rating",
    "Score",
    "Qual",
    "Moat Stab",
    "5Y ROCE",
    "P/E (Fair)",
    "2Q PAT YoY",
    "4Q Inst Δ",
    "F-Score",
  ]);

  const tbody = document.getElementById("screener-tbody");
  tbody.replaceChildren();

  for (const s of stocks) {
    const tr = document.createElement("tr");
    tr.dataset.ticker = s.ticker;
    if (s.ticker === state.selectedTicker) tr.classList.add("selected-row");

    tr.appendChild(el("td", "", s.rank));

    const compTd = document.createElement("td");
    compTd.appendChild(el("span", "ticker-cell", s.ticker.replace(".NS", "")));
    compTd.appendChild(el("span", "sector-sub", `${s.name} • ${s.sector}`));
    tr.appendChild(compTd);

    const rateTd = document.createElement("td");
    rateTd.appendChild(el("span", ratingBadgeClass(s.rating), s.rating));
    tr.appendChild(rateTd);

    tr.appendChild(el("td", "ticker-cell", s.composite_score.toFixed(1)));
    tr.appendChild(el("td", "", s.pillars.quality.toFixed(0)));

    const stab = s.metrics.moat_stability_score !== undefined ? s.metrics.moat_stability_score : 70;
    tr.appendChild(el("td", stab >= 70 ? "text-pos" : stab < 45 ? "text-warn" : "", `${stab}/100`));

    const medRoce = s.metrics.med_5y_roce_pct !== undefined ? s.metrics.med_5y_roce_pct : s.metrics.roce_pct;
    tr.appendChild(el("td", medRoce >= 18 ? "text-pos" : "", `${medRoce}%`));

    const peText =
      s.metrics.pe_ratio >= 99
        ? "N/M"
        : `${s.metrics.pe_ratio}x (~${s.metrics.fair_pe}x)`;
    tr.appendChild(
      el(
        "td",
        s.metrics.pe_ratio <= s.metrics.fair_pe * 1.1 ? "text-pos" : s.metrics.pe_ratio > 56 ? "text-warn" : "",
        peText
      )
    );

    const qPat = s.metrics.qtr_pat_yoy_pct !== undefined ? s.metrics.qtr_pat_yoy_pct : s.metrics.pat_cagr_3y_pct;
    tr.appendChild(
      el(
        "td",
        qPat >= 12 ? "text-pos" : qPat < 0 ? "text-neg" : "",
        `${qPat > 0 ? "+" : ""}${qPat}%`
      )
    );

    const instChg = s.metrics.inst_chg_1y_pct || 0;
    tr.appendChild(
      el(
        "td",
        instChg >= 0.8 ? "text-pos" : instChg <= -2.0 ? "text-neg" : "muted-note",
        `${instChg > 0 ? "+" : ""}${instChg}%`
      )
    );

    tr.appendChild(el("td", "", `${s.metrics.piotroski_f_score}/9`));

    tr.addEventListener("click", () => selectCompany(s.ticker));
    tbody.appendChild(tr);
  }
}

function renderStage1Table(rows) {
  document.getElementById("table-panel-title").textContent =
    `Stage 1: Bulk Nifty-200 Quant Funnel (${rows.length} Liquid NSE Stocks)`;
  document.getElementById("table-panel-sub").textContent =
    "Ranked by Momentum, 6M Relative Strength, 200-DMA Trend & Liquidity — click Deep Score on any unscored stock";

  setTableHeaders([
    "S1 #",
    "Company",
    "S1 Quant Score",
    "Stage-2 Status",
    "CMP (₹)",
    "12M-1M Mom",
    "6M Ret",
    "vs 52W High",
    "200-DMA",
    "Vol%",
    "Mom/Vol",
  ]);

  const tbody = document.getElementById("screener-tbody");
  tbody.replaceChildren();

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.dataset.ticker = r.ticker;

    tr.appendChild(el("td", "", r.stage1_rank));
    const compTd = document.createElement("td");
    compTd.appendChild(el("span", "ticker-cell", r.ticker.replace(".NS", "")));
    compTd.appendChild(el("span", "sector-sub", `${r.name} • ${r.sector}`));
    tr.appendChild(compTd);

    tr.appendChild(el("td", "ticker-cell text-cyan", r.stage1_score.toFixed(1)));

    const statusTd = document.createElement("td");
    if (r.deep_scored) {
      statusTd.appendChild(el("span", "badge badge-strong-buy", "Deep Scored ✓"));
      tr.addEventListener("click", () => selectCompany(r.ticker));
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

    tr.appendChild(el("td", "", `₹${Number(r.last_price).toLocaleString("en-IN")}`));
    tr.appendChild(
      el("td", r.mom_12_1_pct >= 0 ? "text-pos" : "text-neg", `${r.mom_12_1_pct > 0 ? "+" : ""}${r.mom_12_1_pct}%`)
    );
    tr.appendChild(
      el("td", r.ret_6m_pct >= 0 ? "text-pos" : "text-neg", `${r.ret_6m_pct > 0 ? "+" : ""}${r.ret_6m_pct}%`)
    );
    tr.appendChild(el("td", "", `${r.dist_52w_high_pct}%`));
    tr.appendChild(el("td", r.above_200dma ? "text-pos" : "text-warn", r.above_200dma ? "Above ✓" : "Below"));
    tr.appendChild(el("td", "", `${r.volatility_pct}%`));
    tr.appendChild(el("td", "", String(r.avg_turnover_cr)));

    tbody.appendChild(tr);
  }
}

async function selectCompany(ticker) {
  state.selectedTicker = ticker;
  for (const row of document.querySelectorAll("#screener-tbody tr")) {
    row.classList.toggle("selected-row", row.dataset.ticker === ticker);
  }

  const preset = document.getElementById("screener-preset").value;
  try {
    const detail = state.staticMode
      ? await getCompanyDetailSnapshot(ticker, preset)
      : await apiRequest(
          `/api/company/${encodeURIComponent(ticker)}?preset=${encodeURIComponent(preset)}`
        );
    renderCompanyDetail(detail);
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderCompanyDetail(detail) {
  const container = document.getElementById("company-detail-content");
  container.replaceChildren();
  const sc = detail.scorecard;
  if (!sc) return;

  const top = el("div", "detail-top");
  const left = document.createElement("div");
  left.appendChild(el("h2", "", `${sc.name} (${sc.ticker})`));
  const ownDelta =
    sc.metrics.inst_chg_1y_pct || sc.metrics.promoter_chg_1y_pct
      ? ` (4Q Δ: Prom ${sc.metrics.promoter_chg_1y_pct > 0 ? "+" : ""}${sc.metrics.promoter_chg_1y_pct}%, Inst ${sc.metrics.inst_chg_1y_pct > 0 ? "+" : ""}${sc.metrics.inst_chg_1y_pct}%)`
      : "";
  const npaInfo =
    sc.is_financial && sc.metrics.gnpa_pct > 0
      ? ` • GNPA ${sc.metrics.gnpa_pct}% / NNPA ${sc.metrics.nnpa_pct}%`
      : "";
  const ownText =
    sc.metrics.promoter_pct > 0 || sc.metrics.inst_pct > 0
      ? ` • Prom ${sc.metrics.promoter_pct}% | FII+DII ${sc.metrics.inst_pct}%${ownDelta}${npaInfo}`
      : npaInfo;
  left.appendChild(
    el(
      "div",
      "muted-note",
      `${sc.sector} • MCap ${formatINRCompact(sc.market_cap_cr * 10000000)}${ownText}`
    )
  );
  const badgeWrap = el("div", "top-gap");
  badgeWrap.appendChild(el("span", ratingBadgeClass(sc.rating), `${sc.rating} (${sc.composite_score}/100)`));
  const peDisplay =
    sc.metrics.pe_ratio >= 99
      ? "N/M"
      : `${sc.metrics.pe_ratio}x (Fair ~${sc.metrics.fair_pe}x)`;
  const qtrBadge = sc.metrics.latest_qtr_label
    ? ` • 2Q PAT ${sc.metrics.qtr_pat_yoy_pct > 0 ? "+" : ""}${sc.metrics.qtr_pat_yoy_pct}% (${sc.metrics.latest_qtr_label})`
    : "";
  badgeWrap.appendChild(
    el(
      "span",
      "muted-note",
      `  Moat Stab ${sc.metrics.moat_stability_score}/100 • P/E ${peDisplay}${qtrBadge}`
    )
  );
  left.appendChild(badgeWrap);

  const right = document.createElement("div");
  right.appendChild(el("div", "detail-price", `₹${sc.price.toLocaleString("en-IN")}`));
  right.appendChild(
    el(
      "div",
      sc.valuation_zone && sc.valuation_zone.includes("Overvalued")
        ? "kpi-sub text-warn"
        : "kpi-sub text-pos",
      sc.valuation_zone || `5Y Profitable: ${sc.metrics.profit_consistency || "5/5"}`
    )
  );
  top.appendChild(left);
  top.appendChild(right);
  container.appendChild(top);

  const pGrid = el("div", "pillar-grid");
  const pillars = [
    ["8Y Moat & Cash Quality", sc.pillars.quality, "#10b981"],
    ["GARP & Cyclical Fair P/E", sc.pillars.value, "#38bdf8"],
    ["5Y + Latest 2Q Growth", sc.pillars.growth, "#6366f1"],
    ["Piotroski & 4Q Inst Flow", sc.pillars.momentum, "#f59e0b"],
  ];
  for (const [title, val, color] of pillars) {
    const box = el("div", "pillar-item");
    const row = el("div", "pillar-row");
    row.appendChild(el("span", "", title));
    row.appendChild(el("span", "", `${val.toFixed(0)}/100`));
    box.appendChild(row);
    box.appendChild(createProgressSvg(val, color));
    pGrid.appendChild(box);
  }
  container.appendChild(pGrid);

  const chartBox = el("div", "chart-box-sm");
  container.appendChild(chartBox);
  const ph = detail.price_history || [];
  renderMultiLineChart(
    chartBox,
    [
      {
        name: sc.ticker,
        values: ph.map((p) => p.close_price),
        color: "#38bdf8",
        areaFill: "rgba(56, 189, 248, 0.12)",
      },
    ],
    ph.map((p) => p.trade_date),
    (v) => `₹${Math.round(v).toLocaleString("en-IN")}`,
    { height: 165 }
  );

  const thesisBox = el("div", "thesis-box");
  thesisBox.appendChild(el("div", "thesis-title text-pos", "Institutional Bull Thesis & Moats"));
  const sList = el("ul", "thesis-list");
  for (const item of sc.strengths) {
    sList.appendChild(el("li", "", `✓ ${item}`));
  }
  thesisBox.appendChild(sList);
  container.appendChild(thesisBox);

  if (sc.red_flags && sc.red_flags.length > 0) {
    const flagBox = el("div", "thesis-box");
    flagBox.appendChild(el("div", "thesis-title text-neg", "Forensic & Valuation Guardrail Alerts"));
    const fList = el("ul", "thesis-list");
    for (const item of sc.red_flags) {
      fList.appendChild(el("li", "text-neg", `⚠ ${item}`));
    }
    flagBox.appendChild(fList);
    container.appendChild(flagBox);
  }

  const fTableWrap = el("div", "table-scroll");
  const fTable = el("table", "quant-table");
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const col of [
    "FY",
    "Sales (₹Cr)",
    "PAT (₹Cr)",
    sc.is_financial ? "ROE%" : "ROCE%",
    sc.is_financial ? "D/E" : "CFO/EBITDA",
  ]) {
    htr.appendChild(el("th", "", col));
  }
  thead.appendChild(htr);
  fTable.appendChild(thead);

  const ftbody = document.createElement("tbody");
  for (const f of (detail.fundamentals || []).slice(-6)) {
    const r = document.createElement("tr");
    r.appendChild(el("td", "ticker-cell", `FY${String(f.fiscal_year).slice(-2)}`));
    r.appendChild(el("td", "", Math.round(f.revenue_cr).toLocaleString("en-IN")));
    r.appendChild(
      el("td", f.net_profit_cr < 0 ? "text-neg" : "", Math.round(f.net_profit_cr).toLocaleString("en-IN"))
    );
    r.appendChild(el("td", "", `${sc.is_financial ? f.roe_pct : f.roce_pct}%`));
    r.appendChild(
      el("td", "", sc.is_financial ? `${f.debt_to_equity}x` : `${Math.round(f.cfo_to_ebitda_pct)}%`)
    );
    ftbody.appendChild(r);
  }
  fTable.appendChild(ftbody);
  fTableWrap.appendChild(fTable);
  container.appendChild(fTableWrap);
}

// --- Funnel Actions, Live Sync & CSV Import ---

async function syncSpecificTicker(rawTicker) {
  if (state.staticMode) {
    showToast(
      "Cloud Snapshot Mode: Run the local FastAPI engine (uvicorn app.main:app) to scrape live NSE/Screener tickers."
    );
    return;
  }
  try {
    const res = await apiRequest("/api/sync/ticker", {
      method: "POST",
      jsonBody: { ticker: rawTicker },
    });
    showToast(
      `Deep-synced ${res.sync.ticker} (${res.sync.name}): ${res.sync.price_days_synced} price days, ${res.sync.fundamental_years_synced} audited FYs.`
    );
    state.selectedTicker = res.sync.ticker;
    state.backtestLoaded = false;
    state.plannerLoaded = false;
    await loadScreener(true);
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
  btn.textContent = "Deep Sync";
  btn.disabled = false;
}

async function handleFastPriceRefresh() {
  if (state.staticMode) {
    showToast(
      "Cloud Snapshot Mode: Live Yahoo Finance spark batch refresh requires the local FastAPI backend."
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
      `Weekly Price Sync Complete: Updated ${res.tickers_refreshed} NSE stocks (${res.spark_batch_calls} Yahoo batch calls, 0 Screener calls).`
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
    showToast("Cloud Snapshot Mode: 195 of 200 Nifty-200 stocks are already pre-scored in this snapshot.");
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
      `Deep-scored ${res.companies_deep_scored} additional Nifty-200 candidates (${res.annual_rows_saved} audited FY statements).`
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
      "Cloud Snapshot Mode: Run `uvicorn app.main:app` locally to trigger live NSE + Screener.in funnel sync."
    );
    return;
  }
  const btn = document.getElementById("refresh-funnel-btn");
  btn.textContent = "Syncing Funnel...";
  btn.disabled = true;
  showToast("Refreshing Nifty 200 prices & checking stale fundamentals (7-day TTL cache active)...");
  try {
    const res = await apiRequest("/api/funnel/refresh", {
      method: "POST",
      jsonBody: { shortlist_top_n: 60 },
    });
    showToast(
      `Synced ${res.stage1_scanned} Nifty-200 stocks & verified/updated ${res.stage2_deep_scored} companies!`
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

// --- Tab 2: Point-in-Time Backtester ---

async function runBacktest() {
  const btn = document.getElementById("run-backtest-btn");
  btn.textContent = "Simulating...";
  btn.disabled = true;

  try {
    const payload = {
      preset: document.getElementById("bt-preset").value,
      lookback_years: Number(document.getElementById("bt-years").value),
      top_n: Number(document.getElementById("bt-topn").value),
      rebalance: document.getElementById("bt-rebal").value,
      weighting: document.getElementById("bt-weight").value,
      initial_capital: 500000,
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
  const s = res.summary;
  const kpis = document.getElementById("bt-kpis");
  kpis.replaceChildren();

  kpis.appendChild(
    buildKpiCard(
      "Strategy CAGR (Real NSE)",
      `${s.portfolio_cagr_pct}%`,
      `vs Nifty 50: ${s.benchmark_cagr_pct}% (${s.start_date} → ${s.end_date})`,
      s.portfolio_cagr_pct >= s.benchmark_cagr_pct ? "text-pos" : "text-warn"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Annualized Alpha",
      `${s.alpha_annual_pct > 0 ? "+" : ""}${s.alpha_annual_pct}%`,
      `Info Ratio: ${s.information_ratio} • Win Rate: ${s.win_rate_pct}%`,
      s.alpha_annual_pct >= 0 ? "text-pos" : "text-neg"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Sharpe Ratio (Rf 6.8%)",
      String(s.sharpe_ratio),
      `Sortino: ${s.sortino_ratio} • Nifty Sharpe: ${s.benchmark_sharpe}`,
      "text-cyan"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Max Drawdown",
      `${s.max_drawdown_pct}%`,
      `Nifty Max DD: ${s.benchmark_max_dd_pct}% • Beta: ${s.beta}`,
      "text-neg"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "₹5.00 L Grown To",
      formatINRCompact(s.final_portfolio_inr),
      `Nifty 50 Passive: ${formatINRCompact(s.final_benchmark_inr)}`,
      "text-pos"
    )
  );

  const curve = res.equity_curve || [];
  const dates = curve.map((c) => c.date);

  renderMultiLineChart(
    document.getElementById("bt-equity-chart"),
    [
      {
        name: "Nifty 50",
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
    (v) => formatINRCompact(v)
  );

  renderMultiLineChart(
    document.getElementById("bt-dd-chart"),
    [
      {
        name: "Nifty DD",
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
    tr.appendChild(el("td", "ticker-cell", h.ticker.replace(".NS", "")));
    tr.appendChild(el("td", "", h.name));
    tr.appendChild(el("td", "", h.sector));
    const rTd = document.createElement("td");
    rTd.appendChild(el("span", ratingBadgeClass(h.rating), h.rating));
    tr.appendChild(rTd);
    tr.appendChild(el("td", "", h.composite_score.toFixed(1)));
    tr.appendChild(el("td", "ticker-cell", `${h.weight_pct.toFixed(1)}%`));
    hBody.appendChild(tr);
  }

  const lBody = document.getElementById("bt-ledger-tbody");
  lBody.replaceChildren();
  for (const row of res.rebalance_log || []) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", "", `${row.rebalance_date} → ${row.end_date}`));
    tr.appendChild(el("td", "muted-note", row.top_picks.join(", ")));
    tr.appendChild(el("td", "", `${row.turnover_pct}%`));
    tr.appendChild(
      el("td", row.period_return_pct >= 0 ? "text-pos" : "text-neg", `${row.period_return_pct}%`)
    );
    tr.appendChild(el("td", "", `${row.benchmark_return_pct}%`));
    tr.appendChild(
      el(
        "td",
        row.excess_return_pct >= 0 ? "text-pos" : "text-neg",
        `${row.excess_return_pct > 0 ? "+" : ""}${row.excess_return_pct}%`
      )
    );
    lBody.appendChild(tr);
  }
}

// --- Tab 2: Deploy Capital Today & Long-Term Wealth Advisor ---

async function runPlanner() {
  const btn = document.getElementById("run-planner-btn");
  btn.textContent = "Building Blueprint...";
  btn.disabled = true;

  try {
    const payload = {
      lump_sum_inr: Number(document.getElementById("pl-lumpsum").value || 0),
      monthly_sip_inr: Number(document.getElementById("pl-sip").value || 0),
      horizon_years: Number(document.getElementById("pl-horizon").value || 7),
      target_corpus_inr: Number(document.getElementById("pl-target").value || 1300000),
      risk_profile: document.getElementById("pl-risk").value,
      preset:
        document.getElementById("screener-preset").value === "custom"
          ? "qglp_compounder"
          : document.getElementById("screener-preset").value,
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
    btn.textContent = "Build ₹ Deployment Plan";
    btn.disabled = false;
  }
}

function renderPlannerResults(plan) {
  const g = plan.goal_summary;
  const d = plan.deployment_summary || {};
  const kpis = document.getElementById("pl-kpis");
  kpis.replaceChildren();

  kpis.appendChild(
    buildKpiCard(
      "Equity Allocated in Shares",
      formatINRCompact(d.deployed_in_shares_inr || 0),
      `${d.sectors_covered || 0} NSE Sectors • Unallocated Cash: ₹${Number(d.residual_cash_inr || 0).toLocaleString("en-IN")}`,
      "text-pos"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Entry Tranche Strategy",
      `${formatINRCompact(d.immediate_tranche_inr || 0)} Now`,
      d.staggered_dip_reserve_inr > 0
        ? `+ ${formatINRCompact(d.staggered_dip_reserve_inr)} held for 6–8% pullbacks`
        : "100% within Fair GARP P/E band — deploy today",
      "text-cyan"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Expected Median Corpus",
      formatINRCompact(g.median_corpus_inr),
      `Bear 10th: ${formatINRCompact(g.bear_10_corpus_inr)} → Bull 90th: ${formatINRCompact(g.bull_90_corpus_inr)}`,
      "text-pos"
    )
  );
  kpis.appendChild(
    buildKpiCard(
      "Goal Achievement Odds",
      `${g.goal_probability_pct}%`,
      g.recommended_extra_sip_inr > 0
        ? `Target ${formatINRCompact(g.target_corpus_inr)} • Add +${formatINRCompact(g.recommended_extra_sip_inr)}/mo SIP`
        : `On track for ${formatINRCompact(g.target_corpus_inr)} (${plan.expected_cagr_pct}% Est. CAGR)`,
      g.goal_probability_pct >= 60 ? "text-pos" : "text-warn"
    )
  );

  const bBody = document.getElementById("pl-basket-tbody");
  bBody.replaceChildren();
  for (const s of plan.stock_basket || []) {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.appendChild(el("span", "ticker-cell", `${s.ticker.replace(".NS", "")} — ${s.name}`));
    nameTd.appendChild(el("span", "sector-sub", `${s.sector} • ${s.role}`));
    tr.appendChild(nameTd);

    const rTd = document.createElement("td");
    rTd.appendChild(el("span", ratingBadgeClass(s.rating), s.rating));
    tr.appendChild(rTd);

    tr.appendChild(el("td", "ticker-cell", s.composite_score.toFixed(1)));

    const cmpTd = document.createElement("td");
    cmpTd.appendChild(el("span", "ticker-cell", `₹${s.price.toLocaleString("en-IN")}`));
    cmpTd.appendChild(el("span", "sector-sub", `P/E ${s.pe_ratio}x vs Fair ~${s.fair_pe}x`));
    tr.appendChild(cmpTd);

    const allocTd = document.createElement("td");
    allocTd.appendChild(
      el("span", "ticker-cell text-pos", `₹${Number(s.lump_sum_inr).toLocaleString("en-IN")} (${s.est_shares} sh)`)
    );
    const subAlloc =
      s.monthly_sip_inr > 0
        ? `Weight ${s.equity_weight_pct}% • +₹${Number(s.monthly_sip_inr).toLocaleString("en-IN")}/mo SIP`
        : `Portfolio Weight: ${s.equity_weight_pct}%`;
    allocTd.appendChild(el("span", "sector-sub", subAlloc));
    tr.appendChild(allocTd);

    tr.appendChild(
      el(
        "td",
        s.entry_guidance.startsWith("Buy 100%") ? "text-pos" : "text-cyan",
        s.entry_guidance
      )
    );

    const whyTd = el("td", "cell-wrap");
    whyTd.appendChild(el("div", "", s.why_buy));
    if (s.strength_highlight) {
      whyTd.appendChild(el("span", "sector-sub text-pos", `✓ ${s.strength_highlight}`));
    }
    tr.appendChild(whyTd);

    tr.addEventListener("click", () => {
      switchTab("screener");
      selectCompany(s.ticker);
    });
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
    (v) => formatINRCompact(v)
  );

  document.getElementById("pl-profile-label").textContent = plan.profile_label;
  const assetContainer = document.getElementById("pl-asset-bars");
  assetContainer.replaceChildren();
  const colors = ["#10b981", "#38bdf8", "#6366f1", "#f59e0b"];
  (plan.asset_allocation || []).forEach((a, idx) => {
    const row = el("div", "asset-row");
    const top = el("div", "asset-row-top");
    top.appendChild(el("span", "", a.asset));
    top.appendChild(el("span", "text-cyan", `${a.pct}%`));
    row.appendChild(top);
    row.appendChild(createProgressSvg(a.pct, colors[idx % colors.length]));

    const meta = el("div", "asset-meta");
    meta.appendChild(el("span", "", `Allocation: ₹${Number(a.lump_sum_inr).toLocaleString("en-IN")}`));
    meta.appendChild(el("span", "", `Monthly SIP: ₹${Number(a.monthly_sip_inr).toLocaleString("en-IN")}/mo`));
    meta.appendChild(el("span", "", `Est. CAGR: ${a.expected_return}%`));
    row.appendChild(meta);
    assetContainer.appendChild(row);
  });
}

// --- Event Listeners ---

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("auth-form").addEventListener("submit", handleAuthSubmit);
  document.getElementById("logout-btn").addEventListener("click", handleLogout);

  for (const tabBtn of document.querySelectorAll(".nav-tab")) {
    tabBtn.addEventListener("click", () => switchTab(tabBtn.dataset.tab));
  }

  document.getElementById("view-stage2-btn").addEventListener("click", () => setFunnelView("stage2"));
  document.getElementById("view-stage1-btn").addEventListener("click", () => setFunnelView("stage1"));
  document.getElementById("fast-prices-btn").addEventListener("click", handleFastPriceRefresh);
  document.getElementById("expand-funnel-btn").addEventListener("click", handleExpandFunnel);
  document.getElementById("refresh-funnel-btn").addEventListener("click", handleRefreshFunnel);

  document.getElementById("screener-preset").addEventListener("change", (ev) => {
    const isCustom = ev.target.value === "custom";
    document.getElementById("custom-weights-row").classList.toggle("hidden", !isCustom);
    if (!isCustom) loadScreener(false);
  });
  document.getElementById("screener-sector").addEventListener("change", () => loadScreener(false));
  document.getElementById("screener-min-score").addEventListener("change", () => loadScreener(false));
  document.getElementById("apply-weights-btn").addEventListener("click", () => loadScreener(false));
  document.getElementById("sync-ticker-btn").addEventListener("click", handleLiveTickerSync);
  document.getElementById("csv-upload-btn").addEventListener("click", handleCsvUpload);

  document.getElementById("run-backtest-btn").addEventListener("click", runBacktest);
  document.getElementById("run-planner-btn").addEventListener("click", runPlanner);

  initAuth();
});
