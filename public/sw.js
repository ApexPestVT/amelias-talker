// Keeps the talker working with no internet (taps and voice). Listening still needs a connection.
const CACHE = 'talker-v19';
const MODELS = 'talker-models-1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== MODELS).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).pathname.startsWith('/api/')) return;
  if (new URL(e.request.url).pathname.startsWith('/vendor/')) {   // the listening model: keep it for good, never re-download
    e.respondWith(caches.open(MODELS).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()).catch(() => {}); return r; }))));
    return;
  }
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); return r; }).catch(() => caches.match(e.request).then(m => m || caches.match('/index.html'))));
});
