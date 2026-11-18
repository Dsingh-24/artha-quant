"use strict";

/**
 * ArthaQuant V5.0 Security-Hardened Static-Shell Service Worker.
 *
 * Strict Security Invariants:
 * 1. Immediately bypasses all non-GET requests and all cross-origin requests.
 * 2. Immediately bypasses /api/*, /.netlify/*, and /static/data/* so authenticated
 *    responses (/api/paper/*, /.netlify/identity/*) and large JSON snapshots are
 *    NEVER stored in CacheStorage.
 * 3. Uses Network-First with cache fallback strictly for allowlisted static UI shell assets.
 */

const CACHE_NAME = "arthaquant-shell-v5";

const PRECACHE_SHELL_URLS = [
  "/",
  "/index.html",
  "/static/index.html",
  "/static/styles.css",
  "/static/advanced_filters.js",
  "/static/app.js",
  "/static/charts.js",
  "/static/standalone_engine.js",
  "/static/auth_client.js",
  "/static/paper_ui.js",
  "/static/vendor/netlify_identity.js",
  "/static/manifest.webmanifest",
  "/static/icons/icon.svg",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/static/icons/apple-touch-icon.png",
];

function isBypassedPathname(pathname) {
  return (
    pathname === "/sw.js" ||
    pathname === "/static/sw.js" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/.netlify/") ||
    pathname.startsWith("/static/data/")
  );
}

function isAllowlistedShellAsset(pathname) {
  if (isBypassedPathname(pathname)) {
    return false;
  }
  if (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/static/index.html" ||
    pathname === "/static/manifest.webmanifest"
  ) {
    return true;
  }
  if (pathname.startsWith("/static/icons/")) {
    return true;
  }
  if (pathname.startsWith("/static/vendor/") && pathname.endsWith(".js")) {
    return true;
  }
  if (/^\/static\/[^/]+\.(?:css|js)$/.test(pathname)) {
    return true;
  }
  return false;
}

function isSafeCacheableResponse(response, pathname) {
  if (!response || !response.ok || response.status !== 200 || response.type !== "basic") {
    return false;
  }
  if (isBypassedPathname(pathname)) {
    return false;
  }
  const cacheControl = (response.headers.get("Cache-Control") || "").toLowerCase();
  if (cacheControl.includes("no-store") || cacheControl.includes("private")) {
    return false;
  }
  return true;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.allSettled(
        PRECACHE_SHELL_URLS.map(async (assetUrl) => {
          const req = new Request(assetUrl, { cache: "reload", credentials: "same-origin" });
          const res = await fetch(req);
          const parsed = new URL(req.url);
          if (isSafeCacheableResponse(res, parsed.pathname)) {
            await cache.put(assetUrl, res.clone());
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const existingKeys = await caches.keys();
      await Promise.all(
        existingKeys
          .filter((key) => key !== CACHE_NAME)
          .map((staleKey) => caches.delete(staleKey))
      );
      await self.clients.claim();
    })()
  );
});

async function networkFirstShell(request, pathname) {
  try {
    const networkResponse = await fetch(request);
    if (isSafeCacheableResponse(networkResponse, pathname)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (_networkErr) {
    const cachedExact = await caches.match(request);
    if (cachedExact) {
      return cachedExact;
    }
    if (
      request.mode === "navigate" ||
      pathname === "/" ||
      pathname === "/index.html" ||
      pathname === "/static/index.html"
    ) {
      const fallbackDoc =
        (await caches.match("/")) ||
        (await caches.match("/index.html")) ||
        (await caches.match("/static/index.html"));
      if (fallbackDoc) {
        return fallbackDoc;
      }
    }
    return new Response("Offline — ArthaQuant shell will reconnect automatically when network returns.", {
      status: 503,
      statusText: "Service Unavailable",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(request.url);
  } catch (_urlErr) {
    return;
  }

  if (parsedUrl.origin !== self.location.origin) {
    return;
  }

  const pathname = parsedUrl.pathname;
  if (isBypassedPathname(pathname)) {
    return;
  }

  if (!isAllowlistedShellAsset(pathname)) {
    return;
  }

  event.respondWith(networkFirstShell(request, pathname));
});
