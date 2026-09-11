/* sw.js — Boulder, offline shell.
   Data lives in localStorage and is never touched here. API calls are
   deliberately not cached: a stale estimate is worse than an honest failure.

   Two rules learned the hard way:
   - install must not fail because one file is missing, or the old worker keeps
     serving forever and the app appears frozen on an ancient version
   - the app's own files are always fetched network-first, so a fresh commit
     lands on the next launch without any cache juggling */
var VER = "3.5.0";
var CACHE = "boulder-v" + VER;
var SHELL = [
  "./", "./index.html",
  "./css/app.css?v=" + VER,
  "./js/icons.js?v=" + VER, "./js/store.js?v=" + VER, "./js/api.js?v=" + VER, "./js/gym.js?v=" + VER,
  "./js/comp.js?v=" + VER, "./js/extras.js?v=" + VER, "./js/photos.js?v=" + VER, "./js/entry.js?v=" + VER, "./js/app.js?v=" + VER, "./js/views2.js?v=" + VER,
  "./js/shell.js?v=" + VER, "./js/main.js?v=" + VER,
  "./manifest.webmanifest?v=" + VER,
  "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // one at a time, tolerating failures, so a 404 cannot abort the install
      return Promise.all(SHELL.map(function (url) {
        return fetch(url, { cache: "reload" })
          .then(function (res) { if (res.ok) return c.put(url, res); })
          .catch(function () { /* missing file, carry on */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) {
        if (n !== CACHE) return caches.delete(n);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // never touch the API

  // the document decides which asset versions load, so it is always fresh
  var isDoc = e.request.mode === "navigate" || url.pathname.endsWith("/") ||
              url.pathname.endsWith("index.html");
  e.respondWith(
    fetch(isDoc ? new Request(e.request.url, { cache: "reload" }) : e.request).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || caches.match("./index.html");
      });
    })
  );
});

/* lets the page force a full refresh if it ever gets stuck again */
self.addEventListener("message", function (e) {
  if (e.data === "reset") {
    caches.keys().then(function (n) { return Promise.all(n.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.registration.unregister(); });
  }
});
