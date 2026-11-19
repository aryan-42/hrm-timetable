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

/* ---- Web Push: schedule changes ---- */

self.addEventListener("push", e => {
  let d = { title: "Timetable change", body: "Your schedule has been updated.", url: "/" };
  try { if (e.data) d = { ...d, ...e.data.json() }; } catch (_) {
    try { d.body = e.data.text(); } catch (_) {}
  }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    // same tag => a second change replaces the first rather than stacking
    tag: "tt-change",
    renotify: true,
    data: { url: d.url || "/" }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
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
