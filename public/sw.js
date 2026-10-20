const CACHE_NAME = 'avaloria-phone-v5';
const CORE_ASSETS = ['/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // tablet MDT to osobna aplikacja – telefon nie może jej przechwytywać ani cache'ować
  if (new URL(req.url).pathname.startsWith('/mdt')) return;
  // API i sygnalizacja zawsze z sieci - to są żywe dane
  if (req.url.includes('/customer/') || req.url.includes('/internal/') || req.url.includes('/call-signal')) return;

  // Strona (HTML) najpierw z sieci, żeby po aktualizacji serwera telefon od razu pokazywał nową wersję;
  // cache tylko jako zapas, gdy nie ma internetu.
  if (req.mode === 'navigate' || req.url.endsWith('/') || req.url.endsWith('/index.html')) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put('/', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('/'))
    );
    return;
  }

  // ikony i manifest: cache najpierw
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
