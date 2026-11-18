// ArthaQuant V5.0 — Calm Sub-Tabbed Paper Wallet, Buy-on-Dip Book & Live FX UI
// Built exclusively with safe DOM creation (createElement, textContent, replaceChildren) and CSS classes.

import {
  createProgressSvg,
  formatCurrencyCompact,
  formatExactCurrency,
  formatStockPrice,
  renderMultiLineChart,
} from "/static/charts.js";
import {
  getIdentityStatus,
  getPaperUser,
  loginPaperUser,
  logoutPaperUser,
  maskUserIdentity,
  openPaperAuthModal,
  renderDynamicOAuthButtons,
  requestPaperPasswordReset,
} from "/static/auth_client.js";

const DEFAULT_USD_INR_FX = 93.44;
const AUTO_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const STALE_QUOTE_THRESHOLD_SEC = 300;
const UNQUOTED_SENTINEL_SEC = 900000;
const PAPER_SUBTABS = ["positions", "orders", "trades", "attribution"];

export const uiState = {
  activeSubtab: "positions",
};

const STRATEGY_LABELS = {
  qglp_compounder: "QGLP Compounder",
  street_quant: "Street + Quant",
  coffee_can: "Coffee-Can",
  magic_formula: "Magic Formula",
  artha_blend: "4-Factor Blend",
  value_momentum: "Value + Momentum",
};

const BENCHMARK_LABELS = {
  "^NSEI": "Nifty 50",
  "^GSPC": "S&P 500",
  "^NDX": "Nasdaq 100",
};

const WALLET_TEMPLATES = [
  {
    label: "India QGLP ₹5L",
    name: "India QGLP ₹5L",
    currency: "INR",
    cash: 500000,
    preset: "qglp_compounder",
    benchmark: "^NSEI",
  },
  {
    label: "India Street+Quant ₹10L",
    name: "India Street+Quant ₹10L",
    currency: "INR",
    cash: 1000000,
    preset: "street_quant",
    benchmark: "^NSEI",
  },
  {
    label: "US Dip Hunter $10K",
    name: "US Dip Hunter $10K",
    currency: "USD",
    cash: 10000,
    preset: "qglp_compounder",
    benchmark: "^GSPC",
  },
  {
    label: "Nasdaq Compounders $25K",
    name: "Nasdaq Compounders $25K",
    currency: "USD",
    cash: 25000,
    preset: "coffee_can",
    benchmark: "^NDX",
  },
];

const paperState = {
  initialized: false,
  loading: false,
  overview: null,
  overviewFetchedAtMs: 0,
  currentUser: null,
  activePortfolioId: null,
  activeSubtab: "positions",
  lastAutoRefreshMs: new Map(),
  autoRefreshInFlight: false,
  manualRefreshInFlight: false,
  sessionTickerTimerId: null,
  liveUsdInrFx: null,
  liveQuoteCache: new Map(),
  ticketQuoteReqSeq: 0,
  ticketQuoteSyncing: false,
  ticketActiveDipPct: -7,
  ticketSharesEditedByUser: false,
  ticketSide: "BUY",
  ticketOrderType: "LIMIT",
  ticketStock: null,
  pendingPlan: null,
  pendingDeployItems: [],
  // Callbacks injected by app.js
  getStaticMode: () => false,
  getCsrfToken: () => null,
  getAllStocks: () => [],
  findStockByTicker: () => null,
  openDeepDive: () => {},
  switchTab: () => {},
  showToast: () => {},
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function fmtSigned(val, decimals = 2) {
  const n = Number(val || 0);
  const s = n.toFixed(decimals);
  return n > 0 ? `+${s}` : s;
}

function displaySymbol(ticker) {
  return String(ticker || "").replace(".NS", "").replace(".BO", "");
}

function resolveStockCurrency(item) {
  if (!item) return "INR";
  if (item.native_currency) return item.native_currency;
  if (item.currency) return item.currency;
  const tag = String(item.index_tag || "").toUpperCase();
  if (tag === "NASDAQ100" || tag === "SP500" || item.market === "US") return "USD";
  const tk = String(item.ticker || "");
  if (tk && !tk.endsWith(".NS") && !tk.endsWith(".BO")) return "USD";
  return "INR";
}

function resolveIndexTag(item) {
  if (!item) return "NIFTY200";
  const tag = String(item.index_tag || "").toUpperCase();
  if (tag === "NASDAQ100" || tag === "SP500" || tag === "NIFTY200") return tag;
  return resolveStockCurrency(item) === "USD" ? "SP500" : "NIFTY200";
}

function createIndexBadge(item) {
  const tag = resolveIndexTag(item);
  if (tag === "NASDAQ100") {
    return el("span", "tag-market tag-market-nasdaq", "NASDAQ 100");
  }
  if (tag === "SP500") {
    return el("span", "tag-market tag-market-sp500", "S&P 500");
  }
  return el("span", "tag-market tag-market-in", "NIFTY 200");
}

function ratingBadgeClass(rating) {
  if (rating === "Strong Buy") return "badge badge-strong-buy";
  if (rating === "Buy") return "badge badge-buy";
  if (rating === "Hold") return "badge badge-hold";
  return "badge badge-avoid";
}

function resolveUsdInrFxRate() {
  const ov = paperState.overview;
  const apFx = ov && ov.active_portfolio ? Number(ov.active_portfolio.fx_usd_inr) : 0;
  if (Number.isFinite(apFx) && apFx > 1) return apFx;
  const topFx = ov ? Number(ov.fx_usd_inr) : 0;
  if (Number.isFinite(topFx) && topFx > 1) return topFx;
  const cachedFx = Number(paperState.liveUsdInrFx || 0);
  if (Number.isFinite(cachedFx) && cachedFx > 1) return cachedFx;
  return DEFAULT_USD_INR_FX;
}

function computeFxRate(stockCurrency, walletCurrency) {
  if (stockCurrency === walletCurrency) return 1.0;
  const usdInr = resolveUsdInrFxRate();
  if (stockCurrency === "USD" && walletCurrency === "INR") return usdInr;
  if (stockCurrency === "INR" && walletCurrency === "USD") return 1.0 / usdInr;
  return 1.0;
}

function formatShortTimestamp(isoStr) {
  const raw = String(isoStr || "").trim();
  if (!raw) return "—";
  const clean = raw.replace("T", " ").replace("Z", "");
  return clean.length > 16 ? clean.slice(0, 16) : clean;
}

function formatUtcSyncStamp(isoStr) {
  const raw = String(isoStr || "").trim();
  if (!raw) return "";
  const clean = raw
    .replace("T", " ")
    .replace(/\.\d+/, "")
    .replace("Z", "")
    .replace(/\+00:00$/, "")
    .trim();
  const short = clean.length > 16 ? clean.slice(0, 16) : clean;
  return short ? `${short} UTC` : "";
}

function computeClientMarketSessionUtc(nowUtc = new Date()) {
  const day = nowUtc.getUTCDay();
  const isWeekday = day >= 1 && day <= 5;
  const utcMinutes = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();
  // NSE live window: Mon-Fri 03:45-10:15 UTC (09:15-15:45 IST)
  const inMarketOpen = isWeekday && utcMinutes >= 3 * 60 + 45 && utcMinutes <= 10 * 60 + 15;
  // US live window: Mon-Fri 13:30-21:15 UTC (09:30 AM EDT - 04:15 PM EST)
  const usMarketOpen = isWeekday && utcMinutes >= 13 * 60 + 30 && utcMinutes <= 21 * 60 + 15;
  const recommendedScope = inMarketOpen ? "IN" : usMarketOpen ? "US" : "NONE";
  return {
    in_market_open: inMarketOpen,
    us_market_open: usMarketOpen,
    recommended_scope: recommendedScope,
  };
}

function resolveEffectiveQuotesMeta(overview = paperState.overview, nowMs = Date.now()) {
  const ap = overview && overview.active_portfolio ? overview.active_portfolio : null;
  const raw =
    (ap && ap.quotes_meta && typeof ap.quotes_meta === "object" ? ap.quotes_meta : null) ||
    (overview && overview.quotes_meta && typeof overview.quotes_meta === "object"
      ? overview.quotes_meta
      : null);

  const fallback = computeClientMarketSessionUtc(new Date(nowMs));
  if (!raw) {
    return {
      in_market_open: fallback.in_market_open,
      us_market_open: fallback.us_market_open,
      recommended_scope: fallback.recommended_scope,
      latest_quote_updated_at: null,
      relevant_quote_age_seconds: null,
    };
  }

  const elapsedSec =
    paperState.overviewFetchedAtMs > 0
      ? Math.max(0, Math.floor((nowMs - paperState.overviewFetchedAtMs) / 1000))
      : 0;
  const useClientClock = elapsedSec >= 60;

  const inOpen =
    !useClientClock && typeof raw.in_market_open === "boolean"
      ? raw.in_market_open
      : fallback.in_market_open;
  const usOpen =
    !useClientClock && typeof raw.us_market_open === "boolean"
      ? raw.us_market_open
      : fallback.us_market_open;

  let recScope = inOpen ? "IN" : usOpen ? "US" : "NONE";
  if (!useClientClock && typeof raw.recommended_scope === "string") {
    const norm = raw.recommended_scope.toUpperCase();
    if (norm === "IN" || norm === "US" || norm === "NONE") {
      recScope = norm;
    }
  }

  const latestUpdatedAt =
    typeof raw.latest_quote_updated_at === "string" && raw.latest_quote_updated_at.trim()
      ? raw.latest_quote_updated_at.trim()
      : null;

  let ageSec = null;
  if (recScope === "IN" || recScope === "US") {
    const rawScope =
      typeof raw.recommended_scope === "string" ? raw.recommended_scope.toUpperCase() : "";
    if (
      typeof raw.relevant_quote_age_seconds === "number" &&
      Number.isFinite(raw.relevant_quote_age_seconds) &&
      (!useClientClock || rawScope === recScope)
    ) {
      ageSec = Math.max(0, Math.floor(raw.relevant_quote_age_seconds) + elapsedSec);
    }
  }

  return {
    in_market_open: inOpen,
    us_market_open: usOpen,
    recommended_scope: recScope,
    latest_quote_updated_at: latestUpdatedAt,
    relevant_quote_age_seconds: ageSec,
  };
}

function formatLiveFreshnessLabel(meta, nowMs = Date.now()) {
  const ageSec = meta.relevant_quote_age_seconds;
  if (typeof ageSec === "number" && Number.isFinite(ageSec) && ageSec < UNQUOTED_SENTINEL_SEC) {
    const mins = Math.max(0, Math.floor(ageSec / 60));
    return `${mins}m ago`;
  }
  if (meta.latest_quote_updated_at) {
    const parsedMs = Date.parse(meta.latest_quote_updated_at);
    if (Number.isFinite(parsedMs)) {
      const mins = Math.max(0, Math.floor((nowMs - parsedMs) / 60000));
      return `${mins}m ago`;
    }
  }
  return "sync pending";
}

function renderPaperSessionPill() {
  const pill = document.getElementById("paper-session-pill");
  if (!pill) return;

  if (paperState.autoRefreshInFlight) {
    pill.className = "paper-session-pill paper-session-syncing";
    pill.title = "";
    pill.replaceChildren(
      el("span", "paper-session-spin", "↻"),
      document.createTextNode(" "),
      el("span", "paper-session-label", "Syncing...")
    );
    return;
  }

  const nowMs = Date.now();
  const meta = resolveEffectiveQuotesMeta(paperState.overview, nowMs);
  const syncStamp = formatUtcSyncStamp(meta.latest_quote_updated_at);
  pill.title = syncStamp ? `Last sync ${syncStamp}` : "";

  if (meta.in_market_open) {
    pill.className = "paper-session-pill paper-session-in";
    pill.replaceChildren(
      el("span", "paper-session-dot dot-session-in", "●"),
      document.createTextNode(" "),
      el("span", "paper-session-label", `NSE Open · ${formatLiveFreshnessLabel(meta, nowMs)}`)
    );
    return;
  }

  if (meta.us_market_open) {
    pill.className = "paper-session-pill paper-session-us";
    pill.replaceChildren(
      el("span", "paper-session-dot dot-session-us", "●"),
      document.createTextNode(" "),
      el("span", "paper-session-label", `US Open · ${formatLiveFreshnessLabel(meta, nowMs)}`)
    );
    return;
  }

  pill.className = "paper-session-pill paper-session-closed";
  pill.replaceChildren(
    el("span", "paper-session-dot dot-session-closed", "○"),
    document.createTextNode(" "),
    el("span", "paper-session-label", "Closed · Auto-settles 3:45p IST & 5p EST")
  );
}

export function setPaperSubtab(tabKey) {
  const nextKey = PAPER_SUBTABS.includes(tabKey) ? tabKey : "positions";
  uiState.activeSubtab = nextKey;
  paperState.activeSubtab = nextKey;

  const btnMap = {
    positions: document.getElementById("paper-subtab-positions"),
    orders: document.getElementById("paper-subtab-orders"),
    trades: document.getElementById("paper-subtab-trades"),
    attribution: document.getElementById("paper-subtab-attribution"),
  };

  const paneMap = {
    positions: document.getElementById("paper-pane-positions"),
    orders: document.getElementById("paper-pane-orders"),
    trades: document.getElementById("paper-pane-trades"),
    attribution: document.getElementById("paper-pane-attribution"),
  };

  for (const key of PAPER_SUBTABS) {
    const btn = btnMap[key];
    const isActive = key === nextKey;
    if (btn) {
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    }
    const pane = paneMap[key];
    if (pane) {
      pane.classList.toggle("hidden", !isActive);
    }
  }

  const bar = document.getElementById("paper-subtab-bar");
  if (bar && typeof bar.querySelectorAll === "function") {
    const dataBtns = bar.querySelectorAll("[data-paper-subtab]");
    for (const node of dataBtns) {
      const k = node.getAttribute("data-paper-subtab");
      if (k && PAPER_SUBTABS.includes(k)) {
        const isActive = k === nextKey;
        node.classList.toggle("active", isActive);
        node.setAttribute("aria-selected", isActive ? "true" : "false");
      }
    }
  }
}

function isPaperTabActive() {
  const tabPaper = document.getElementById("tab-paper");
  return Boolean(tabPaper && !tabPaper.classList.contains("hidden"));
}

function isPaperSignedInViewVisible() {
  const signedInView = document.getElementById("paper-signed-in-view");
  return Boolean(signedInView && !signedInView.classList.contains("hidden"));
}

async function paperApiRequest(path, options = {}) {
  const method = options.method || "GET";
  const headers = Object.assign({}, options.headers || {});
  const csrf = paperState.getCsrfToken();
  if (method === "POST" && !paperState.getStaticMode() && csrf) {
    headers["X-CSRF-Token"] = csrf;
  }
  if (options.jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let resp;
  try {
    resp = await window.fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: options.jsonBody !== undefined ? JSON.stringify(options.jsonBody) : undefined,
    });
  } catch (_netErr) {
    const err = new Error(
      "Could not connect to /api/paper. Run on the live Netlify deployment or local FastAPI server."
    );
    err.status = 503;
    throw err;
  }

  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const err = new Error(
      "Paper Trading API requires either the live Netlify serverless runtime or the local FastAPI server (not a plain static file server)."
    );
    err.status = 503;
    throw err;
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.detail || data.reason || `Paper API returned status ${resp.status}.`);
    err.status = resp.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function applyOverviewEnvelope(data) {
  if (!data || typeof data !== "object") return;
  const envFx = Number(
    (data.active_portfolio && data.active_portfolio.fx_usd_inr) || data.fx_usd_inr || 0
  );
  if (Number.isFinite(envFx) && envFx > 1) {
    paperState.liveUsdInrFx = envFx;
  }
  if (Array.isArray(data.portfolios)) {
    paperState.overview = data;
    paperState.overviewFetchedAtMs = Date.now();
    if (data.active_portfolio && data.active_portfolio.id) {
      paperState.activePortfolioId = data.active_portfolio.id;
    } else if (data.portfolios.length > 0 && !paperState.activePortfolioId) {
      paperState.activePortfolioId = data.portfolios[0].id;
    } else if (data.portfolios.length === 0) {
      paperState.activePortfolioId = null;
    }
  }
}

async function maybeTriggerSmartAutoRefresh() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (!isPaperTabActive() || !isPaperSignedInViewVisible()) return;
  if (paperState.autoRefreshInFlight || paperState.manualRefreshInFlight) return;

  const ov = paperState.overview;
  const ap = ov && ov.active_portfolio ? ov.active_portfolio : null;
  if (!ap || !ap.id) return;

  const activeId = ap.id;
  const nowMs = Date.now();
  const meta = resolveEffectiveQuotesMeta(ov, nowMs);
  const recommendedScope = meta.recommended_scope;
  if (recommendedScope !== "IN" && recommendedScope !== "US") return;

  const ageSec = meta.relevant_quote_age_seconds;
  const isStale = ageSec === null || ageSec >= STALE_QUOTE_THRESHOLD_SEC;
  if (!isStale) return;

  const cooldownKey = `${activeId}::${recommendedScope}`;
  const prevAutoMs = paperState.lastAutoRefreshMs.get(cooldownKey) || 0;
  if (nowMs - prevAutoMs < AUTO_REFRESH_COOLDOWN_MS) return;

  paperState.autoRefreshInFlight = true;
  paperState.lastAutoRefreshMs.set(cooldownKey, nowMs);
  renderPaperSessionPill();

  try {
    const res = await paperApiRequest("/api/paper/refresh", {
      method: "POST",
      jsonBody: {
        portfolio_id: activeId,
        market_scope: recommendedScope,
      },
    });
    paperState.lastAutoRefreshMs.set(cooldownKey, Date.now());

    if (!paperState.activePortfolioId || paperState.activePortfolioId === activeId) {
      if (res && Array.isArray(res.portfolios)) {
        applyOverviewEnvelope(res);
      } else {
        await loadPaperOverview(activeId, { skipAutoRefresh: true });
      }
    } else {
      await loadPaperOverview(paperState.activePortfolioId, { skipAutoRefresh: true });
    }

    const summary = (res && res.refresh_summary) || res || {};
    const ordersFilled = Number(summary.orders_filled ?? 0);
    if (ordersFilled > 0) {
      paperState.showToast(
        ordersFilled === 1
          ? "Auto-filled 1 Buy-on-Dip order!"
          : `Auto-filled ${ordersFilled} Buy-on-Dip orders!`
      );
    }
  } catch (_bgErr) {
    // Silent background sync fallback — keep cached quotes without interrupting user actions
  } finally {
    paperState.autoRefreshInFlight = false;
    if (isPaperSignedInViewVisible()) {
      renderPaperArena(paperState.currentUser);
    } else {
      renderPaperSessionPill();
    }
  }
}

export async function loadPaperOverview(targetPortfolioId = null, options = {}) {
  const signedOutView = document.getElementById("paper-signed-out-view");
  const signedInView = document.getElementById("paper-signed-in-view");
  const serviceBanner = document.getElementById("paper-service-banner");

  if (!signedOutView || !signedInView) return null;
  if (serviceBanner) {
    serviceBanner.classList.add("hidden");
    serviceBanner.textContent = "";
  }

  const user = await getPaperUser();
  if (!user) {
    paperState.currentUser = null;
    signedOutView.classList.remove("hidden");
    signedInView.classList.add("hidden");
    renderDynamicOAuthButtons("paper-oauth-wrap", "paper-oauth-buttons");
    const idStatus = getIdentityStatus();
    const setupGuide = document.getElementById("paper-identity-setup-guide");
    if (setupGuide) {
      setupGuide.classList.toggle("hidden", !(idStatus.staticMode && !idStatus.identityConfigured));
    }
    return null;
  }

  paperState.currentUser = user;
  const pid = targetPortfolioId !== null ? targetPortfolioId : paperState.activePortfolioId;
  const query = pid ? `?portfolio_id=${encodeURIComponent(pid)}` : "";

  try {
    paperState.loading = true;
    const data = await paperApiRequest(`/api/paper/overview${query}`);
    applyOverviewEnvelope(data);
    signedOutView.classList.add("hidden");
    signedInView.classList.remove("hidden");
    renderPaperArena(user);
    if (!options.skipAutoRefresh) {
      void maybeTriggerSmartAutoRefresh();
    }
    return data;
  } catch (err) {
    if (err && err.status === 401) {
      paperState.currentUser = null;
      signedOutView.classList.remove("hidden");
      signedInView.classList.add("hidden");
      renderDynamicOAuthButtons("paper-oauth-wrap", "paper-oauth-buttons");
      return null;
    }
    signedOutView.classList.add("hidden");
    signedInView.classList.remove("hidden");
    if (serviceBanner) {
      serviceBanner.textContent =
        err.message || "Paper Portfolio database is initializing. Please retry in a moment.";
      serviceBanner.classList.remove("hidden");
    }
    renderPaperArena(user);
    return null;
  } finally {
    paperState.loading = false;
  }
}

function buildPaperKpiCard(label, value, sub, valueColorClass = "") {
  const card = el("div", "kpi-card");
  card.appendChild(el("div", "kpi-label", label));
  card.appendChild(el("div", `kpi-value ${valueColorClass}`.trim(), value));
  if (sub) card.appendChild(el("div", "kpi-sub", sub));
  return card;
}

function renderPaperArena(user) {
  const ov = paperState.overview || { portfolios: [], active_portfolio: null };
  const portfolios = Array.isArray(ov.portfolios) ? ov.portfolios : [];
  const ap = ov.active_portfolio || null;

  const userPill = document.getElementById("paper-user-pill");
  const serverUserLabel =
    (ov.user && (ov.user.email_or_username || ov.user.email || ov.user.username)) ||
    (user && (user.maskedEmail || user.displayLabel)) ||
    "Advisor";
  if (userPill) {
    userPill.textContent = maskUserIdentity(serverUserLabel);
  }

  const stratPill = document.getElementById("paper-active-strategy-pill");
  if (stratPill) {
    if (ap) {
      const sName = STRATEGY_LABELS[ap.strategy_preset] || ap.strategy_preset || "QGLP Compounder";
      const bName = BENCHMARK_LABELS[ap.benchmark_ticker] || ap.benchmark_ticker || "Nifty 50";
      stratPill.textContent = `${ap.currency} · ${sName} · vs ${bName}`;
      stratPill.classList.remove("hidden");
    } else {
      stratPill.classList.add("hidden");
    }
  }

  renderPaperSessionPill();

  const depositBtn = document.getElementById("paper-open-deposit-btn");
  const quickOrderBtn = document.getElementById("paper-quick-order-btn");
  const refreshBtn = document.getElementById("paper-refresh-quotes-btn");
  if (depositBtn) depositBtn.disabled = !ap;
  if (quickOrderBtn) quickOrderBtn.disabled = !ap;
  if (refreshBtn) refreshBtn.disabled = portfolios.length === 0;

  // Render Wallet Selector Strip
  const walletStrip = document.getElementById("paper-wallet-strip");
  if (walletStrip) {
    walletStrip.replaceChildren();
    for (const w of portfolios) {
      const isActive = ap && w.id === ap.id;
      const wCcy = w.currency || "INR";
      const wNav = Number(w.total_nav ?? w.cash_balance ?? 0);
      const wRet = Number(w.return_pct || 0);
      const btn = el("button", `paper-wallet-chip ${isActive ? "active" : ""}`.trim());
      btn.type = "button";

      const nameSpan = el("span", "pw-chip-name", w.name);
      const navSpan = el("span", "pw-chip-nav", formatCurrencyCompact(wNav, wCcy));
      const retSpan = el(
        "span",
        `pw-chip-ret ${wRet > 0 ? "text-pos" : wRet < 0 ? "text-neg" : "text-cyan"}`,
        `${fmtSigned(wRet, 2)}%`
      );
      btn.appendChild(nameSpan);
      btn.appendChild(navSpan);
      btn.appendChild(retSpan);

      btn.addEventListener("click", async () => {
        if (!isActive) {
          paperState.activePortfolioId = w.id;
          await loadPaperOverview(w.id);
        }
      });
      walletStrip.appendChild(btn);
    }
  }

  const emptyCard = document.getElementById("paper-empty-wallets-card");
  const activeWorkspace = document.getElementById("paper-active-workspace");

  if (!ap || portfolios.length === 0) {
    if (emptyCard) emptyCard.classList.remove("hidden");
    if (activeWorkspace) activeWorkspace.classList.add("hidden");
    return;
  }

  if (emptyCard) emptyCard.classList.add("hidden");
  if (activeWorkspace) activeWorkspace.classList.remove("hidden");

  const ccy = ap.currency || "INR";
  const cashBal = Number(ap.cash_balance || 0);
  const reservedCash = Number(ap.reserved_cash || 0);
  const availCash =
    ap.available_cash !== undefined ? Number(ap.available_cash) : Math.max(0, cashBal - reservedCash);
  const totalDeposited = Number(ap.total_deposited || cashBal || 1);
  const holdingsVal = Number(ap.holdings_value || 0);
  const totalNav = Number(ap.total_nav ?? cashBal + holdingsVal);
  const netRetAmt =
    ap.net_return_amount !== undefined
      ? Number(ap.net_return_amount)
      : ap.total_return_amt !== undefined
      ? Number(ap.total_return_amt)
      : totalNav - totalDeposited;
  const retPct =
    ap.return_pct !== undefined
      ? Number(ap.return_pct)
      : totalDeposited > 0
      ? ((totalNav - totalDeposited) / totalDeposited) * 100
      : 0;
  const bmRetPct = Number(ap.benchmark_return_pct || 0);
  const alphaPct = ap.alpha_pct !== undefined ? Number(ap.alpha_pct) : retPct - bmRetPct;
  const bmShort =
    ap.benchmark_ticker === "^GSPC"
      ? "S&P 500"
      : ap.benchmark_ticker === "^NDX"
      ? "Nasdaq 100"
      : "Nifty 50";

  const positions = Array.isArray(ap.positions) ? ap.positions : [];
  const openOrders = Array.isArray(ap.open_orders) ? ap.open_orders : [];
  const recentTrades = Array.isArray(ap.recent_trades) ? ap.recent_trades : [];

  // 1. Render 5 Calm Portfolio KPI Cards
  const kpiStrip = document.getElementById("paper-kpi-strip");
  if (kpiStrip) {
    kpiStrip.replaceChildren();
    kpiStrip.appendChild(
      buildPaperKpiCard(
        "Portfolio NAV",
        formatExactCurrency(totalNav, ccy, ccy === "USD" ? 2 : 0),
        `Holdings ${formatCurrencyCompact(holdingsVal, ccy)} · Principal ${formatCurrencyCompact(
          totalDeposited,
          ccy
        )}`,
        "text-cyan"
      )
    );
    kpiStrip.appendChild(
      buildPaperKpiCard(
        "Net Return",
        `${netRetAmt >= 0 ? "+" : ""}${formatExactCurrency(
          netRetAmt,
          ccy,
          ccy === "USD" ? 2 : 0
        )} (${fmtSigned(retPct, 2)}%)`,
        `vs ${bmShort} ${fmtSigned(bmRetPct, 2)}% · Alpha ${fmtSigned(alphaPct, 2)}%`,
        netRetAmt > 0 ? "text-pos" : netRetAmt < 0 ? "text-neg" : "text-cyan"
      )
    );
    kpiStrip.appendChild(
      buildPaperKpiCard(
        "Available Cash",
        formatExactCurrency(availCash, ccy, ccy === "USD" ? 2 : 0),
        reservedCash > 0
          ? `Reserved ${formatCurrencyCompact(reservedCash, ccy)}`
          : "Ready to deploy",
        "text-pos"
      )
    );
    kpiStrip.appendChild(
      buildPaperKpiCard(
        "Dip Orders",
        `${openOrders.length} Open`,
        openOrders.length > 0
          ? `${formatCurrencyCompact(reservedCash, ccy)} locked`
          : "No active limit orders",
        openOrders.length > 0 ? "text-warn" : ""
      )
    );

    let bestPick = ap.best_pick || null;
    if (!bestPick && positions.length > 0) {
      bestPick = [...positions].sort(
        (a, b) => Number(b.unrealized_pnl_pct || 0) - Number(a.unrealized_pnl_pct || 0)
      )[0];
    }
    if (bestPick) {
      const bpPct = Number(bestPick.unrealized_pnl_pct || 0);
      const bpAmt = Number(bestPick.unrealized_pnl || 0);
      kpiStrip.appendChild(
        buildPaperKpiCard(
          "Top Holding",
          `${displaySymbol(bestPick.ticker)} (${fmtSigned(bpPct, 2)}%)`,
          `${bpAmt >= 0 ? "+" : ""}${formatExactCurrency(
            bpAmt,
            ccy,
            ccy === "USD" ? 2 : 0
          )} unrealized`,
          bpPct >= 0 ? "text-pos" : "text-neg"
        )
      );
    } else {
      kpiStrip.appendChild(
        buildPaperKpiCard(
          "Top Holding",
          "—",
          "No open positions",
          ""
        )
      );
    }
  }

  // 2. Render Portfolio NAV vs. Benchmark Chart
  renderPaperNavChart(ap, ccy, bmShort, totalDeposited, totalNav, bmRetPct);

  // 3. Render 4 Sub-Tab Panes & Sync Active Sub-Tab
  renderPaperPositionsTable(positions, ccy);
  renderPaperOpenOrdersTable(openOrders, ccy);
  renderPaperTradesTable(recentTrades, ccy);
  renderPaperAttribution(ap, positions, ccy);
  setPaperSubtab(uiState.activeSubtab);
}

function renderPaperNavChart(ap, ccy, bmShort, totalDeposited, totalNav, bmRetPct) {
  const titleEl = document.getElementById("paper-nav-chart-title");
  const bmLegendEl = document.getElementById("paper-nav-bm-legend");
  const chartBox = document.getElementById("paper-nav-chart");
  if (!chartBox) return;

  if (titleEl) {
    titleEl.textContent = `Portfolio NAV vs ${bmShort}`;
  }
  if (bmLegendEl) {
    bmLegendEl.textContent = bmShort;
  }

  const rawHist = Array.isArray(ap.nav_history) ? ap.nav_history : [];
  let xLabels = [];
  let navVals = [];
  let bmVals = [];

  if (rawHist.length >= 2) {
    xLabels = rawHist.map((pt) => pt.snap_date);
    navVals = rawHist.map((pt) => Number(pt.total_nav || 0));
    bmVals = rawHist.map((pt) => {
      const base = Number(pt.total_deposited || totalDeposited || 0);
      return base * (1.0 + Number(pt.benchmark_return_pct || 0) / 100.0);
    });
  } else if (rawHist.length === 1) {
    const pt0 = rawHist[0];
    const base0 = Number(pt0.total_deposited || totalDeposited || 0);
    xLabels = ["Inception", pt0.snap_date || "Today"];
    navVals = [base0, Number(pt0.total_nav ?? totalNav)];
    bmVals = [base0, base0 * (1.0 + Number(pt0.benchmark_return_pct ?? bmRetPct) / 100.0)];
  } else {
    xLabels = ["Inception", "Today"];
    navVals = [totalDeposited, totalNav];
    bmVals = [totalDeposited, totalDeposited * (1.0 + bmRetPct / 100.0)];
  }

  renderMultiLineChart(
    chartBox,
    [
      {
        name: bmShort,
        values: bmVals,
        color: "#94a3b8",
        dashed: true,
        width: 1.8,
      },
      {
        name: "Wallet NAV",
        values: navVals,
        color: "#10b981",
        areaFill: "rgba(16, 185, 129, 0.13)",
        width: 2.6,
      },
    ],
    xLabels,
    (v) => formatCurrencyCompact(v, ccy),
    { height: 225 }
  );
}

function renderPaperAttribution(ap, positions, ccy) {
  const subEl = document.getElementById("paper-attribution-sub");
  const mountEl = document.getElementById("paper-attribution-mount");
  if (!mountEl) return;
  mountEl.replaceChildren();

  let rows = Array.isArray(ap.attribution_by_rating) ? ap.attribution_by_rating : [];
  if (rows.length === 0 && positions.length > 0) {
    const bucketMap = new Map();
    for (const p of positions) {
      const r = p.entry_rating || "Buy";
      const cur = bucketMap.get(r) || { rating: r, count: 0, invested: 0, current_value: 0 };
      const inv = Number(
        p.invested_value ?? p.cost_basis ?? Number(p.shares || 0) * Number(p.avg_cost || 0) * Number(p.fx_rate || 1)
      );
      const mkt = Number(p.market_value || 0);
      cur.count += 1;
      cur.invested += inv;
      cur.current_value += mkt;
      bucketMap.set(r, cur);
    }
    rows = Array.from(bucketMap.values()).map((b) => ({
      ...b,
      pnl_amount: b.current_value - b.invested,
      return_pct: b.invested > 0 ? ((b.current_value - b.invested) / b.invested) * 100 : 0,
    }));
  }

  const byTier = new Map();
  for (const r of rows) {
    if (r && r.rating) byTier.set(r.rating, r);
  }

  const orderedTiers = ["Strong Buy", "Buy", "Hold"];
  if (byTier.has("Avoid") && Number(byTier.get("Avoid").count || 0) > 0) {
    orderedTiers.push("Avoid");
  }

  if (subEl) {
    subEl.textContent =
      positions.length > 0
        ? "Return % grouped by model rating at entry"
        : "Buy stocks to track performance by model rating";
  }

  const listWrap = el("div", "attribution-tier-list");
  const tierColors = {
    "Strong Buy": "#10b981",
    Buy: "#38bdf8",
    Hold: "#f59e0b",
    Avoid: "#f43f5e",
  };

  for (const tier of orderedTiers) {
    const item = byTier.get(tier) || {
      rating: tier,
      count: 0,
      invested: 0,
      current_value: 0,
      pnl_amount: 0,
      return_pct: 0,
    };
    const count = Number(item.count || 0);
    const inv = Number(item.invested || 0);
    const curVal = Number(item.current_value || 0);
    const pnl =
      item.pnl_amount !== undefined ? Number(item.pnl_amount) : curVal - inv;
    const retPct = Number(item.return_pct || 0);

    const card = el("div", "attribution-tier-row");
    const top = el("div", "attr-row-top");
    const left = el("div", "inline-group wrap-group");
    left.appendChild(el("span", ratingBadgeClass(tier), tier));
    left.appendChild(
      el("span", "muted-note", count === 1 ? "1 position" : `${count} positions`)
    );
    top.appendChild(left);

    const right = el(
      "span",
      `attr-ret-val ${
        count === 0 ? "muted-note" : retPct > 0 ? "text-pos" : retPct < 0 ? "text-neg" : "text-cyan"
      }`,
      count === 0 ? "—" : `${fmtSigned(retPct, 2)}% (${pnl >= 0 ? "+" : ""}${formatExactCurrency(pnl, ccy)})`
    );
    top.appendChild(right);
    card.appendChild(top);

    const barFillPct = count === 0 ? 0 : Math.max(8, Math.min(100, 50 + retPct * 2.5));
    card.appendChild(createProgressSvg(barFillPct, tierColors[tier] || "#38bdf8", 6));

    const meta = el("div", "attr-row-meta");
    meta.appendChild(el("span", "", `Cost ${formatExactCurrency(inv, ccy)}`));
    meta.appendChild(el("span", "", `Value ${formatExactCurrency(curVal, ccy)}`));
    card.appendChild(meta);

    listWrap.appendChild(card);
  }

  mountEl.appendChild(listWrap);
}

function renderPaperPositionsTable(positions, walletCcy) {
  const pill = document.getElementById("paper-positions-count-pill");
  const tbody = document.getElementById("paper-positions-tbody");
  if (pill) pill.textContent = `${positions.length}`;
  if (!tbody) return;
  tbody.replaceChildren();

  if (positions.length === 0) {
    const tr = document.createElement("tr");
    const td = el(
      "td",
      "empty-state-box",
      "No open positions yet. Click + Place Order or deploy a Planner basket."
    );
    td.colSpan = 8;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const pos of positions) {
    const tr = document.createElement("tr");
    const nativeCcy = resolveStockCurrency(pos);
    const livePx = Number(pos.live_price ?? pos.current_price ?? pos.avg_cost ?? 0);
    const avgCost = Number(pos.avg_cost || 0);
    const mktVal = Number(pos.market_value || 0);
    const pnlAmt = Number(pos.unrealized_pnl || 0);
    const pnlPct = Number(pos.unrealized_pnl_pct || 0);
    const entrySc = Number(pos.entry_score || 0);
    const curSc = Number(pos.current_score ?? entrySc);
    const scDelta = curSc - entrySc;

    // 1. Company & 3-Tier Index Badge
    const compTd = document.createElement("td");
    const line = el("div", "company-primary");
    line.appendChild(el("span", "", pos.name || pos.ticker));
    line.appendChild(el("span", "ticker-tag", displaySymbol(pos.ticker)));
    line.appendChild(createIndexBadge(pos));
    compTd.appendChild(line);
    if (pos.sector) {
      compTd.appendChild(el("span", "sector-sub", pos.sector));
    }
    tr.appendChild(compTd);

    // 2. Shares
    const shTd = document.createElement("td");
    shTd.appendChild(el("div", "company-primary", `${pos.shares} sh`));
    if (pos.sellable_shares !== undefined && Number(pos.sellable_shares) < Number(pos.shares)) {
      shTd.appendChild(
        el("span", "sector-sub text-warn", `${pos.sellable_shares} sh free`)
      );
    }
    tr.appendChild(shTd);

    // 3. Avg Cost
    tr.appendChild(el("td", "", formatStockPrice(avgCost, nativeCcy)));

    // 4. Live Price
    tr.appendChild(el("td", "company-primary", formatStockPrice(livePx, nativeCcy)));

    // 5. Market Value (Wallet Currency)
    const mvTd = document.createElement("td");
    mvTd.appendChild(
      el("div", "company-primary", formatExactCurrency(mktVal, walletCcy, walletCcy === "USD" ? 2 : 0))
    );
    if (pos.weight_pct !== undefined) {
      mvTd.appendChild(el("span", "sector-sub", `${Number(pos.weight_pct).toFixed(1)}% NAV`));
    }
    tr.appendChild(mvTd);

    // 6. Unrealized P&L
    const pnlTd = document.createElement("td");
    const pnlCls = pnlAmt > 0 ? "text-pos" : pnlAmt < 0 ? "text-neg" : "text-cyan";
    pnlTd.appendChild(
      el(
        "div",
        `company-primary ${pnlCls}`,
        `${pnlAmt >= 0 ? "+" : ""}${formatExactCurrency(pnlAmt, walletCcy, walletCcy === "USD" ? 2 : 0)}`
      )
    );
    pnlTd.appendChild(el("span", `sector-sub ${pnlCls}`, `${fmtSigned(pnlPct, 2)}%`));
    tr.appendChild(pnlTd);

    // 7. Score at Entry -> Score Today
    const scTd = document.createElement("td");
    const scLine = el("div", "score-drift-line");
    scLine.appendChild(el("span", "", `${entrySc.toFixed(1)} → ${curSc.toFixed(1)}`));
    if (Math.abs(scDelta) >= 0.2) {
      scLine.appendChild(
        el(
          "span",
          scDelta > 0 ? "text-pos" : "text-warn",
          `(${fmtSigned(scDelta, 1)})`
        )
      );
    }
    scTd.appendChild(scLine);
    scTd.appendChild(
      el(
        "span",
        "sector-sub",
        `${pos.entry_rating || "Rated"} → ${pos.current_rating || pos.entry_rating || "Rated"}`
      )
    );
    tr.appendChild(scTd);

    // 8. Quick Actions: Buy / Sell / Details
    const actTd = document.createElement("td");
    const actGroup = el("div", "inline-group wrap-group");

    const buyBtn = el("button", "btn btn-ghost btn-xs text-pos", "+ Buy");
    buyBtn.type = "button";
    buyBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openPaperOrderTicket(pos.ticker, { side: "BUY", orderType: "LIMIT" });
    });

    const sellBtn = el("button", "btn btn-ghost btn-xs text-warn", "Sell");
    sellBtn.type = "button";
    sellBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openPaperOrderTicket(pos.ticker, {
        side: "SELL",
        orderType: "MARKET",
        defaultShares: Number(pos.sellable_shares ?? pos.shares ?? 1),
      });
    });

    const ddBtn = el("button", "btn-deep-dive", "Details →");
    ddBtn.type = "button";
    ddBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      paperState.openDeepDive(pos.ticker);
    });

    actGroup.appendChild(buyBtn);
    actGroup.appendChild(sellBtn);
    actGroup.appendChild(ddBtn);
    actTd.appendChild(actGroup);
    tr.appendChild(actTd);

    tbody.appendChild(tr);
  }
}

function renderPaperOpenOrdersTable(openOrders, walletCcy) {
  const pill = document.getElementById("paper-orders-count-pill");
  const tbody = document.getElementById("paper-orders-tbody");
  if (pill) pill.textContent = `${openOrders.length}`;
  if (!tbody) return;
  tbody.replaceChildren();

  if (openOrders.length === 0) {
    const tr = document.createElement("tr");
    const td = el(
      "td",
      "empty-state-box",
      "No open Dip Orders. Place a -5% or -7% limit order on any stock."
    );
    td.colSpan = 8;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const ord of openOrders) {
    const tr = document.createElement("tr");
    const nativeCcy = resolveStockCurrency(ord);
    const limPx = Number(ord.limit_price || 0);
    const livePx = Number(ord.live_price ?? ord.current_price ?? limPx);
    const distPct =
      ord.distance_pct !== undefined
        ? Number(ord.distance_pct)
        : livePx > 0
        ? ((limPx - livePx) / livePx) * 100
        : 0;

    // 1. Company & Index
    const compTd = document.createElement("td");
    const line = el("div", "company-primary");
    line.appendChild(el("span", "", ord.name || ord.ticker));
    line.appendChild(el("span", "ticker-tag", displaySymbol(ord.ticker)));
    line.appendChild(createIndexBadge(ord));
    compTd.appendChild(line);
    compTd.appendChild(el("span", "sector-sub", formatShortTimestamp(ord.created_at)));
    tr.appendChild(compTd);

    // 2. Side & Order Type
    const sideTd = document.createElement("td");
    const isBuy = ord.side === "BUY";
    sideTd.appendChild(
      el(
        "span",
        isBuy ? "badge badge-buy" : "badge badge-hold",
        `${ord.side} ${ord.order_type || "LIMIT"}`
      )
    );
    tr.appendChild(sideTd);

    // 3. Shares
    tr.appendChild(el("td", "company-primary", `${ord.shares} sh`));

    // 4. Target Dip Price vs Current Price
    const pxTd = document.createElement("td");
    pxTd.appendChild(
      el("div", "company-primary text-cyan", formatStockPrice(limPx, nativeCcy))
    );
    pxTd.appendChild(
      el("span", "sector-sub", `Live ${formatStockPrice(livePx, nativeCcy)}`)
    );
    tr.appendChild(pxTd);

    // 5. Distance %
    const distTd = document.createElement("td");
    const nearTrigger = Math.abs(distPct) <= 2.5;
    distTd.appendChild(
      el(
        "span",
        nearTrigger ? "company-primary text-pos" : "text-warn",
        `${fmtSigned(distPct, 2)}%`
      )
    );
    distTd.appendChild(
      el("span", "sector-sub", nearTrigger ? "Near trigger" : "Watching low")
    );
    tr.appendChild(distTd);

    // 6. Reserved Cash
    tr.appendChild(
      el(
        "td",
        "",
        ord.side === "BUY"
          ? formatExactCurrency(ord.reserved_amount || 0, walletCcy, walletCcy === "USD" ? 2 : 0)
          : `${ord.shares} sh locked`
      )
    );

    // 7. Strategy Note
    tr.appendChild(
      el("td", "muted-note cell-wrap", ord.note || "Buy-on-Dip Limit")
    );

    // 8. Cancel Order Button
    const cancelTd = document.createElement("td");
    const cancelBtn = el("button", "btn btn-ghost btn-xs text-neg", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "Cancelling...";
      try {
        const res = await paperApiRequest(`/api/paper/orders/${encodeURIComponent(ord.id)}/cancel`, {
          method: "POST",
          jsonBody: {},
        });
        applyOverviewEnvelope(res);
        await loadPaperOverview(paperState.activePortfolioId);
        paperState.showToast(
          `Cancelled ${displaySymbol(ord.ticker)} limit order — cash released.`
        );
      } catch (err) {
        paperState.showToast(err.message, true);
        cancelBtn.disabled = false;
        cancelBtn.textContent = "Cancel";
      }
    });
    cancelTd.appendChild(cancelBtn);
    tr.appendChild(cancelTd);

    tbody.appendChild(tr);
  }
}

function renderPaperTradesTable(trades, walletCcy) {
  const pill = document.getElementById("paper-trades-count-pill");
  const tbody = document.getElementById("paper-trades-tbody");
  if (pill) pill.textContent = `${trades.length}`;
  if (!tbody) return;
  tbody.replaceChildren();

  if (trades.length === 0) {
    const tr = document.createElement("tr");
    const td = el("td", "empty-state-box", "No executed trades yet.");
    td.colSpan = 8;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const t of trades) {
    const tr = document.createElement("tr");
    const nativeCcy = resolveStockCurrency(t);
    const isBuy = t.side === "BUY";
    const fx = Number(t.fx_rate || 1);
    const rPnl = Number(t.realized_pnl || 0);

    // 1. Date
    tr.appendChild(el("td", "muted-note", formatShortTimestamp(t.executed_at)));

    // 2. Company
    const compTd = document.createElement("td");
    const line = el("div", "company-primary");
    line.appendChild(el("span", "", t.name || t.ticker));
    line.appendChild(el("span", "ticker-tag", displaySymbol(t.ticker)));
    compTd.appendChild(line);
    if (t.rating_at_trade) {
      compTd.appendChild(
        el(
          "span",
          "sector-sub",
          `Rated ${t.rating_at_trade}${
            t.score_at_trade ? ` · ${Number(t.score_at_trade).toFixed(1)}` : ""
          }`
        )
      );
    }
    tr.appendChild(compTd);

    // 3. Side & Order Type
    const sideTd = document.createElement("td");
    sideTd.appendChild(
      el(
        "span",
        isBuy ? "badge badge-strong-buy" : "badge badge-hold",
        `${t.side} ${t.order_type || "MARKET"}`
      )
    );
    tr.appendChild(sideTd);

    // 4. Shares
    tr.appendChild(el("td", "company-primary", `${t.shares} sh`));

    // 5. Fill Price
    const pxTd = document.createElement("td");
    pxTd.appendChild(
      el("div", "", formatStockPrice(t.exec_price_native || 0, nativeCcy))
    );
    if (Math.abs(fx - 1.0) > 0.01) {
      pxTd.appendChild(el("span", "sector-sub", `FX ${fx.toFixed(2)}`));
    }
    tr.appendChild(pxTd);

    // 6. Net Value
    tr.appendChild(
      el(
        "td",
        "company-primary",
        formatExactCurrency(t.net_amount || 0, walletCcy, walletCcy === "USD" ? 2 : 0)
      )
    );

    // 7. Brokerage / STT Fee
    tr.appendChild(
      el(
        "td",
        "muted-note",
        formatExactCurrency(t.fee_amount || 0, walletCcy, 2)
      )
    );

    // 8. Realized P&L
    if (isBuy) {
      tr.appendChild(el("td", "muted-note", "—"));
    } else {
      tr.appendChild(
        el(
          "td",
          rPnl > 0 ? "company-primary text-pos" : rPnl < 0 ? "company-primary text-neg" : "",
          `${rPnl >= 0 ? "+" : ""}${formatExactCurrency(rPnl, walletCcy, walletCcy === "USD" ? 2 : 0)}`
        )
      );
    }

    tbody.appendChild(tr);
  }
}

// ============================================================================
// Modal 1: Create New Strategy Wallet
// ============================================================================

export function openNewWalletModal(defaults = {}) {
  const backdrop = document.getElementById("paper-wallet-modal-backdrop");
  const modal = document.getElementById("paper-wallet-modal");
  const nameIn = document.getElementById("paper-wallet-name");
  const ccySel = document.getElementById("paper-wallet-currency");
  const cashIn = document.getElementById("paper-wallet-cash");
  const presetSel = document.getElementById("paper-wallet-preset");
  const bmSel = document.getElementById("paper-wallet-benchmark");
  const errBox = document.getElementById("paper-wallet-error");
  const presetsBar = document.getElementById("paper-wallet-presets-bar");

  if (!modal || !backdrop) return;
  errBox.classList.add("hidden");
  errBox.textContent = "";

  const ccy = defaults.currency || "INR";
  ccySel.value = ccy;
  nameIn.value = defaults.name || (ccy === "USD" ? "US Dip Hunter $10K" : "India QGLP ₹5L");
  cashIn.value = String(defaults.cash || (ccy === "USD" ? 10000 : 500000));
  presetSel.value = defaults.preset || "qglp_compounder";
  bmSel.value = defaults.benchmark || (ccy === "USD" ? "^GSPC" : "^NSEI");

  if (presetsBar) {
    presetsBar.replaceChildren();
    for (const tpl of WALLET_TEMPLATES) {
      const chip = el("button", "chip-btn", tpl.label);
      chip.type = "button";
      chip.addEventListener("click", () => {
        nameIn.value = tpl.name;
        ccySel.value = tpl.currency;
        cashIn.value = String(tpl.cash);
        presetSel.value = tpl.preset;
        bmSel.value = tpl.benchmark;
      });
      presetsBar.appendChild(chip);
    }
  }

  backdrop.classList.remove("hidden");
  modal.classList.remove("hidden");
}

function closeNewWalletModal() {
  const backdrop = document.getElementById("paper-wallet-modal-backdrop");
  const modal = document.getElementById("paper-wallet-modal");
  if (backdrop) backdrop.classList.add("hidden");
  if (modal) modal.classList.add("hidden");
}

async function createQuickWallet(template) {
  const user = await getPaperUser();
  if (!user) {
    openPaperAuthModal("login", async () => {
      await createQuickWallet(template);
    });
    return;
  }
  try {
    const res = await paperApiRequest("/api/paper/portfolios", {
      method: "POST",
      jsonBody: {
        name: template.name,
        currency: template.currency,
        initial_cash: template.cash,
        strategy_preset: template.preset,
        benchmark_ticker: template.benchmark,
      },
    });
    const createdId =
      res.created_portfolio_id ||
      (res.portfolio && res.portfolio.id) ||
      (res.active_portfolio && res.active_portfolio.id) ||
      null;
    applyOverviewEnvelope(res);
    if (createdId) paperState.activePortfolioId = createdId;
    await loadPaperOverview(paperState.activePortfolioId);
    paperState.showToast(`Created virtual strategy wallet "${template.name}".`);
  } catch (err) {
    paperState.showToast(err.message, true);
  }
}

async function handleCreateWalletSubmit(ev) {
  ev.preventDefault();
  const errBox = document.getElementById("paper-wallet-error");
  const submitBtn = document.getElementById("paper-wallet-submit-btn");
  const name = document.getElementById("paper-wallet-name").value.trim();
  const currency = document.getElementById("paper-wallet-currency").value;
  const initialCash = Number(document.getElementById("paper-wallet-cash").value || 0);
  const strategyPreset = document.getElementById("paper-wallet-preset").value;
  const benchmarkTicker = document.getElementById("paper-wallet-benchmark").value;

  errBox.classList.add("hidden");
  if (!name || name.length < 2) {
    errBox.textContent = "Enter a descriptive strategy wallet name (2–60 characters).";
    errBox.classList.remove("hidden");
    return;
  }
  if (!Number.isFinite(initialCash) || initialCash <= 0) {
    errBox.textContent = "Starting virtual cash must be greater than zero.";
    errBox.classList.remove("hidden");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Creating Wallet...";
  try {
    const res = await paperApiRequest("/api/paper/portfolios", {
      method: "POST",
      jsonBody: {
        name,
        currency,
        initial_cash: initialCash,
        strategy_preset: strategyPreset,
        benchmark_ticker: benchmarkTicker,
      },
    });
    const newId =
      res.created_portfolio_id ||
      (res.portfolio && res.portfolio.id) ||
      (res.active_portfolio && res.active_portfolio.id) ||
      null;
    applyOverviewEnvelope(res);
    if (newId) paperState.activePortfolioId = newId;
    closeNewWalletModal();
    await loadPaperOverview(paperState.activePortfolioId);
    paperState.showToast(
      `Created "${name}" funded with ${formatExactCurrency(initialCash, currency)}.`
    );
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Create Virtual Strategy Wallet";
  }
}

// ============================================================================
// Modal 2: Load Virtual Cash (Deposit Top-Up)
// ============================================================================

function openDepositModal() {
  const ap = paperState.overview && paperState.overview.active_portfolio;
  if (!ap) return;

  const backdrop = document.getElementById("paper-deposit-modal-backdrop");
  const modal = document.getElementById("paper-deposit-modal");
  const lbl = document.getElementById("paper-deposit-wallet-label");
  const chipsWrap = document.getElementById("paper-deposit-chips");
  const amountIn = document.getElementById("paper-deposit-amount");
  const errBox = document.getElementById("paper-deposit-error");

  errBox.classList.add("hidden");
  const ccy = ap.currency || "INR";
  lbl.textContent = `Active Wallet: ${ap.name} • Current Free Cash: ${formatExactCurrency(
    ap.available_cash ?? ap.cash_balance - (ap.reserved_cash || 0),
    ccy
  )}`;

  const amounts = ccy === "USD" ? [2500, 5000, 10000, 25000] : [100000, 250000, 500000, 1000000];
  amountIn.value = String(amounts[1]);

  chipsWrap.replaceChildren();
  for (const amt of amounts) {
    const chip = el("button", "chip-btn", `+${formatCurrencyCompact(amt, ccy)}`);
    chip.type = "button";
    chip.addEventListener("click", () => {
      amountIn.value = String(amt);
    });
    chipsWrap.appendChild(chip);
  }

  backdrop.classList.remove("hidden");
  modal.classList.remove("hidden");
}

function closeDepositModal() {
  const backdrop = document.getElementById("paper-deposit-modal-backdrop");
  const modal = document.getElementById("paper-deposit-modal");
  if (backdrop) backdrop.classList.add("hidden");
  if (modal) modal.classList.add("hidden");
}

async function handleDepositSubmit(ev) {
  ev.preventDefault();
  const ap = paperState.overview && paperState.overview.active_portfolio;
  if (!ap) return;

  const errBox = document.getElementById("paper-deposit-error");
  const submitBtn = document.getElementById("paper-deposit-submit-btn");
  const amount = Number(document.getElementById("paper-deposit-amount").value || 0);

  errBox.classList.add("hidden");
  if (!Number.isFinite(amount) || amount <= 0) {
    errBox.textContent = "Enter a positive virtual cash top-up amount.";
    errBox.classList.remove("hidden");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Loading Cash...";
  try {
    const res = await paperApiRequest(
      `/api/paper/portfolios/${encodeURIComponent(ap.id)}/deposit`,
      {
        method: "POST",
        jsonBody: { amount },
      }
    );
    applyOverviewEnvelope(res);
    closeDepositModal();
    await loadPaperOverview(ap.id);
    paperState.showToast(
      `Loaded +${formatExactCurrency(amount, ap.currency)} into "${ap.name}" (principal updated cleanly).`
    );
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Add Virtual Cash";
  }
}

// ============================================================================
// Modal 3: Crisp Order Ticket Modal (Market Order vs Buy-on-Dip Limit Order)
// ============================================================================

function populateStockDatalist() {
  const dl = document.getElementById("paper-order-ticker-datalist");
  if (!dl) return;
  const stocks = paperState.getAllStocks() || [];
  if (dl.children.length === stocks.length && stocks.length > 0) return;
  dl.replaceChildren();
  for (const s of stocks) {
    const opt = document.createElement("option");
    opt.value = s.ticker;
    opt.textContent = `${s.name} (${s.rating} • Score ${Number(s.composite_score || 0).toFixed(1)})`;
    dl.appendChild(opt);
  }
}

function getSelectedTicketWallet() {
  const sel = document.getElementById("paper-order-wallet-select");
  const portfolios = (paperState.overview && paperState.overview.portfolios) || [];
  if (!sel || portfolios.length === 0) return null;
  const found = portfolios.find((p) => p.id === sel.value);
  if (found) {
    if (
      paperState.overview &&
      paperState.overview.active_portfolio &&
      paperState.overview.active_portfolio.id === found.id
    ) {
      return paperState.overview.active_portfolio;
    }
    return found;
  }
  return portfolios[0];
}

function applyCachedLiveQuote(stockObj) {
  if (!stockObj || !stockObj.ticker) return stockObj;
  const cached = paperState.liveQuoteCache.get(String(stockObj.ticker).toUpperCase());
  if (!cached) return { ...stockObj };
  const px = Number(cached.close_price ?? cached.live_price ?? cached.price ?? 0);
  if (!Number.isFinite(px) || px <= 0) return { ...stockObj };
  return {
    ...stockObj,
    price: px,
    live_price: px,
    current_price: px,
    native_currency: cached.native_currency || resolveStockCurrency(stockObj),
  };
}

function resolveTicketStockObject(rawTickerOrObj) {
  if (rawTickerOrObj && typeof rawTickerOrObj === "object" && rawTickerOrObj.ticker) {
    return applyCachedLiveQuote(rawTickerOrObj);
  }
  const sym = String(rawTickerOrObj || "").trim().toUpperCase();
  if (!sym) return null;
  const fromScreener = paperState.findStockByTicker(sym);
  if (fromScreener) return applyCachedLiveQuote(fromScreener);
  // Also check active portfolio positions
  const ap = paperState.overview && paperState.overview.active_portfolio;
  if (ap && Array.isArray(ap.positions)) {
    const posMatch = ap.positions.find(
      (p) => p.ticker.toUpperCase() === sym || displaySymbol(p.ticker).toUpperCase() === sym
    );
    if (posMatch) {
      return applyCachedLiveQuote({
        ticker: posMatch.ticker,
        name: posMatch.name || posMatch.ticker,
        sector: posMatch.sector || "",
        index_tag: posMatch.index_tag,
        currency: resolveStockCurrency(posMatch),
        price: Number(posMatch.live_price ?? posMatch.current_price ?? posMatch.avg_cost ?? 0),
        composite_score: Number(posMatch.current_score ?? posMatch.entry_score ?? 0),
        rating: posMatch.current_rating || posMatch.entry_rating || "Buy",
      });
    }
  }
  return null;
}

function isOrderTicketModalOpen() {
  const modal = document.getElementById("paper-order-modal");
  return Boolean(modal && !modal.classList.contains("hidden"));
}

function recomputeTicketAutoShares() {
  if (paperState.ticketSharesEditedByUser) return;
  const st = paperState.ticketStock;
  if (!st) return;
  const sharesInput = document.getElementById("paper-order-shares");
  if (!sharesInput) return;
  const chosenW = getSelectedTicketWallet();
  const wCcy = (chosenW && chosenW.currency) || "INR";
  const sCcy = resolveStockCurrency(st);
  const fx = computeFxRate(sCcy, wCcy);
  const livePx = Number(st.price || st.live_price || st.current_price || 100);
  const avail = chosenW
    ? Number(chosenW.available_cash ?? Number(chosenW.cash_balance || 0) - Number(chosenW.reserved_cash || 0))
    : 100000;
  const autoSh = Math.max(1, Math.floor((avail * 0.1) / Math.max(0.01, livePx * fx)));
  sharesInput.value = String(Math.min(autoSh, 500));
}

async function syncTicketLiveQuote(ticker) {
  const cleanSym = String(ticker || "").trim().toUpperCase();
  if (!cleanSym) return;

  const reqSeq = ++paperState.ticketQuoteReqSeq;
  paperState.ticketQuoteSyncing = true;
  renderTicketStockSummary();

  try {
    const quote = await paperApiRequest(
      `/api/paper/quote?ticker=${encodeURIComponent(cleanSym)}`
    );
    if (reqSeq !== paperState.ticketQuoteReqSeq) return;

    const liveFx = Number(quote && quote.fx_usd_inr);
    if (Number.isFinite(liveFx) && liveFx > 1) {
      paperState.liveUsdInrFx = liveFx;
      if (paperState.overview) {
        paperState.overview.fx_usd_inr = liveFx;
        if (paperState.overview.active_portfolio) {
          paperState.overview.active_portfolio.fx_usd_inr = liveFx;
        }
      }
    }

    const livePx = Number(
      quote && (quote.close_price ?? quote.live_price ?? quote.price)
    );
    const canonicalSym = String((quote && quote.ticker) || cleanSym).toUpperCase();
    if (Number.isFinite(livePx) && livePx > 0) {
      paperState.liveQuoteCache.set(canonicalSym, quote);
      if (
        paperState.ticketStock &&
        String(paperState.ticketStock.ticker || "").toUpperCase() === canonicalSym
      ) {
        paperState.ticketStock = {
          ...paperState.ticketStock,
          price: livePx,
          live_price: livePx,
          current_price: livePx,
          native_currency:
            (quote && quote.native_currency) || resolveStockCurrency(paperState.ticketStock),
        };

        const limitInput = document.getElementById("paper-order-limit-price");
        if (limitInput && paperState.ticketActiveDipPct !== null) {
          const updatedLim = Math.max(
            0.05,
            livePx * (1 + paperState.ticketActiveDipPct / 100)
          );
          limitInput.value = updatedLim.toFixed(2);
        }
        recomputeTicketAutoShares();
      }
    }
  } catch (_quoteErr) {
    // Graceful fallback to cached/snapshot quote if offline
  } finally {
    if (reqSeq === paperState.ticketQuoteReqSeq) {
      paperState.ticketQuoteSyncing = false;
      if (isOrderTicketModalOpen()) {
        renderTicketStockSummary();
        renderTicketDipAndQtyChips();
        updateOrderTicketPreview();
      }
    }
  }
}

function renderTicketStockSummary() {
  const box = document.getElementById("paper-order-stock-summary");
  if (!box) return;
  box.replaceChildren();

  const st = paperState.ticketStock;
  if (!st) {
    box.appendChild(
      el("div", "muted-note", "Select or type a valid Nifty 200, Nasdaq 100, or S&P 500 ticker above.")
    );
    return;
  }

  const ccy = resolveStockCurrency(st);
  const px = Number(st.price || st.live_price || st.current_price || 0);
  const top = el("div", "ticket-stock-row");
  const left = el("div", "company-primary");
  left.appendChild(el("span", "", st.name || st.ticker));
  left.appendChild(el("span", "ticker-tag", st.ticker));
  left.appendChild(createIndexBadge(st));
  if (st.rating) {
    left.appendChild(el("span", ratingBadgeClass(st.rating), st.rating));
  }
  top.appendChild(left);

  const syncSuffix = paperState.ticketQuoteSyncing ? " ↻" : "";
  const right = el(
    "div",
    "company-primary text-cyan",
    `Live ${formatStockPrice(px, ccy)}${syncSuffix}${
      st.composite_score ? ` • Score ${Number(st.composite_score).toFixed(1)}` : ""
    }`
  );
  top.appendChild(right);
  box.appendChild(top);
}

function renderTicketDipAndQtyChips() {
  const dipChips = document.getElementById("paper-dip-chips");
  const qtyChips = document.getElementById("paper-qty-chips");
  const limitInput = document.getElementById("paper-order-limit-price");
  const sharesInput = document.getElementById("paper-order-shares");
  const noteInput = document.getElementById("paper-order-note");
  const st = paperState.ticketStock;
  const wallet = getSelectedTicketWallet();

  if (dipChips) {
    dipChips.replaceChildren();
    if (st && paperState.ticketOrderType === "LIMIT") {
      const stockCcy = resolveStockCurrency(st);
      const livePx = Number(st.price || st.live_price || st.current_price || 0);
      const presets =
        paperState.ticketSide === "BUY"
          ? [
              { label: "-3% Pullback", pct: -3 },
              { label: "-5% Dip", pct: -5 },
              { label: "-7% Dip (Ideal)", pct: -7 },
              { label: "-10% Deep Dip", pct: -10 },
              { label: "-12% Bargain", pct: -12 },
            ]
          : [
              { label: "+5% Target", pct: 5 },
              { label: "+10% Target", pct: 10 },
              { label: "+15% Target", pct: 15 },
              { label: "+20% Target", pct: 20 },
            ];
      for (const p of presets) {
        const targetPx = Math.max(0.05, livePx * (1 + p.pct / 100));
        const chipLabel =
          livePx > 0 ? `${p.label} · ${formatStockPrice(targetPx, stockCcy)}` : p.label;
        const chip = el("button", "chip-btn", chipLabel);
        chip.type = "button";
        chip.addEventListener("click", () => {
          paperState.ticketActiveDipPct = p.pct;
          const freshLivePx = Number(
            (paperState.ticketStock &&
              (paperState.ticketStock.price ||
                paperState.ticketStock.live_price ||
                paperState.ticketStock.current_price)) ||
              livePx
          );
          const freshTargetPx = Math.max(0.05, freshLivePx * (1 + p.pct / 100));
          limitInput.value = freshTargetPx.toFixed(2);
          if (noteInput && paperState.ticketSide === "BUY") {
            noteInput.value = `${p.pct}% Buy-on-Dip Limit Order`;
          }
          updateOrderTicketPreview();
        });
        dipChips.appendChild(chip);
      }
    }
  }

  if (qtyChips) {
    qtyChips.replaceChildren();
    if (!st || !wallet) return;

    if (paperState.ticketSide === "BUY") {
      const stockCcy = resolveStockCurrency(st);
      const walletCcy = wallet.currency || "INR";
      const fx = computeFxRate(stockCcy, walletCcy);
      const unitPx =
        paperState.ticketOrderType === "LIMIT"
          ? Number(limitInput.value || st.price || 1)
          : Number(st.price || 1);
      const avail = Number(
        wallet.available_cash ?? Number(wallet.cash_balance || 0) - Number(wallet.reserved_cash || 0)
      );
      for (const allocPct of [5, 10, 15, 25]) {
        const budget = avail * (allocPct / 100) * 0.996;
        const sh = Math.max(1, Math.floor(budget / Math.max(0.01, unitPx * fx)));
        const chip = el("button", "chip-btn", `${allocPct}% Cash (${sh} sh)`);
        chip.type = "button";
        chip.addEventListener("click", () => {
          paperState.ticketSharesEditedByUser = true;
          sharesInput.value = String(sh);
          updateOrderTicketPreview();
        });
        qtyChips.appendChild(chip);
      }
    } else {
      const ap = paperState.overview && paperState.overview.active_portfolio;
      const pos =
        ap &&
        Array.isArray(ap.positions) &&
        ap.positions.find((p) => p.ticker === st.ticker);
      const owned = pos ? Number(pos.sellable_shares ?? pos.shares ?? 0) : 0;
      if (owned > 0) {
        for (const [lbl, mult] of [
          ["Sell 25%", 0.25],
          ["Sell 50%", 0.5],
          ["Sell 100%", 1.0],
        ]) {
          const sh = Math.max(1, Math.round(owned * mult));
          const chip = el("button", "chip-btn", `${lbl} (${sh} sh)`);
          chip.type = "button";
          chip.addEventListener("click", () => {
            paperState.ticketSharesEditedByUser = true;
            sharesInput.value = String(sh);
            updateOrderTicketPreview();
          });
          qtyChips.appendChild(chip);
        }
      }
    }
  }
}

function syncOrderTicketModeButtons() {
  const buyBtn = document.getElementById("paper-side-buy-btn");
  const sellBtn = document.getElementById("paper-side-sell-btn");
  const mktBtn = document.getElementById("paper-type-market-btn");
  const limBtn = document.getElementById("paper-type-limit-btn");
  const limSec = document.getElementById("paper-limit-section");
  const submitBtn = document.getElementById("paper-order-submit-btn");

  if (buyBtn) buyBtn.classList.toggle("active", paperState.ticketSide === "BUY");
  if (sellBtn) sellBtn.classList.toggle("active", paperState.ticketSide === "SELL");
  if (mktBtn) mktBtn.classList.toggle("active", paperState.ticketOrderType === "MARKET");
  if (limBtn) {
    limBtn.classList.toggle("active", paperState.ticketOrderType === "LIMIT");
    limBtn.textContent =
      paperState.ticketSide === "BUY" ? "Buy-on-Dip Limit Order" : "Target Limit Sell";
  }
  if (limSec) {
    limSec.classList.toggle("hidden", paperState.ticketOrderType !== "LIMIT");
  }
  if (submitBtn) {
    if (paperState.ticketSide === "BUY" && paperState.ticketOrderType === "LIMIT") {
      submitBtn.textContent = "Place Buy-on-Dip Limit Order";
    } else if (paperState.ticketSide === "BUY") {
      submitBtn.textContent = "Execute Immediate Market Buy";
    } else if (paperState.ticketOrderType === "LIMIT") {
      submitBtn.textContent = "Place Target Limit Sell";
    } else {
      submitBtn.textContent = "Execute Immediate Market Sell";
    }
  }
}

function updateOrderTicketPreview() {
  const previewBox = document.getElementById("paper-order-preview-box");
  const distHint = document.getElementById("paper-limit-distance-hint");
  const limitInput = document.getElementById("paper-order-limit-price");
  const sharesInput = document.getElementById("paper-order-shares");
  if (!previewBox) return;
  previewBox.replaceChildren();

  const st = paperState.ticketStock;
  const wallet = getSelectedTicketWallet();
  if (!st || !wallet) {
    previewBox.appendChild(
      el(
        "div",
        "muted-note",
        !wallet
          ? "Create a Virtual Strategy Wallet first to preview live execution & fee math."
          : "Choose a stock above to preview order cost, 25 bps fee, and free cash remaining."
      )
    );
    return;
  }

  const stockCcy = resolveStockCurrency(st);
  const walletCcy = wallet.currency || "INR";
  const fx = computeFxRate(stockCcy, walletCcy);
  const livePx = Number(st.price || st.live_price || st.current_price || 0);
  const limPx = Number(limitInput.value || livePx);
  const shares = Math.max(0, Math.floor(Number(sharesInput.value || 0)));
  const feeBps = Number(wallet.fee_bps ?? 25);

  if (distHint && paperState.ticketOrderType === "LIMIT" && livePx > 0) {
    const dist = ((limPx - livePx) / livePx) * 100;
    if (paperState.ticketSide === "BUY" && limPx >= livePx) {
      distHint.textContent = `Limit (${formatStockPrice(
        limPx,
        stockCcy
      )}) is ≥ Live Price (${formatStockPrice(
        livePx,
        stockCcy
      )}) — order will fill immediately at Live Price!`;
      distHint.className = "field-hint text-warn";
    } else {
      distHint.textContent = `Distance from Live Price: ${fmtSigned(
        dist,
        2
      )}% • Triggers automatically when daily Low ≤ ${formatStockPrice(limPx, stockCcy)}`;
      distHint.className = "field-hint text-cyan";
    }
  }

  const unitNative = paperState.ticketOrderType === "LIMIT" ? limPx : livePx;
  const grossAmt = shares * unitNative * fx;
  const feeAmt = grossAmt * (feeBps / 10000);
  const totalImpact = paperState.ticketSide === "BUY" ? grossAmt + feeAmt : Math.max(0, grossAmt - feeAmt);
  const availCash = Number(
    wallet.available_cash ?? Number(wallet.cash_balance || 0) - Number(wallet.reserved_cash || 0)
  );
  const afterCash =
    paperState.ticketSide === "BUY" ? availCash - totalImpact : availCash + totalImpact;

  const rows = [
    [
      paperState.ticketOrderType === "LIMIT" ? "Target Limit Price" : "Live Execution Price",
      `${formatStockPrice(unitNative, stockCcy)}${
        fx !== 1 ? ` (FX ${fx.toFixed(2)} → ${walletCcy})` : ""
      }`,
      "",
    ],
    [
      "Gross Order Value",
      formatExactCurrency(grossAmt, walletCcy, 2),
      "",
    ],
    [
      `Estimated Brokerage & STT (${feeBps} bps)`,
      formatExactCurrency(feeAmt, walletCcy, 2),
      "muted-note",
    ],
    [
      paperState.ticketSide === "BUY"
        ? paperState.ticketOrderType === "LIMIT"
          ? "Total Cash Reserved Now"
          : "Total Cash Debited"
        : "Net Cash Credited",
      formatExactCurrency(totalImpact, walletCcy, 2),
      paperState.ticketSide === "BUY" ? "text-cyan" : "text-pos",
    ],
    [
      "Free Wallet Cash After Order",
      formatExactCurrency(afterCash, walletCcy, 2),
      afterCash < 0 ? "text-neg" : "text-pos",
    ],
  ];

  for (const [lbl, val, cls] of rows) {
    const r = el("div", "preview-kv-row");
    r.appendChild(el("span", "muted-note", lbl));
    r.appendChild(el("span", `company-primary ${cls}`.trim(), val));
    previewBox.appendChild(r);
  }
}

export async function openPaperOrderTicket(stockOrTicker = null, opts = {}) {
  const user = await getPaperUser();
  if (!user) {
    openPaperAuthModal("login", async () => {
      await loadPaperOverview();
      await openPaperOrderTicket(stockOrTicker, opts);
    });
    return;
  }

  if (!paperState.overview) {
    await loadPaperOverview();
  }

  const portfolios = (paperState.overview && paperState.overview.portfolios) || [];
  if (portfolios.length === 0) {
    const stCheck = resolveTicketStockObject(stockOrTicker);
    const wantUsd = stCheck && resolveStockCurrency(stCheck) === "USD";
    paperState.switchTab("paper");
    openNewWalletModal(
      wantUsd
        ? { name: "US Dip Hunter $10K", currency: "USD", cash: 10000, benchmark: "^GSPC" }
        : { name: "India QGLP ₹5L", currency: "INR", cash: 500000, benchmark: "^NSEI" }
    );
    paperState.showToast("Create your first Virtual Strategy Wallet, then place your order!");
    return;
  }

  populateStockDatalist();

  const backdrop = document.getElementById("paper-order-modal-backdrop");
  const modal = document.getElementById("paper-order-modal");
  const tkInput = document.getElementById("paper-order-ticker-input");
  const walletSel = document.getElementById("paper-order-wallet-select");
  const limitInput = document.getElementById("paper-order-limit-price");
  const sharesInput = document.getElementById("paper-order-shares");
  const noteInput = document.getElementById("paper-order-note");
  const errBox = document.getElementById("paper-order-error");

  errBox.classList.add("hidden");
  errBox.textContent = "";

  const resolvedStock =
    resolveTicketStockObject(stockOrTicker) ||
    applyCachedLiveQuote((paperState.getAllStocks() || [])[0] || null);
  paperState.ticketStock = resolvedStock;
  paperState.ticketSide = opts.side || "BUY";
  paperState.ticketOrderType = opts.orderType || "MARKET";
  paperState.ticketActiveDipPct = paperState.ticketSide === "BUY" ? -7 : 10;
  paperState.ticketSharesEditedByUser = Boolean(opts.defaultShares);

  if (tkInput) {
    tkInput.value = resolvedStock ? resolvedStock.ticker : "";
  }

  // Populate wallet dropdown & smart-match currency when opening from Leaderboard/Deep Dive
  const wantCurrency = resolvedStock ? resolveStockCurrency(resolvedStock) : null;
  walletSel.replaceChildren();
  for (const w of portfolios) {
    const avail = Number(
      w.available_cash ?? Number(w.cash_balance || 0) - Number(w.reserved_cash || 0)
    );
    const opt = el(
      "option",
      "",
      `${w.name} (${w.currency} • Free: ${formatCurrencyCompact(avail, w.currency)})`
    );
    opt.value = w.id;
    walletSel.appendChild(opt);
  }

  const activeId = paperState.activePortfolioId;
  const activeWallet = portfolios.find((w) => w.id === activeId);
  const matchingCcyWallet = wantCurrency
    ? portfolios.find((w) => w.currency === wantCurrency)
    : null;
  if (activeWallet && (!wantCurrency || activeWallet.currency === wantCurrency)) {
    walletSel.value = activeWallet.id;
  } else if (matchingCcyWallet) {
    walletSel.value = matchingCcyWallet.id;
  } else {
    walletSel.value = portfolios[0].id;
  }

  const livePx = resolvedStock
    ? Number(resolvedStock.price || resolvedStock.live_price || 100)
    : 100;
  const defaultLim =
    paperState.ticketSide === "BUY" ? livePx * 0.93 : livePx * 1.1;
  limitInput.value = Math.max(0.05, defaultLim).toFixed(2);

  if (opts.defaultShares) {
    sharesInput.value = String(Math.max(1, Math.floor(opts.defaultShares)));
  } else {
    const chosenW = getSelectedTicketWallet();
    const wCcy = (chosenW && chosenW.currency) || "INR";
    const sCcy = resolvedStock ? resolveStockCurrency(resolvedStock) : "INR";
    const fx = computeFxRate(sCcy, wCcy);
    const avail = chosenW
      ? Number(chosenW.available_cash ?? Number(chosenW.cash_balance || 0) - Number(chosenW.reserved_cash || 0))
      : 100000;
    const autoSh = Math.max(1, Math.floor((avail * 0.1) / Math.max(0.01, livePx * fx)));
    sharesInput.value = String(Math.min(autoSh, 500));
  }

  noteInput.value =
    paperState.ticketOrderType === "LIMIT" && paperState.ticketSide === "BUY"
      ? "-7% Buy-on-Dip Limit Order"
      : "";

  syncOrderTicketModeButtons();
  renderTicketStockSummary();
  renderTicketDipAndQtyChips();
  updateOrderTicketPreview();

  backdrop.classList.remove("hidden");
  modal.classList.remove("hidden");

  if (resolvedStock && resolvedStock.ticker) {
    void syncTicketLiveQuote(resolvedStock.ticker);
  }
}

export const openPaperTradeModal = openPaperOrderTicket;

function closePaperOrderTicket() {
  paperState.ticketQuoteReqSeq += 1;
  paperState.ticketQuoteSyncing = false;
  const backdrop = document.getElementById("paper-order-modal-backdrop");
  const modal = document.getElementById("paper-order-modal");
  if (backdrop) backdrop.classList.add("hidden");
  if (modal) modal.classList.add("hidden");
}

async function handleOrderTicketSubmit(ev) {
  ev.preventDefault();
  const errBox = document.getElementById("paper-order-error");
  const submitBtn = document.getElementById("paper-order-submit-btn");
  const tkInput = document.getElementById("paper-order-ticker-input");
  const walletSel = document.getElementById("paper-order-wallet-select");
  const sharesInput = document.getElementById("paper-order-shares");
  const limitInput = document.getElementById("paper-order-limit-price");
  const noteInput = document.getElementById("paper-order-note");

  errBox.classList.add("hidden");
  const ticker = String(tkInput.value || "").trim().toUpperCase();
  const st = resolveTicketStockObject(ticker);
  const canonicalTicker = st ? st.ticker : ticker;
  const portfolioId = walletSel.value;
  const shares = Math.floor(Number(sharesInput.value || 0));

  if (!canonicalTicker) {
    errBox.textContent = "Select a valid company ticker.";
    errBox.classList.remove("hidden");
    return;
  }
  if (!portfolioId) {
    errBox.textContent = "Select a target Paper Strategy Wallet.";
    errBox.classList.remove("hidden");
    return;
  }
  if (!Number.isFinite(shares) || shares <= 0) {
    errBox.textContent = "Shares quantity must be at least 1 whole share.";
    errBox.classList.remove("hidden");
    return;
  }

  const payload = {
    portfolio_id: portfolioId,
    ticker: canonicalTicker,
    side: paperState.ticketSide,
    order_type: paperState.ticketOrderType,
    shares,
    note: noteInput.value.trim(),
  };

  if (paperState.ticketOrderType === "LIMIT") {
    const limPx = Number(limitInput.value || 0);
    if (!Number.isFinite(limPx) || limPx <= 0) {
      errBox.textContent = "Enter a valid positive limit price.";
      errBox.classList.remove("hidden");
      return;
    }
    payload.limit_price = limPx;
  }

  const prevLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting Order...";

  try {
    const res = await paperApiRequest("/api/paper/orders", {
      method: "POST",
      jsonBody: payload,
    });
    const ordStatus = res.order && res.order.status;
    paperState.activePortfolioId = portfolioId;
    applyOverviewEnvelope(res);
    closePaperOrderTicket();
    if (isPaperTabActive()) {
      if (payload.order_type === "LIMIT" && ordStatus !== "FILLED") {
        setPaperSubtab("orders");
      } else if (payload.order_type === "MARKET" || ordStatus === "FILLED") {
        setPaperSubtab("positions");
      }
    }
    await loadPaperOverview(portfolioId);

    if (ordStatus === "OPEN") {
      paperState.showToast(
        `Queued ${payload.side} LIMIT (${shares} sh ${displaySymbol(
          canonicalTicker
        )} @ ${payload.limit_price})`
      );
    } else {
      paperState.showToast(
        `Filled ${payload.side} ${shares} sh ${displaySymbol(canonicalTicker)}.`
      );
    }
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = prevLabel;
  }
}

// ============================================================================
// Modal 4: Deploy Investment Planner Blueprint to Paper Wallet (Tab 2 -> Tab 4)
// ============================================================================

function computeBlueprintDeployItems(plan, dipPct = 7.0) {
  const basket = (plan && Array.isArray(plan.stock_basket) && plan.stock_basket) || [];
  const items = [];
  for (const s of basket) {
    const totalSh = Math.max(0, Math.floor(Number(s.est_shares || 0)));
    if (totalSh <= 0) continue;
    const isStaggered =
      String(s.entry_guidance || "").toLowerCase().includes("stagger") ||
      Number(s.pe_ratio || 0) > Number(s.fair_pe || 999) * 1.08;

    let mktSh = totalSh;
    let dipSh = 0;
    if (isStaggered && totalSh > 1) {
      mktSh = Math.max(1, Math.ceil(totalSh * 0.6));
      dipSh = Math.max(0, totalSh - mktSh);
    }
    const nativePx = Number(s.price || 0);
    const nativeCcy = resolveStockCurrency(s);
    const dipTargetPx = Number((nativePx * (1 - dipPct / 100)).toFixed(2));
    items.push({
      ticker: s.ticker,
      name: s.name || s.ticker,
      index_tag: s.index_tag,
      nativeCcy,
      nativePx,
      dipTargetPx,
      market_shares: mktSh,
      dip_shares: dipSh,
      dip_pct: dipPct,
    });
  }
  return items;
}

function renderDeployBlueprintPreview() {
  const plan = paperState.pendingPlan;
  if (!plan) return;

  const dipPct = Math.max(1, Math.min(30, Number(document.getElementById("paper-deploy-dip-pct").value || 7)));
  const items = computeBlueprintDeployItems(plan, dipPct);
  paperState.pendingDeployItems = items;

  const walletSel = document.getElementById("paper-deploy-wallet-select");
  const newFields = document.getElementById("paper-deploy-new-wallet-fields");
  const isNewWallet = walletSel.value === "__NEW__";
  newFields.classList.toggle("hidden", !isNewWallet);

  const planCcy = plan.plan_currency || "INR";
  let targetWalletCcy = planCcy;
  if (!isNewWallet && paperState.overview && Array.isArray(paperState.overview.portfolios)) {
    const w = paperState.overview.portfolios.find((p) => p.id === walletSel.value);
    if (w) targetWalletCcy = w.currency;
  }

  const tbody = document.getElementById("paper-deploy-preview-tbody");
  tbody.replaceChildren();

  let totalReqWithFees = 0;
  let totalMktShares = 0;
  let totalDipOrders = 0;

  for (const it of items) {
    const tr = document.createElement("tr");
    const fx = computeFxRate(it.nativeCcy, targetWalletCcy);
    const mktCost = it.market_shares * it.nativePx * fx * 1.0025;
    const dipReserve = it.dip_shares * it.dipTargetPx * fx * 1.0025;
    const rowTotal = mktCost + dipReserve;
    totalReqWithFees += rowTotal;
    totalMktShares += it.market_shares;
    if (it.dip_shares > 0) totalDipOrders += 1;

    const cTd = document.createElement("td");
    const line = el("div", "company-primary");
    line.appendChild(el("span", "", it.name));
    line.appendChild(el("span", "ticker-tag", displaySymbol(it.ticker)));
    line.appendChild(createIndexBadge(it));
    cTd.appendChild(line);
    tr.appendChild(cTd);

    tr.appendChild(
      el(
        "td",
        "text-pos company-primary",
        `${it.market_shares} sh @ Market (${formatStockPrice(it.nativePx, it.nativeCcy)})`
      )
    );
    tr.appendChild(
      el(
        "td",
        it.dip_shares > 0 ? "text-cyan company-primary" : "muted-note",
        it.dip_shares > 0
          ? `${it.dip_shares} sh @ -${dipPct}% Dip (${formatStockPrice(it.dipTargetPx, it.nativeCcy)})`
          : "0 sh (100% Fair P/E)"
      )
    );
    tr.appendChild(
      el("td", "", formatExactCurrency(rowTotal, targetWalletCcy, targetWalletCcy === "USD" ? 2 : 0))
    );
    tbody.appendChild(tr);
  }

  const noteEl = document.getElementById("paper-deploy-summary-note");
  if (noteEl) {
    noteEl.textContent = `Deploying ${items.length} stocks (${totalMktShares} immediate Market shares + ${totalDipOrders} automated -${dipPct}% Buy-on-Dip limit orders) • Total Capital + 25 bps Fees: ${formatExactCurrency(
      totalReqWithFees,
      targetWalletCcy
    )}`;
  }

  const cashInput = document.getElementById("paper-deploy-new-wallet-cash");
  if (isNewWallet && cashInput) {
    const stepUnit = planCcy === "USD" ? 500 : 10000;
    const recommendedCash = Math.max(
      Number((plan.goal_summary && plan.goal_summary.lump_sum_inr) || 0),
      Math.ceil((totalReqWithFees * 1.02) / stepUnit) * stepUnit
    );
    if (!cashInput.dataset.userEdited) {
      cashInput.value = String(recommendedCash);
    }
  }
}

export async function openDeployBlueprintModal(plan) {
  if (!plan || !Array.isArray(plan.stock_basket) || plan.stock_basket.length === 0) {
    paperState.showToast("Build an Investment Blueprint first before deploying to a Paper Wallet.", true);
    return;
  }

  const user = await getPaperUser();
  if (!user) {
    openPaperAuthModal("login", async () => {
      await loadPaperOverview();
      await openDeployBlueprintModal(plan);
    });
    return;
  }

  if (!paperState.overview) {
    await loadPaperOverview();
  }

  paperState.pendingPlan = plan;
  const planCcy = plan.plan_currency || "INR";
  const mktLabel =
    plan.market === "NASDAQ100"
      ? "Nasdaq 100"
      : plan.market === "SP500"
      ? "S&P 500"
      : plan.market === "US"
      ? "US Compounder"
      : plan.market === "IN"
      ? "India Nifty 200"
      : "Global Compounder";

  const walletSel = document.getElementById("paper-deploy-wallet-select");
  const newNameIn = document.getElementById("paper-deploy-new-wallet-name");
  const newCashIn = document.getElementById("paper-deploy-new-wallet-cash");
  const errBox = document.getElementById("paper-deploy-error");

  errBox.classList.add("hidden");
  errBox.textContent = "";
  delete newCashIn.dataset.userEdited;

  newNameIn.value = `${mktLabel} Blueprint (${planCcy === "USD" ? "$" : "₹"})`;

  const portfolios = (paperState.overview && paperState.overview.portfolios) || [];
  const sameCcyWallets = portfolios.filter((w) => w.currency === planCcy);

  walletSel.replaceChildren();
  const newOpt = el(
    "option",
    "",
    `✨ Create New Dedicated ${planCcy} Strategy Wallet for This Blueprint`
  );
  newOpt.value = "__NEW__";
  walletSel.appendChild(newOpt);

  for (const w of sameCcyWallets) {
    const avail = Number(
      w.available_cash ?? Number(w.cash_balance || 0) - Number(w.reserved_cash || 0)
    );
    const opt = el(
      "option",
      "",
      `${w.name} (${w.currency} • Available Cash: ${formatExactCurrency(avail, w.currency)})`
    );
    opt.value = w.id;
    walletSel.appendChild(opt);
  }

  walletSel.value = "__NEW__";
  renderDeployBlueprintPreview();

  document.getElementById("paper-deploy-modal-backdrop").classList.remove("hidden");
  document.getElementById("paper-deploy-modal").classList.remove("hidden");
}

function closeDeployBlueprintModal() {
  const backdrop = document.getElementById("paper-deploy-modal-backdrop");
  const modal = document.getElementById("paper-deploy-modal");
  if (backdrop) backdrop.classList.add("hidden");
  if (modal) modal.classList.add("hidden");
}

async function handleDeployBlueprintSubmit(ev) {
  ev.preventDefault();
  const plan = paperState.pendingPlan;
  if (!plan) return;

  const errBox = document.getElementById("paper-deploy-error");
  const confirmBtn = document.getElementById("paper-deploy-confirm-btn");
  const walletSel = document.getElementById("paper-deploy-wallet-select");
  const dipPct = Math.max(1, Math.min(30, Number(document.getElementById("paper-deploy-dip-pct").value || 7)));
  const items = computeBlueprintDeployItems(plan, dipPct);

  errBox.classList.add("hidden");
  if (items.length === 0) {
    errBox.textContent = "No deployable whole-share stock positions in this blueprint.";
    errBox.classList.remove("hidden");
    return;
  }

  confirmBtn.disabled = true;
  confirmBtn.textContent = "Deploying Basket & Queuing Dip Orders...";

  try {
    let targetPortfolioId = walletSel.value;
    const planCcy = plan.plan_currency || "INR";

    if (targetPortfolioId === "__NEW__") {
      const wName =
        document.getElementById("paper-deploy-new-wallet-name").value.trim() ||
        `${planCcy} Planner Basket`;
      const initCash = Number(document.getElementById("paper-deploy-new-wallet-cash").value || 0);
      if (!Number.isFinite(initCash) || initCash <= 0) {
        throw new Error("Enter a positive starting virtual cash balance for the new wallet.");
      }
      const bm =
        plan.market === "NASDAQ100"
          ? "^NDX"
          : planCcy === "USD"
          ? "^GSPC"
          : "^NSEI";
      const createdRes = await paperApiRequest("/api/paper/portfolios", {
        method: "POST",
        jsonBody: {
          name: wName,
          currency: planCcy,
          initial_cash: initCash,
          strategy_preset: "qglp_compounder",
          benchmark_ticker: bm,
        },
      });
      targetPortfolioId =
        createdRes.created_portfolio_id ||
        (createdRes.portfolio && createdRes.portfolio.id) ||
        (createdRes.active_portfolio && createdRes.active_portfolio.id);
    }

    const deployRes = await paperApiRequest("/api/paper/deploy-basket", {
      method: "POST",
      jsonBody: {
        portfolio_id: targetPortfolioId,
        items: items.map((it) => ({
          ticker: it.ticker,
          market_shares: it.market_shares,
          dip_shares: it.dip_shares,
          dip_pct: it.dip_pct,
          note: `Planner Blueprint -${it.dip_pct}% Dip Tranche`,
        })),
      },
    });

    paperState.activePortfolioId = targetPortfolioId;
    applyOverviewEnvelope(deployRes);
    closeDeployBlueprintModal();
    setPaperSubtab("positions");
    paperState.switchTab("paper");
    await loadPaperOverview(targetPortfolioId);

    const mktCount =
      (deployRes.deployed && deployRes.deployed.market_fills_count) ??
      (Array.isArray(deployRes.filled_orders) ? deployRes.filled_orders.length : items.length);
    const dipCount =
      (deployRes.deployed && deployRes.deployed.limit_orders_count) ??
      (Array.isArray(deployRes.queued_orders)
        ? deployRes.queued_orders.length
        : items.filter((x) => x.dip_shares > 0).length);

    paperState.showToast(
      `Deployed ${mktCount} market buys & queued ${dipCount} -${dipPct}% Dip Orders.`
    );
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "🚀 Execute Market Tranche & Queue Dip Orders";
  }
}

// ============================================================================
// Refresh Live Quotes & Trigger Limit Order Evaluation
// ============================================================================

async function handleRefreshPaperQuotes() {
  const btn = document.getElementById("paper-refresh-quotes-btn");
  if (!btn || paperState.manualRefreshInFlight) return;
  paperState.manualRefreshInFlight = true;
  btn.disabled = true;
  btn.textContent = "Syncing...";

  try {
    const activeId = paperState.activePortfolioId;
    const reqBody = activeId
      ? { portfolio_id: activeId, market_scope: "ALL" }
      : { market_scope: "ALL" };
    const res = await paperApiRequest("/api/paper/refresh", {
      method: "POST",
      jsonBody: reqBody,
    });
    const refreshedAt = Date.now();
    if (activeId) {
      paperState.lastAutoRefreshMs.set(`${activeId}::IN`, refreshedAt);
      paperState.lastAutoRefreshMs.set(`${activeId}::US`, refreshedAt);
    }
    applyOverviewEnvelope(res);
    await loadPaperOverview(paperState.activePortfolioId, { skipAutoRefresh: true });

    const summary = res.refresh_summary || res;
    const qUpdated = Number(summary.quotes_updated ?? 0);
    const oFilled = Number(summary.orders_filled ?? 0);
    if (oFilled > 0) {
      paperState.showToast(
        `Synced ${qUpdated} quotes · ${oFilled} Dip Order(s) filled!`
      );
    } else {
      paperState.showToast(
        `Synced ${qUpdated} live quotes.`
      );
    }
  } catch (err) {
    paperState.showToast(err.message, true);
  } finally {
    paperState.manualRefreshInFlight = false;
    btn.disabled = false;
    btn.textContent = "↻ Sync Quotes";
    renderPaperSessionPill();
  }
}

function handleDocumentVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  if (!isPaperTabActive() || !isPaperSignedInViewVisible()) return;
  renderPaperSessionPill();
  void maybeTriggerSmartAutoRefresh();
}

// ============================================================================
// Tab 4 Sign-In Form Handlers & Initialization
// ============================================================================

async function handleTabLoginSubmit(ev) {
  ev.preventDefault();
  const emailIn = document.getElementById("paper-login-email");
  const passIn = document.getElementById("paper-login-password");
  const errBox = document.getElementById("paper-login-error");
  const btn = document.getElementById("paper-login-submit-btn");

  errBox.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "Signing In...";
  try {
    await loginPaperUser(emailIn.value, passIn.value);
    passIn.value = "";
    await loadPaperOverview();
    paperState.showToast("Signed in to Paper Wallet.");
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
}

async function handleForgotPasswordClick() {
  const emailVal = document.getElementById("paper-login-email").value.trim();
  const errBox = document.getElementById("paper-login-error");
  errBox.classList.add("hidden");
  try {
    await requestPaperPasswordReset(emailVal);
    paperState.showToast("Password recovery link sent! Check your inbox.");
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove("hidden");
  }
}

export function closeAllPaperModals() {
  closeNewWalletModal();
  closeDepositModal();
  closePaperOrderTicket();
  closeDeployBlueprintModal();
}

export function initPaperTradingUI(callbacks = {}) {
  if (typeof callbacks.getStaticMode === "function") paperState.getStaticMode = callbacks.getStaticMode;
  if (typeof callbacks.getCsrfToken === "function") paperState.getCsrfToken = callbacks.getCsrfToken;
  if (typeof callbacks.getAllStocks === "function") paperState.getAllStocks = callbacks.getAllStocks;
  if (typeof callbacks.findStockByTicker === "function") paperState.findStockByTicker = callbacks.findStockByTicker;
  if (typeof callbacks.openDeepDive === "function") paperState.openDeepDive = callbacks.openDeepDive;
  if (typeof callbacks.switchTab === "function") paperState.switchTab = callbacks.switchTab;
  if (typeof callbacks.showToast === "function") paperState.showToast = callbacks.showToast;

  if (paperState.initialized) return;
  paperState.initialized = true;

  // Signed-out Tab 4 Sign-In form
  document.getElementById("paper-login-form").addEventListener("submit", handleTabLoginSubmit);
  document.getElementById("paper-forgot-password-btn").addEventListener("click", handleForgotPasswordClick);

  // Command bar buttons
  document.getElementById("paper-new-wallet-btn").addEventListener("click", () => openNewWalletModal());
  document.getElementById("paper-open-deposit-btn").addEventListener("click", openDepositModal);
  document.getElementById("paper-quick-order-btn").addEventListener("click", () =>
    openPaperOrderTicket(null, { side: "BUY", orderType: "LIMIT" })
  );
  document.getElementById("paper-refresh-quotes-btn").addEventListener("click", handleRefreshPaperQuotes);
  document.getElementById("paper-signout-btn").addEventListener("click", logoutPaperUser);

  // 4-Section Wallet Sub-Tab Bar
  const subtabBar = document.getElementById("paper-subtab-bar");
  if (subtabBar) {
    subtabBar.addEventListener("click", (ev) => {
      const btn =
        ev.target && typeof ev.target.closest === "function"
          ? ev.target.closest("[data-paper-subtab]")
          : null;
      if (btn) {
        const tabKey = btn.getAttribute("data-paper-subtab");
        if (tabKey) setPaperSubtab(tabKey);
      }
    });
  }
  const subtabPosBtn = document.getElementById("paper-subtab-positions");
  if (subtabPosBtn) subtabPosBtn.addEventListener("click", () => setPaperSubtab("positions"));
  const subtabOrdBtn = document.getElementById("paper-subtab-orders");
  if (subtabOrdBtn) subtabOrdBtn.addEventListener("click", () => setPaperSubtab("orders"));
  const subtabTrdBtn = document.getElementById("paper-subtab-trades");
  if (subtabTrdBtn) subtabTrdBtn.addEventListener("click", () => setPaperSubtab("trades"));
  const subtabAttrBtn = document.getElementById("paper-subtab-attribution");
  if (subtabAttrBtn) subtabAttrBtn.addEventListener("click", () => setPaperSubtab("attribution"));

  // Empty wallet 1-click onboarding
  document.getElementById("paper-quick-create-inr-btn").addEventListener("click", () =>
    createQuickWallet(WALLET_TEMPLATES[0])
  );
  document.getElementById("paper-quick-create-usd-btn").addEventListener("click", () =>
    createQuickWallet(WALLET_TEMPLATES[2])
  );
  document.getElementById("paper-empty-custom-btn").addEventListener("click", () =>
    openNewWalletModal()
  );

  // Wallet modal
  document.getElementById("paper-wallet-form").addEventListener("submit", handleCreateWalletSubmit);
  document.getElementById("paper-wallet-close-btn").addEventListener("click", closeNewWalletModal);
  document.getElementById("paper-wallet-modal-backdrop").addEventListener("click", closeNewWalletModal);
  document.getElementById("paper-wallet-currency").addEventListener("change", (ev) => {
    const isUsd = ev.target.value === "USD";
    document.getElementById("paper-wallet-cash").value = isUsd ? "10000" : "500000";
    document.getElementById("paper-wallet-benchmark").value = isUsd ? "^GSPC" : "^NSEI";
  });

  // Deposit modal
  document.getElementById("paper-deposit-form").addEventListener("submit", handleDepositSubmit);
  document.getElementById("paper-deposit-close-btn").addEventListener("click", closeDepositModal);
  document.getElementById("paper-deposit-modal-backdrop").addEventListener("click", closeDepositModal);

  // Order Ticket modal
  document.getElementById("paper-order-form").addEventListener("submit", handleOrderTicketSubmit);
  document.getElementById("paper-order-close-btn").addEventListener("click", closePaperOrderTicket);
  document.getElementById("paper-order-modal-backdrop").addEventListener("click", closePaperOrderTicket);

  document.getElementById("paper-order-ticker-input").addEventListener("input", (ev) => {
    const match = resolveTicketStockObject(ev.target.value);
    if (match) {
      const prevTicker =
        paperState.ticketStock && String(paperState.ticketStock.ticker || "").toUpperCase();
      paperState.ticketStock = match;
      paperState.ticketActiveDipPct = paperState.ticketSide === "BUY" ? -7 : 10;
      const livePx = Number(match.price || match.live_price || 100);
      document.getElementById("paper-order-limit-price").value = Math.max(
        0.05,
        paperState.ticketSide === "BUY" ? livePx * 0.93 : livePx * 1.1
      ).toFixed(2);
      recomputeTicketAutoShares();
      renderTicketStockSummary();
      renderTicketDipAndQtyChips();
      updateOrderTicketPreview();
      if (String(match.ticker || "").toUpperCase() !== prevTicker) {
        void syncTicketLiveQuote(match.ticker);
      }
    }
  });

  document.getElementById("paper-order-wallet-select").addEventListener("change", () => {
    recomputeTicketAutoShares();
    renderTicketDipAndQtyChips();
    updateOrderTicketPreview();
  });

  document.getElementById("paper-side-buy-btn").addEventListener("click", () => {
    paperState.ticketSide = "BUY";
    paperState.ticketActiveDipPct = -7;
    if (paperState.ticketStock) {
      const px = Number(paperState.ticketStock.price || 100);
      document.getElementById("paper-order-limit-price").value = (px * 0.93).toFixed(2);
    }
    syncOrderTicketModeButtons();
    renderTicketDipAndQtyChips();
    updateOrderTicketPreview();
  });

  document.getElementById("paper-side-sell-btn").addEventListener("click", () => {
    paperState.ticketSide = "SELL";
    paperState.ticketActiveDipPct = 10;
    if (paperState.ticketStock) {
      const px = Number(paperState.ticketStock.price || 100);
      document.getElementById("paper-order-limit-price").value = (px * 1.1).toFixed(2);
    }
    syncOrderTicketModeButtons();
    renderTicketDipAndQtyChips();
    updateOrderTicketPreview();
  });

  document.getElementById("paper-type-market-btn").addEventListener("click", () => {
    paperState.ticketOrderType = "MARKET";
    syncOrderTicketModeButtons();
    renderTicketDipAndQtyChips();
    updateOrderTicketPreview();
  });

  document.getElementById("paper-type-limit-btn").addEventListener("click", () => {
    paperState.ticketOrderType = "LIMIT";
    syncOrderTicketModeButtons();
    renderTicketDipAndQtyChips();
    updateOrderTicketPreview();
  });

  document.getElementById("paper-order-limit-price").addEventListener("input", () => {
    paperState.ticketActiveDipPct = null;
    updateOrderTicketPreview();
  });
  document.getElementById("paper-order-shares").addEventListener("input", () => {
    paperState.ticketSharesEditedByUser = true;
    updateOrderTicketPreview();
  });

  // Deploy Planner Blueprint modal
  document.getElementById("paper-deploy-form").addEventListener("submit", handleDeployBlueprintSubmit);
  document.getElementById("paper-deploy-close-btn").addEventListener("click", closeDeployBlueprintModal);
  document.getElementById("paper-deploy-modal-backdrop").addEventListener("click", closeDeployBlueprintModal);
  document.getElementById("paper-deploy-wallet-select").addEventListener("change", renderDeployBlueprintPreview);
  document.getElementById("paper-deploy-dip-pct").addEventListener("change", renderDeployBlueprintPreview);
  document.getElementById("paper-deploy-new-wallet-cash").addEventListener("input", (ev) => {
    ev.target.dataset.userEdited = "1";
  });

  // Market-hours-aware 5-minute auto-refresh on browser tab visibility restore + 60s pill label ticker
  document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
  paperState.sessionTickerTimerId = window.setInterval(() => {
    if (
      document.visibilityState === "visible" &&
      isPaperTabActive() &&
      isPaperSignedInViewVisible() &&
      !paperState.autoRefreshInFlight
    ) {
      renderPaperSessionPill();
    }
  }, 60000);
}
