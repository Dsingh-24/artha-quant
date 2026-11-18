// ArthaQuant V4.0 — Modular Invite-Only Authentication Client
// Cloud Mode: Uses bundled @netlify/identity (/static/vendor/netlify_identity.js)
// Local Mode: Uses FastAPI HttpOnly cookie session (/api/auth/*)
// Built exclusively with safe DOM APIs (createElement, textContent) and zero Web Storage.

const NETLIFY_IDENTITY_SETUP_URL = "https://app.netlify.com/projects/arthaquant-india/identity";
const ALLOWED_OAUTH_PROVIDERS = ["google", "github", "gitlab", "bitbucket"];
const OAUTH_LABELS = {
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

const authState = {
  initialized: false,
  staticMode: false,
  identityMod: null,
  identityConfigured: true,
  identityErrorDetail: "",
  enabledOAuthProviders: [],
  cloudUser: null,
  pendingInviteToken: null,
  pendingRecoveryToken: null,
  modalMode: "login",
  pendingAuthSuccessCb: null,
  getLocalUsername: () => null,
  getCsrfToken: () => null,
  showToast: () => {},
  onAuthChanged: () => {},
};

function domEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function maskUserIdentity(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "Advisor";
  const atIdx = raw.indexOf("@");
  if (atIdx > 0) {
    const localPart = raw.slice(0, atIdx);
    const domainPart = raw.slice(atIdx + 1);
    const visiblePrefix = localPart.length <= 2 ? localPart.slice(0, 1) : localPart.slice(0, 2);
    return `${visiblePrefix}***@${domainPart}`;
  }
  if (raw.length > 18) {
    return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
  }
  return raw;
}

export function validateStrongPassword(password) {
  const pw = String(password || "");
  if (pw.length < 8) {
    return "Password must be at least 8 characters long (12+ characters recommended).";
  }
  if (pw.length > 128) {
    return "Password must be 128 characters or fewer.";
  }
  return null;
}

function normalizeCloudUser(userObj) {
  if (!userObj || typeof userObj !== "object") return null;
  const uid = String(userObj.id || userObj.sub || "").trim();
  const email = String(userObj.email || "").trim();
  if (!uid && !email) return null;
  const fullName =
    (userObj.user_metadata && userObj.user_metadata.full_name) ||
    (userObj.userMetadata && userObj.userMetadata.full_name) ||
    "";
  const roles =
    (Array.isArray(userObj.roles) && userObj.roles) ||
    (userObj.app_metadata && Array.isArray(userObj.app_metadata.roles) && userObj.app_metadata.roles) ||
    [];
  return {
    id: uid || email,
    email,
    displayLabel: fullName ? String(fullName) : maskUserIdentity(email || uid),
    maskedEmail: maskUserIdentity(email || uid),
    roles,
    provider: "netlify_identity",
  };
}

function extractEnabledOAuthProviders(settings) {
  if (!settings || typeof settings !== "object") return [];
  const enabled = [];

  const objMap =
    settings.providers && typeof settings.providers === "object" && !Array.isArray(settings.providers)
      ? settings.providers
      : settings.external && typeof settings.external === "object"
      ? settings.external
      : null;

  if (objMap) {
    for (const provider of ALLOWED_OAUTH_PROVIDERS) {
      if (Boolean(objMap[provider]) === true) {
        enabled.push(provider);
      }
    }
    return enabled;
  }

  const listCandidate = Array.isArray(settings.externalProviders)
    ? settings.externalProviders
    : Array.isArray(settings.providers)
    ? settings.providers
    : [];
  for (const item of listCandidate) {
    const norm = String(item || "").toLowerCase().trim();
    if (ALLOWED_OAUTH_PROVIDERS.includes(norm) && !enabled.includes(norm)) {
      enabled.push(norm);
    }
  }
  return enabled;
}

async function loadNetlifyIdentityBundle() {
  if (authState.identityMod) return authState.identityMod;
  try {
    const mod = await import("/static/vendor/netlify_identity.js");
    authState.identityMod = mod;
    return mod;
  } catch (_err) {
    authState.identityConfigured = false;
    authState.identityErrorDetail =
      "Netlify Identity client bundle is unavailable on this static host. Test auth flows on a live Netlify deploy.";
    return null;
  }
}

async function fetchAndApplyIdentitySettings(mod) {
  if (!mod || typeof mod.getSettings !== "function") {
    authState.identityConfigured = false;
    return;
  }
  try {
    const settings = await mod.getSettings();
    authState.identityConfigured = true;
    authState.identityErrorDetail = "";
    authState.enabledOAuthProviders = extractEnabledOAuthProviders(settings);
  } catch (_settingsErr) {
    authState.identityConfigured = false;
    authState.enabledOAuthProviders = [];
    authState.identityErrorDetail =
      "Netlify Identity is not yet enabled on this site (or is running outside a Netlify deploy). Follow the 2-step setup guide below.";
  }
}

export function getIdentityStatus() {
  return {
    staticMode: authState.staticMode,
    identityConfigured: authState.identityConfigured,
    identityErrorDetail: authState.identityErrorDetail,
    enabledOAuthProviders: [...authState.enabledOAuthProviders],
    setupUrl: NETLIFY_IDENTITY_SETUP_URL,
  };
}

export function renderDynamicOAuthButtons(wrapId, mountId) {
  const wrapEl = document.getElementById(wrapId);
  const mountEl = document.getElementById(mountId);
  if (!wrapEl || !mountEl) return;

  mountEl.replaceChildren();
  if (!authState.staticMode || authState.enabledOAuthProviders.length === 0) {
    wrapEl.classList.add("hidden");
    return;
  }

  wrapEl.classList.remove("hidden");
  for (const provider of authState.enabledOAuthProviders) {
    const label = OAUTH_LABELS[provider] || provider;
    const btn = domEl("button", "btn btn-ghost btn-oauth", `Continue with ${label} (Invited Email)`);
    btn.type = "button";
    btn.addEventListener("click", () => {
      if (authState.identityMod && typeof authState.identityMod.oauthLogin === "function") {
        try {
          authState.identityMod.oauthLogin(provider);
        } catch (_redirectSignal) {
          // @netlify/identity throws AuthError("Redirecting to OAuth provider") immediately after setting location.href
        }
      }
    });
    mountEl.appendChild(btn);
  }
}

function syncIdentityGuideVisibility() {
  const tabGuide = document.getElementById("paper-identity-setup-guide");
  const modalGuide = document.getElementById("paper-auth-modal-admin-note");
  const showGuide = Boolean(authState.staticMode && !authState.identityConfigured);
  if (tabGuide) tabGuide.classList.toggle("hidden", !showGuide);
  if (modalGuide) modalGuide.classList.toggle("hidden", !showGuide);

  renderDynamicOAuthButtons("paper-oauth-wrap", "paper-oauth-buttons");
  renderDynamicOAuthButtons("paper-auth-modal-oauth-wrap", "paper-auth-modal-oauth-btns");

  const topAuthBtn = document.getElementById("paper-auth-top-btn");
  if (topAuthBtn) {
    if (authState.staticMode && authState.cloudUser) {
      topAuthBtn.textContent = `Paper: ${authState.cloudUser.maskedEmail} · Sign Out`;
      topAuthBtn.classList.remove("hidden");
    } else {
      topAuthBtn.classList.add("hidden");
    }
  }
}

export async function getPaperUser() {
  if (!authState.staticMode) {
    const localName = authState.getLocalUsername();
    if (!localName) return null;
    return {
      id: `local:${localName}`,
      username: localName,
      displayLabel: maskUserIdentity(localName),
      maskedEmail: maskUserIdentity(localName),
      roles: ["advisor"],
      provider: "local_fastapi",
    };
  }

  if (authState.cloudUser) {
    return authState.cloudUser;
  }
  const mod = await loadNetlifyIdentityBundle();
  if (!mod || typeof mod.getUser !== "function") {
    return null;
  }
  try {
    const u = await mod.getUser();
    authState.cloudUser = normalizeCloudUser(u);
    syncIdentityGuideVisibility();
    return authState.cloudUser;
  } catch (_err) {
    return null;
  }
}

export async function loginPaperUser(email, password) {
  const cleanEmail = String(email || "").trim();
  const pwErr = validateStrongPassword(password);
  if (!cleanEmail) {
    throw new Error("Please enter your invited email address.");
  }
  if (pwErr) {
    throw new Error(pwErr);
  }

  if (!authState.staticMode) {
    const headers = { "Content-Type": "application/json" };
    const csrf = authState.getCsrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
    const resp = await window.fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({ username: cleanEmail, password }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.detail || "Unable to sign in to local workspace.");
    }
    const user = await getPaperUser();
    authState.onAuthChanged(user);
    return user;
  }

  const mod = await loadNetlifyIdentityBundle();
  if (!mod || typeof mod.login !== "function") {
    throw new Error(
      `Netlify Identity is not enabled yet. Configure Invite-Only Identity at ${NETLIFY_IDENTITY_SETUP_URL}`
    );
  }

  try {
    const rawUser = await mod.login(cleanEmail, password);
    authState.cloudUser = normalizeCloudUser(rawUser) || (await getPaperUser());
    syncIdentityGuideVisibility();
    authState.onAuthChanged(authState.cloudUser);
    return authState.cloudUser;
  } catch (err) {
    const msg = (err && err.message) || "Sign-in failed.";
    if (msg.includes("404") || msg.toLowerCase().includes("failed to fetch")) {
      authState.identityConfigured = false;
      syncIdentityGuideVisibility();
      throw new Error(
        `Netlify Identity endpoint (/.netlify/identity) is not enabled yet. Enable Invite-Only Identity at ${NETLIFY_IDENTITY_SETUP_URL}`
      );
    }
    throw new Error(msg);
  }
}

export async function requestPaperPasswordReset(email) {
  const cleanEmail = String(email || "").trim();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new Error("Enter your invited email address first to receive a password reset link.");
  }
  if (!authState.staticMode) {
    throw new Error("Localhost FastAPI mode uses your local Advisor Workspace passphrase.");
  }
  const mod = await loadNetlifyIdentityBundle();
  if (!mod) {
    throw new Error(`Netlify Identity is unavailable. Check ${NETLIFY_IDENTITY_SETUP_URL}`);
  }
  const fn = mod.requestPasswordRecovery || mod.recoverPassword;
  if (typeof fn !== "function") {
    throw new Error("Password recovery is not supported by the current Identity bundle.");
  }
  await fn(cleanEmail);
}

export async function refreshPaperSession() {
  if (!authState.staticMode || !authState.identityMod) return null;
  if (typeof authState.identityMod.refreshSession === "function") {
    try {
      await authState.identityMod.refreshSession();
      const u = await authState.identityMod.getUser();
      authState.cloudUser = normalizeCloudUser(u);
      syncIdentityGuideVisibility();
      return authState.cloudUser;
    } catch (_err) {
      return authState.cloudUser;
    }
  }
  return authState.cloudUser;
}

export async function logoutPaperUser() {
  if (authState.staticMode && authState.identityMod && typeof authState.identityMod.logout === "function") {
    try {
      await authState.identityMod.logout();
    } catch (_err) {
      // Clear local memory state regardless of network result
    }
  } else if (!authState.staticMode) {
    const headers = { "Content-Type": "application/json" };
    const csrf = authState.getCsrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
    try {
      await window.fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({}),
      });
    } catch (_err) {
      // Proceed with clean reload
    }
  }

  authState.cloudUser = null;
  authState.pendingInviteToken = null;
  authState.pendingRecoveryToken = null;
  authState.pendingAuthSuccessCb = null;
  syncIdentityGuideVisibility();
  authState.onAuthChanged(null);
  window.location.href = "/";
}

export function openPaperAuthModal(mode = "login", onAuthenticatedCallback = null) {
  authState.modalMode = mode;
  authState.pendingAuthSuccessCb =
    typeof onAuthenticatedCallback === "function" ? onAuthenticatedCallback : null;

  const backdrop = document.getElementById("paper-auth-modal-backdrop");
  const modal = document.getElementById("paper-auth-modal");
  const titleEl = document.getElementById("paper-auth-modal-title");
  const descEl = document.getElementById("paper-auth-modal-desc");
  const emailGroup = document.getElementById("paper-auth-email-group");
  const emailInput = document.getElementById("paper-auth-modal-email");
  const passGroup = document.getElementById("paper-auth-pass-group");
  const passLabel = document.getElementById("paper-auth-pass-label");
  const passInput = document.getElementById("paper-auth-modal-password");
  const confirmGroup = document.getElementById("paper-auth-confirm-group");
  const confirmInput = document.getElementById("paper-auth-modal-confirm");
  const errBanner = document.getElementById("paper-auth-modal-error");
  const submitBtn = document.getElementById("paper-auth-modal-submit-btn");
  const oauthWrap = document.getElementById("paper-auth-modal-oauth-wrap");

  if (!modal || !backdrop) return;

  errBanner.classList.add("hidden");
  errBanner.textContent = "";
  passInput.value = "";
  confirmInput.value = "";

  if (mode === "invite") {
    titleEl.textContent = "Accept Invitation & Set Password";
    descEl.textContent =
      "Welcome to ArthaQuant! Choose a strong password (min 8 chars, 12+ recommended) to activate your invited account.";
    emailGroup.classList.add("hidden");
    emailInput.required = false;
    passGroup.classList.remove("hidden");
    passLabel.textContent = "Choose Account Password (min 8 chars, 12+ recommended)";
    passInput.autocomplete = "new-password";
    confirmGroup.classList.remove("hidden");
    confirmInput.required = true;
    submitBtn.textContent = "Activate Invited Account";
    oauthWrap.classList.add("hidden");
  } else if (mode === "recovery") {
    titleEl.textContent = "Set New Account Password";
    descEl.textContent =
      "Password recovery link verified. Enter a new strong password (min 8 chars, 12+ recommended) to secure your account.";
    emailGroup.classList.add("hidden");
    emailInput.required = false;
    passGroup.classList.remove("hidden");
    passLabel.textContent = "New Strong Password (min 8 chars)";
    passInput.autocomplete = "new-password";
    confirmGroup.classList.remove("hidden");
    confirmInput.required = true;
    submitBtn.textContent = "Save New Password";
    oauthWrap.classList.add("hidden");
  } else {
    titleEl.textContent = "Sign In to ArthaQuant Paper Portfolios";
    descEl.textContent =
      "Registration is Invite-Only. Sign in with your invited email to manage multi-strategy virtual wallets and Buy-on-Dip limit orders.";
    emailGroup.classList.remove("hidden");
    emailInput.required = true;
    passGroup.classList.remove("hidden");
    passLabel.textContent = "Password";
    passInput.autocomplete = "current-password";
    confirmGroup.classList.add("hidden");
    confirmInput.required = false;
    submitBtn.textContent = "Sign In & Continue";
    renderDynamicOAuthButtons("paper-auth-modal-oauth-wrap", "paper-auth-modal-oauth-btns");
  }

  syncIdentityGuideVisibility();
  backdrop.classList.remove("hidden");
  modal.classList.remove("hidden");
}

export function closePaperAuthModal() {
  const backdrop = document.getElementById("paper-auth-modal-backdrop");
  const modal = document.getElementById("paper-auth-modal");
  const passInput = document.getElementById("paper-auth-modal-password");
  const confirmInput = document.getElementById("paper-auth-modal-confirm");
  if (passInput) passInput.value = "";
  if (confirmInput) confirmInput.value = "";
  if (backdrop) backdrop.classList.add("hidden");
  if (modal) modal.classList.add("hidden");
}

async function handleAuthModalSubmit(ev) {
  ev.preventDefault();
  const errBanner = document.getElementById("paper-auth-modal-error");
  const submitBtn = document.getElementById("paper-auth-modal-submit-btn");
  const emailInput = document.getElementById("paper-auth-modal-email");
  const passInput = document.getElementById("paper-auth-modal-password");
  const confirmInput = document.getElementById("paper-auth-modal-confirm");

  errBanner.classList.add("hidden");
  const password = passInput.value;
  const pwErr = validateStrongPassword(password);
  if (pwErr) {
    errBanner.textContent = pwErr;
    errBanner.classList.remove("hidden");
    return;
  }

  if (authState.modalMode === "invite" || authState.modalMode === "recovery") {
    if (password !== confirmInput.value) {
      errBanner.textContent = "Passwords do not match. Please confirm your password.";
      errBanner.classList.remove("hidden");
      return;
    }
  }

  const prevLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Verifying...";

  try {
    if (authState.modalMode === "invite") {
      const mod = await loadNetlifyIdentityBundle();
      if (!mod || typeof mod.acceptInvite !== "function" || !authState.pendingInviteToken) {
        throw new Error("Invitation token expired or invalid. Ask an admin to send a fresh invite.");
      }
      const createdUser = await mod.acceptInvite(authState.pendingInviteToken, password);
      authState.pendingInviteToken = null;
      authState.cloudUser = normalizeCloudUser(createdUser) || (await getPaperUser());
      syncIdentityGuideVisibility();
      closePaperAuthModal();
      authState.showToast("Welcome to ArthaQuant! Your invited Paper Strategy account is now active.");
      authState.onAuthChanged(authState.cloudUser, { openPaperTab: true });
      if (authState.pendingAuthSuccessCb) {
        const cb = authState.pendingAuthSuccessCb;
        authState.pendingAuthSuccessCb = null;
        await cb(authState.cloudUser);
      }
    } else if (authState.modalMode === "recovery") {
      const mod = await loadNetlifyIdentityBundle();
      if (!mod) {
        throw new Error("Identity service unavailable.");
      }
      let updatedUser = null;
      if (typeof mod.updateUser === "function") {
        updatedUser = await mod.updateUser({ password });
      } else if (typeof mod.recoverPassword === "function" && authState.pendingRecoveryToken) {
        updatedUser = await mod.recoverPassword(authState.pendingRecoveryToken, password);
      } else {
        throw new Error("Unable to complete password update in this environment.");
      }
      authState.pendingRecoveryToken = null;
      authState.cloudUser = normalizeCloudUser(updatedUser) || (await getPaperUser());
      syncIdentityGuideVisibility();
      closePaperAuthModal();
      authState.showToast("Password updated! You are signed in to Paper Portfolios.");
      authState.onAuthChanged(authState.cloudUser, { openPaperTab: true });
    } else {
      const user = await loginPaperUser(emailInput.value, password);
      closePaperAuthModal();
      authState.showToast(`Signed in as ${user.maskedEmail}.`);
      if (authState.pendingAuthSuccessCb) {
        const cb = authState.pendingAuthSuccessCb;
        authState.pendingAuthSuccessCb = null;
        await cb(user);
      }
    }
  } catch (err) {
    errBanner.textContent = err.message || "Authentication failed.";
    errBanner.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = prevLabel;
  }
}

export async function initPaperAuthClient(options = {}) {
  authState.staticMode = Boolean(options.staticMode);
  if (typeof options.getLocalUsername === "function") {
    authState.getLocalUsername = options.getLocalUsername;
  }
  if (typeof options.getCsrfToken === "function") {
    authState.getCsrfToken = options.getCsrfToken;
  }
  if (typeof options.showToast === "function") {
    authState.showToast = options.showToast;
  }
  if (typeof options.onAuthChanged === "function") {
    authState.onAuthChanged = options.onAuthChanged;
  }

  if (!authState.initialized) {
    authState.initialized = true;
    const modalForm = document.getElementById("paper-auth-modal-form");
    const closeBtn = document.getElementById("paper-auth-modal-close-btn");
    const backdrop = document.getElementById("paper-auth-modal-backdrop");
    const topAuthBtn = document.getElementById("paper-auth-top-btn");

    if (modalForm) modalForm.addEventListener("submit", handleAuthModalSubmit);
    if (closeBtn) closeBtn.addEventListener("click", closePaperAuthModal);
    if (backdrop) backdrop.addEventListener("click", closePaperAuthModal);
    if (topAuthBtn) topAuthBtn.addEventListener("click", logoutPaperUser);
  }

  if (!authState.staticMode) {
    syncIdentityGuideVisibility();
    return await getPaperUser();
  }

  const mod = await loadNetlifyIdentityBundle();
  if (!mod) {
    syncIdentityGuideVisibility();
    return null;
  }

  // 1. Dynamically query Netlify Identity settings (never hardcode OAuth providers)
  await fetchAndApplyIdentitySettings(mod);

  // 2. Mandatory landing-page callback check for invite, recovery, confirmation, and OAuth tokens
  if (typeof mod.handleAuthCallback === "function") {
    try {
      const cbResult = await mod.handleAuthCallback();
      if (cbResult && cbResult.type === "invite" && cbResult.token) {
        // Invited user does NOT have an account yet — collect strong password & call acceptInvite()
        authState.pendingInviteToken = cbResult.token;
        syncIdentityGuideVisibility();
        openPaperAuthModal("invite");
        return null;
      }
      if (cbResult && cbResult.type === "recovery") {
        authState.pendingRecoveryToken = cbResult.token || null;
        if (cbResult.user) {
          authState.cloudUser = normalizeCloudUser(cbResult.user);
        }
        syncIdentityGuideVisibility();
        openPaperAuthModal("recovery");
        return authState.cloudUser;
      }
      if (cbResult && cbResult.type === "email_change" && cbResult.user) {
        authState.cloudUser = normalizeCloudUser(cbResult.user);
        authState.showToast(`Email verified and updated (${authState.cloudUser.maskedEmail}).`);
      } else if (cbResult && cbResult.user) {
        authState.cloudUser = normalizeCloudUser(cbResult.user);
        authState.showToast(`Signed in to ArthaQuant Paper Portfolios (${authState.cloudUser.maskedEmail}).`);
        authState.onAuthChanged(authState.cloudUser, { openPaperTab: true });
      }
    } catch (cbErr) {
      authState.showToast(
        (cbErr && cbErr.message) ||
          `Could not complete Identity callback. Check settings at ${NETLIFY_IDENTITY_SETUP_URL}`,
        true
      );
    }
  }

  // 3. Hydrate any existing signed-in user session from nf_jwt cookie
  if (!authState.cloudUser && typeof mod.getUser === "function") {
    try {
      const current = await mod.getUser();
      authState.cloudUser = normalizeCloudUser(current);
    } catch (_err) {
      authState.cloudUser = null;
    }
  }

  syncIdentityGuideVisibility();
  return authState.cloudUser;
}
