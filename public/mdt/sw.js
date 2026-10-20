// Service worker tabletu MDT (zakres /mdt/). Dane (API) zawsze z sieci; cache tylko na powłokę aplikacji.
const CACHE = 'avaloria-mdt-v1';
const SHELL = ['/mdt/', '/mdt/mdt.css', '/mdt/mdt.js', '/mdt/manifest.json', '/mdt/mdt-192.png', '/mdt/mdt-512.png'];
const STATIC = new Set(SHELL.concat(['/mdt/index.html', '/mdt/mdt-maskable-512.png']));

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const p = new URL(req.url).pathname;
  if (!STATIC.has(p)) return;                       // /mdt/me, /mdt/dispatch/... itd. – zawsze sieć
  // sieć najpierw (po aktualizacji serwera od razu nowa wersja), cache jako zapas offline
  e.respondWith(fetch(req).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {}); } return r; }).catch(() => caches.match(req)));
});
