import type { Config } from "@netlify/functions";
import { AuthError, verifyRequestOrigin } from "@netlify/identity";
import { getOrRefreshUniversePricesBlob } from "../lib/market-prices-service.mts";
import { PaperServiceError } from "../lib/paper-pg-service.mts";

const NO_STORE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

const GET_CACHE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "public, max-age=120, stale-while-revalidate=600",
  "Netlify-CDN-Cache-Control": "public, s-maxage=900, stale-while-revalidate=86400",
};

export default async (req: Request): Promise<Response> => {
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json(
      { detail: "Method not allowed.", error: "Method not allowed." },
      { status: 405, headers: NO_STORE_HEADERS },
    );
  }

  if (req.method === "POST") {
    try {
      verifyRequestOrigin(req);
    } catch (err) {
      const status = err instanceof AuthError && err.status ? err.status : 403;
      return Response.json(
        {
          detail: "Cross-origin or missing-Origin POST request rejected.",
          error: "Forbidden origin.",
        },
        { status, headers: NO_STORE_HEADERS },
      );
    }

    try {
      const payload = await getOrRefreshUniversePricesBlob({
        reqUrl: req.url,
        forceRefresh: true,
      });
      return Response.json(payload, { status: 200, headers: NO_STORE_HEADERS });
    } catch (err) {
      const status = err instanceof PaperServiceError ? err.status : 500;
      return Response.json(
        {
          detail: "Unable to refresh live market prices.",
          error: "Market prices refresh failed.",
        },
        { status, headers: NO_STORE_HEADERS },
      );
    }
  }

  try {
    const payload = await getOrRefreshUniversePricesBlob({
      reqUrl: req.url,
      forceRefresh: false,
    });
    return Response.json(payload, { status: 200, headers: GET_CACHE_HEADERS });
  } catch (err) {
    const status = err instanceof PaperServiceError ? err.status : 500;
    return Response.json(
      {
        detail: "Unable to load live market prices.",
        error: "Market prices unavailable.",
      },
      { status, headers: NO_STORE_HEADERS },
    );
  }
};

export const config: Config = {
  path: "/api/market-prices",
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
  },
};
