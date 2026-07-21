// Minimal service worker: makes the page installable as a PWA and keeps the
// app shell available offline. /api/status is never cached — live data only.
const CACHE = "wc-status-v4";
const SHELL = [
  "./",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// One-shot "WC is free" push from the wc-status-push service. Works with the
// app fully closed. Every push must show a notification (browser rule).
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data.json(); } catch { /* payload optional */ }
  e.waitUntil((async () => {
    try {
      if ("setAppBadge" in self.navigator) {
        if (data.badge) await self.navigator.setAppBadge(data.badge);
        else await self.navigator.clearAppBadge();
      }
    } catch { /* badging not available here */ }
    await self.registration.showNotification(data.title || "WC Status", {
      body: data.body || "",
      icon: "icons/icon-192.png",
      tag: "wc-free",
      // Without renotify, a same-tag notification lingering in the Action
      // Center gets replaced silently — no banner, no sound.
      renotify: true,
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("./");
    })
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (
    e.request.method !== "GET" ||
    !url.protocol.startsWith("http") ||   // ignore chrome-extension:// etc.
    url.pathname.includes("/api/")        // live data only
  ) return;

  // Network-first so page updates land immediately; cache is the offline net.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
