// Minimal offline cache for the app shell (routing itself needs the network)
const CACHE = 'peage-malin-v24';
const FILES = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/geo.js', 'js/tolls.js', 'js/optimizer.js',
  'js/services.js', 'js/charging.js', 'js/enroute.js', 'js/temp.js', 'data/tolls.json', 'data/chargers.json', 'icon.svg', 'manifest.webmanifest'];
// a new version takes over at once (no mix of old and new files)
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE)
  .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) =>
  Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;     // APIs: always network
  // network first, bypassing the browser's 10-min HTTP cache (GitHub Pages) so page, style and code always match
  e.respondWith(fetch(u.href, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) return caches.match(e.request).then((c) => c || r);
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
