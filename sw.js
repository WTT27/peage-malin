// Minimal offline cache for the app shell (routing itself needs the network)
const CACHE = 'peage-malin-v2';
const FILES = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/geo.js', 'js/tolls.js', 'js/optimizer.js',
  'js/services.js', 'data/tolls.json', 'icon.svg', 'manifest.webmanifest'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) =>
  Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;            // APIs: always network
  e.respondWith(fetch(e.request).then((r) => {          // network first, cache as fallback
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
