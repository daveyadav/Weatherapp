/* Bato Update service worker — v1.
 * Cache the app shell + seed data on install. Offline: serve from cache and the
 * app shows its "offline — showing last-known data" banner. Bump CACHE when the
 * shell changes (keep in sync with APP_VERSION in js/app.js).
 */
const CACHE = "bato-update-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/app.css",
  "./js/app.js",
  "./js/navigate.js",
  "./data/routes.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      // Navigation requests: network first, fall back to cached shell.
      if (e.request.mode === "navigate") {
        return fetch(e.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("./index.html", copy));
            return res;
          })
          .catch(() => hit || caches.match("./index.html"));
      }
      // routes.json: network first (freshness matters), cache on success.
      if (url.pathname.endsWith("routes.json")) {
        return fetch(e.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          })
          .catch(() => hit);
      }
      // Everything else: cache first.
      return hit || fetch(e.request);
    })
  );
});
