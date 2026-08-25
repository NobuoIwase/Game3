// Service Worker（DESIGN.md §7: オフライン動作）
// 方針: stale-while-revalidate。キャッシュがあれば即返し、裏で更新する。
// game_data の更新を確実に反映したいときは「データ」タブの「キャッシュを更新」を使う。

const CACHE = 'dbl-frag-opt-v4';

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/calc.js',
  './js/effects.js',
  './js/optimizer.js',
  './js/store.js',
  './js/parser.js',
  './game_data/characters.json',
  './game_data/fragments.json',
  './game_data/effect_map.json',
  './game_data/tags.json',
  './game_data/config.json',
  './game_data/meta.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || network.then((res) => res || new Response('オフラインのため読み込めません', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }));
    })
  );
});
