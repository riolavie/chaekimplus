// 앱 파일을 수정하면 버전을 올려주세요. (예: v2) 그래야 학생 기기에도 새 버전이 적용됩니다.
const CACHE = 'chaekim-plus-v7';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/config.js',
  'js/db.js',
  'js/api.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/favicon.png',
  'icons/mark.png',
  'icons/logo.png',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 같은 사이트의 파일만 캐시에서 먼저 응답하고, 백그라운드에서 최신 파일로 갱신
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const cached = await cache.match(key, { ignoreSearch: true });
      const network = fetch(req)
        .then(res => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
