// 앱 파일을 수정하면 버전을 올려주세요. (예: v2) 그래야 학생 기기에도 새 버전이 적용됩니다.
const CACHE = 'chaekim-plus-v10';
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
  // 브라우저의 임시 저장(HTTP 캐시)을 거치지 않고 서버에서 새로 받아 저장
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 화면·코드 파일: 온라인이면 항상 최신 파일(4초 안에 응답 없으면 저장본), 오프라인이면 저장본
// 아이콘 등: 저장본을 먼저 쓰고 뒤에서 갱신
const isAppFile = (req, url) => req.mode === 'navigate' || /\.(html|js|css|webmanifest|gs)$/.test(url.pathname) || url.pathname.endsWith('/');

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? 'index.html' : url.pathname.slice(self.registration.scope.length - url.origin.length) || 'index.html';

  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(key, { ignoreSearch: true });
    const fromNetwork = fetch(url.href.split('?')[0], { cache: 'no-cache' }).then(res => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    });
    if (!isAppFile(req, url)) {
      fromNetwork.catch(() => {});
      return cached || fromNetwork;
    }
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000));
    try {
      return await Promise.race([fromNetwork, timeout]);
    } catch (err) {
      return cached || fromNetwork;
    }
  }));
});
