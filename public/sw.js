/**
 * CashiBot — service worker (PWA).
 *
 * Strategia: network-first. Aplikacja i tak wymaga sieci (WebRTC do ElevenLabs),
 * więc cache służy tylko do szybkiego otwarcia „skorupy” aplikacji i komunikatu
 * offline — nigdy nie podaje starej wersji, gdy sieć działa.
 * /api/* (tokeny sesji) nigdy nie trafia do cache.
 */

const CACHE = "cashibot-v1";
const SHELL = ["/", "/styles.css", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return; // przeglądarka obsługuje normalnie
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") return caches.match("/");
        return Response.error();
      })
  );
});
