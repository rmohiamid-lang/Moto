// Service worker : l'application démarre instantanément depuis le cache, même
// hors ligne, et les mises à jour sont téléchargées en arrière-plan (elles
// s'appliquent à l'ouverture suivante).
const CACHE = 'moto-v3';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/apkg.js',
  'js/browse.js',
  'js/collection.js',
  'js/db.js',
  'js/editor.js',
  'js/reminders.js',
  'js/scheduler.js',
  'js/state.js',
  'js/stats.js',
  'js/study.js',
  'js/template.js',
  'js/tts.js',
  'js/ui.js',
  'vendor/jszip.min.js',
  'vendor/fzstd.js',
  'vendor/sql-wasm.js',
  'vendor/sql-wasm.wasm',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache d'abord, puis mise à jour du cache en arrière-plan.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => cached);
    if (cached) {
      e.waitUntil(network);
      return cached;
    }
    return network;
  })());
});
