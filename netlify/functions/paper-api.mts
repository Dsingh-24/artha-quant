import type { Config, Context } from "@netlify/functions";
import { AuthError, getUser, verifyRequestOrigin } from "@netlify/identity";
import {
  cancelPaperOrder,
  createPaperPortfolio,
  deployPaperBasket,
  depositPaperCash,
  getPaperOverview,
  PaperServiceError,
  placePaperOrder,
  refreshUserPaperQuotesAndOrders,
  type VerifiedPaperUser,
} from "../lib/paper-pg-service.mts";

const IDENTITY_SETUP_URL = "https://app.netlify.com/projects/arthaquant-india/identity";
const MAX_JSON_BYTES = 65_536;

// Response headers are set in code on the returned Response (`[[headers]]` in netlify.toml applies only to static CDN responses).
const RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: RESPONSE_HEADERS });
}

function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : "Unexpected server error.";
  return raw.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-db-url]");
}

async function resolveAuthenticatedUser(context: Context): Promise<VerifiedPaperUser | null> {
  // Primary: app-level invite-only Netlify Identity user (`nf_jwt` session)
  const identityUser = await getUser();
  if (identityUser && typeof identityUser.id === "string" && identityUser.id.trim()) {
    return {
      id: identityUser.id.trim(),
      email: typeof identityUser.email === "string" && identityUser.email.trim()
        ? identityUser.email.trim()
        : undefined,
    };
  }

  // Fallback: private or team-login-protected Netlify project user (`context.user` may be undefined on public sites / netlify dev)
  if (context?.user && typeof context.user.id === "string" && context.user.id.trim()) {
    return {
      id: `netlify-team:${context.user.id.trim()}`,
      email: typeof context.user.email === "string" && context.user.email.trim()
        ? context.user.email.trim()
        : undefined,
    };
  }

  return null;
}

async function parseJsonObjectBody(req: Request, allowEmpty = false): Promise<Record<string, unknown>> {
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    throw new PaperServiceError("Unable to read request body.", 400);
  }

  if (raw.length > MAX_JSON_BYTES) {
    throw new PaperServiceError("Request payload exceeds maximum allowed size.", 413);
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    if (allowEmpty) return {};
    throw new PaperServiceError("Request body must be a non-empty JSON object.", 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new PaperServiceError("Request body must be valid JSON.", 400);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PaperServiceError("Request body must be a JSON object.", 400);
  }

  return parsed as Record<string, unknown>;
}

const DEPOSIT_PATH_RE = /^\/api\/paper\/portfolios\/([A-Za-z0-9_-]{1,64})\/deposit\/?$/;
const CANCEL_ORDER_PATH_RE = /^\/api\/paper\/orders\/([A-Za-z0-9_-]{1,64})\/cancel\/?$/;

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ detail: "Method not allowed.", error: "Method not allowed." }, 405);
  }

  // Enforce strict same-origin CSRF verification on all state-changing POST requests
  if (req.method === "POST") {
    try {
      verifyRequestOrigin(req);
    } catch (err) {
      const status = err instanceof AuthError && err.status ? err.status : 403;
      return jsonResponse(
        {
          detail: "Cross-origin or missing-Origin POST request rejected.",
          error: "Forbidden origin.",
        },
        status,
      );
    }
  }

  const user = await resolveAuthenticatedUser(context);
  if (!user) {
    return jsonResponse(
      {
        authenticated: false,
        identity_setup_url: IDENTITY_SETUP_URL,
        detail: "Sign in via invite-only Netlify Identity to access your Paper Strategy Wallets.",
      },
      401,
    );
  }

  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (req.method === "GET" && (pathname === "/api/paper/overview" || pathname === "/api/paper")) {
      const portfolioId = url.searchParams.get("portfolio_id");
      const overview = await getPaperOverview(user, portfolioId, req.url);
      return jsonResponse(overview, 200);
    }

    if (req.method === "POST" && pathname === "/api/paper/portfolios") {
      const body = await parseJsonObjectBody(req, false);
      const created = await createPaperPortfolio(user, body, req.url);
      return jsonResponse(created, 200);
    }

    const depositMatch = DEPOSIT_PATH_RE.exec(url.pathname);
    if (req.method === "POST" && depositMatch) {
      const body = await parseJsonObjectBody(req, false);
      const updated = await depositPaperCash(user, depositMatch[1], body, req.url);
      return jsonResponse(updated, 200);
    }

    if (req.method === "POST" && pathname === "/api/paper/orders") {
      const body = await parseJsonObjectBody(req, false);
      const placed = await placePaperOrder(user, body, req.url);
      return jsonResponse(placed, 200);
    }

    const cancelMatch = CANCEL_ORDER_PATH_RE.exec(url.pathname);
    if (req.method === "POST" && cancelMatch) {
      await parseJsonObjectBody(req, true);
      const cancelled = await cancelPaperOrder(user, cancelMatch[1], req.url);
      return jsonResponse(cancelled, 200);
    }

    if (req.method === "POST" && pathname === "/api/paper/deploy-basket") {
      const body = await parseJsonObjectBody(req, false);
      const deployed = await deployPaperBasket(user, body, req.url);
      return jsonResponse(deployed, 200);
    }

    if (req.method === "POST" && pathname === "/api/paper/refresh") {
      const body = await parseJsonObjectBody(req, true);
      const portfolioId = typeof body.portfolio_id === "string" ? body.portfolio_id : null;
      const refreshed = await refreshUserPaperQuotesAndOrders(user, portfolioId, req.url);
      return jsonResponse(refreshed, 200);
    }

    return jsonResponse({ detail: "Paper API endpoint not found.", error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof PaperServiceError) {
      const safeMsg = sanitizeErrorMessage(err);
      return jsonResponse({ detail: safeMsg, error: safeMsg }, err.status);
    }

    const safeMsg = sanitizeErrorMessage(err);
    const isUnprovisionedDb =
      safeMsg.toLowerCase().includes("database") ||
      safeMsg.toLowerCase().includes("environment not configured") ||
      safeMsg.toLowerCase().includes("connect");
    if (isUnprovisionedDb) {
      return jsonResponse(
        {
          detail:
            "Netlify Managed Postgres is not provisioned or reachable yet on this deploy. Deploy with @netlify/database installed so migrations auto-provision the database.",
          error: "Database unavailable.",
        },
        503,
      );
    }

    console.error("Unhandled Paper API error:", safeMsg);
    return jsonResponse(
      {
        detail: "Paper trading service encountered an unexpected server error.",
        error: "Internal server error.",
      },
      500,
    );
  }
};

export const config: Config = {
  path: ["/api/paper", "/api/paper/*"],
  method: ["GET", "POST"],
  rateLimit: {
    action: "rate_limit",
    aggregateBy: ["ip", "domain"],
    windowSize: 60,
    windowLimit: 45,
  },
};
