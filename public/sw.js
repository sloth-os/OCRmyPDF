/* Service worker for OCRmyPDF web.
 *
 * At deploy time, scripts/gen-sw-manifest.py rewrites __PRECACHE_URLS and
 * __BUILD_VERSION in this file with the exact asset list (app shell + the
 * whole wasm runtime). With an empty list (dev mode) it precaches nothing
 * and simply runtime-caches same-origin GET responses as they arrive.
 *
 * Strategies:
 *  - Precached files: cache-first (the whole point: full offline after the
 *    first visit).
 *  - Other same-origin GETs (extra tessdata models, etc.):
 *    stale-while-revalidate, so browsing a language once makes it offline.
 *
 * URLs in the precache list are site-root-relative (e.g. "pyodide/pyodide.js")
 * so the app works under the /OCRmyPDF/ Pages subpath as well as at a domain
 * root. Matching uses the URL resolved against the SW scope.
 */

const VERSION = "__BUILD_VERSION__";
const PRECACHE_URLS = __PRECACHE_URLS__;
const PRECACHE = `ocrmypdf-precache-${VERSION}`;
const RUNTIME = `ocrmypdf-runtime-${VERSION}`;

const precacheSet = new Set(
  PRECACHE_URLS.map((rel) => new URL(rel, self.registration.scope).href)
);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      const results = await Promise.allSettled(
        PRECACHE_URLS.map(async (rel) => {
          const url = new URL(rel, self.registration.scope).href;
          const resp = await fetch(url, { cache: "reload" });
          if (!resp.ok) throw new Error(`${rel} -> ${resp.status}`);
          await cache.put(url, resp);
        })
      );
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length) {
        console.warn(
          `[sw] precached ${PRECACHE_URLS.length - failed.length}/${PRECACHE_URLS.length}`,
          failed.slice(0, 3).map((f) => f.reason?.message)
        );
      } else {
        console.info(`[sw] precached ${PRECACHE_URLS.length} files`);
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("ocrmypdf-") && ![PRECACHE, RUNTIME].includes(k))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request, { ignoreVary: true });
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === "basic") {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (precacheSet.has(url.href)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PRECACHE);
        const hit = await cache.match(url.href, { ignoreVary: true });
        if (hit) return hit;
        const resp = await fetch(event.request);
        if (resp.ok) cache.put(url.href, resp.clone());
        return resp;
      })()
    );
    return;
  }

  // Everything else under our scope: runtime cache (covers extra tessdata).
  if (url.href.startsWith(self.registration.scope)) {
    event.respondWith(staleWhileRevalidate(event.request));
  }
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
