/* T&T Mobile app-shell cache v6: atomic versioned release bundle; only public static assets, never API keys or customer data. */
const TT_BUILD_ID = '20261128-pwa-2000';
const TT_SHELL_CACHE = 'tt-mobile-shell-' + TT_BUILD_ID;
const TT_SHELL_ASSETS = [
  './index.html',
  './tt-candidate-data.js?v=' + TT_BUILD_ID,
  './tt-candidate-data.js',
  './manifest.json',
  './logo-192.png',
  './logo-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const fetched = [];
    for (const rel of TT_SHELL_ASSETS) {
      const targetUrl = new URL(rel, scope).toString();
      const req = new Request(targetUrl, { cache: 'reload' });
      const res = await fetch(req);
      if (!res || !res.ok || res.type === 'opaque') {
        throw new Error('SW_INSTALL_ASSET_FAILED:' + rel);
      }
      // Fully buffer body before next fetch so HTTP/1.1 connections never exhaust per-origin sockets.
      const buf = await res.arrayBuffer();
      if (rel === './index.html' || rel.startsWith('./tt-candidate-data.js')) {
        const txt = new TextDecoder('utf-8').decode(buf);
        if (!txt.includes(TT_BUILD_ID)) {
          throw new Error('SW_INSTALL_BUILD_MISMATCH:' + rel);
        }
      }
      fetched.push([
        targetUrl,
        new Response(buf, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) })
      ]);
    }
    const cache = await caches.open(TT_SHELL_CACHE);
    for (const [keyUrl, res] of fetched) {
      await cache.put(keyUrl, res);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('tt-mobile-shell-') && k !== TT_SHELL_CACHE)
          .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const scopePath = new URL(self.registration.scope).pathname;
  const isHome = url.pathname === scopePath || url.pathname === scopePath + 'index.html';
  const staticPaths = new Set([
    scopePath + 'tt-candidate-data.js',
    scopePath + 'manifest.json',
    scopePath + 'logo-192.png',
    scopePath + 'logo-512.png'
  ]);
  if (!isHome && !staticPaths.has(url.pathname)) return; // Never cache API, session, ACK, or dynamic requests.

  if (isHome) {
    const canonicalHome = new URL('./index.html', self.registration.scope).toString();
    event.respondWith((async () => {
      try {
        const response = await fetch(req);
        if (response && response.ok && response.type !== 'opaque') {
          const text = await response.clone().text();
          if (text.includes(TT_BUILD_ID)) {
            const cache = await caches.open(TT_SHELL_CACHE);
            await cache.put(canonicalHome, response.clone()).catch(() => {});
          }
        }
        return response;
      } catch (_) {
        const cache = await caches.open(TT_SHELL_CACHE);
        return (await cache.match(canonicalHome)) ||
          new Response('Ứng dụng chưa được lưu để dùng offline.', { status: 503 });
      }
    })());
    return;
  }

  const reqVer = url.searchParams.get('v');
  if (reqVer && reqVer !== TT_BUILD_ID) {
    // Versioned request belongs to another build release: bypass old cache completely.
    return;
  }

  const exactUrl = new URL(
    url.pathname.slice(scopePath.length) + (reqVer ? '?v=' + reqVer : ''),
    self.registration.scope
  ).toString();

  event.respondWith(caches.open(TT_SHELL_CACHE).then(async cache => {
    const hit = await cache.match(exactUrl);
    if (hit) return hit;
    const response = await fetch(req);
    if (response && response.ok && response.type !== 'opaque') {
      await cache.put(exactUrl, response.clone());
    }
    return response;
  }));
});
