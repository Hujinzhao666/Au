const CACHE = "aurora-shell-v7-vault-workflow";
const APP_ROOT = new URL("./", self.location.href).href;
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll([
          APP_ROOT,
          new URL("index.html", APP_ROOT).href,
          new URL("manifest.webmanifest", APP_ROOT).href,
          new URL("native-adapter.js", APP_ROOT).href,
          new URL("native-bootstrap.js", APP_ROOT).href,
          new URL("mobile-compact.css", APP_ROOT).href,
          new URL("favicon.svg", APP_ROOT).href,
          new URL("icon-192.png", APP_ROOT).href,
          new URL("icon-512.png", APP_ROOT).href,
          new URL("assets/index-B_yWcLSP.css", APP_ROOT).href,
          new URL("assets/index-CyRXoI_r.js", APP_ROOT).href,
        ])
      )
      .then(() => self.skipWaiting())
  )
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
);
self.addEventListener("fetch", (event) => {
  if (
    event.request.method !== "GET" ||
    new URL(event.request.url).origin !== location.origin
  )
    return;
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request)
          .then((response) => {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            return response;
          })
          .catch(() =>
            event.request.mode === "navigate"
              ? caches.match(APP_ROOT)
              : Response.error()
          )
    )
  );
});
