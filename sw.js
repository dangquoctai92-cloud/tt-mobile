self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Pass-through fetch to satisfy PWA requirements
  e.respondWith(fetch(e.request).catch(() => {
    return new Response('Offline content not available');
  }));
});
