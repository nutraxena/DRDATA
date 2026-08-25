/* Dr-Diary service worker — precache the app shell so the diary opens with no
   network. Doctor data never touches the cache; it lives in localStorage. */

var VERSION = 'dr-diary-v1';
var SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/parse.js',
  './js/translit.js',
  './js/photos.js',
  './js/ocr.js',
  './js/store.js',
  './js/import.js',
  './js/views.js',
  './js/app.js',
  './vendor/xlsx.full.min.js',
  './logo.svg',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) {
      // addAll fails the whole install if any single file 404s; add individually
      // so a missing optional icon cannot break offline support.
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function (e) {
          console.warn('[sw] skipped', url, e.message);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tel:, wa.me, maps — leave alone

  // Navigations: network first so a redeploy is picked up, cache as fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (r) {
          return r || caches.match('./');
        });
      })
    );
    return;
  }

  // Assets: stale-while-revalidate. The cached copy answers instantly (and is
  // what makes the app work offline), while a background fetch refreshes it so
  // the next load picks up a redeploy. Plain cache-first would pin users to an
  // old build until the cache name changed.
  event.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || network;
    })
  );
});
