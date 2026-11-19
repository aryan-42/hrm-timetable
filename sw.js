/* Offline shell for the timetable.
   Strategy: network-first for the app itself (so a new deploy is picked up
   immediately), cache-first for fonts. Schedule data is NOT cached here —
   the app keeps its own copy in localStorage and shows it when offline. */
const CACHE = "hrm-timetable-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // never cache API traffic — always go to the network
  if (url.hostname.endsWith("supabase.co") || url.hostname.endsWith("google.com")) return;

  // fonts: cache-first
  if (url.hostname.includes("gstatic") || url.hostname.includes("googleapis")) {
    e.respondWith(
      caches.match(e.request).then(hit => hit ||
        fetch(e.request).then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        }).catch(() => hit)
      )
    );
    return;
  }

  // app shell: network-first, fall back to cache when offline
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match("./index.html")))
  );
});
