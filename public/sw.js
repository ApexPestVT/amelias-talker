// Keeps the device working with no internet (taps and voice). Listening still needs a connection.
const CACHE = 'talker-v91';
// Paths are relative to wherever this file is served from, so it works at the bare address and under /app/.
const SHELL = ['./', 'index.html', 'band-codec.js', 'manifest.webmanifest', 'icon-192.png', 'icon-180.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).pathname.includes('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); return r; }).catch(() => caches.match(e.request).then(m => m || caches.match('index.html'))));
});
