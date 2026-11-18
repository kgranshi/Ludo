const CACHE_NAME = 'nepali-ludo-pwa-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/admin.html',
  '/manifest.json',
  '/admin-manifest.json',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/apple-touch-icon.png',
  '/assets/nepali_ludo_crest.jpg',
  '/assets/avatar_himal_hero.jpg',
  '/assets/avatar_durbar_royal.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/room/') || url.pathname === '/health') return;

  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => null);
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => null);
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

self.addEventListener('push', (event) => {
  let payload = {
    title: 'नेपाली लुडो — Admin Alert',
    body: 'नयाँ पेन्डिङ Gold अर्डर जाँच गर्न बाँकी छ।',
    url: '/admin.html#proofs',
    tag: 'ludo-pending-order'
  };
  try {
    if (event.data) {
      const parsed = event.data.json();
      payload = { ...payload, ...parsed };
    }
  } catch {
    try {
      const txt = event.data ? event.data.text() : '';
      if (txt) payload.body = txt;
    } catch {}
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      tag: payload.tag || 'ludo-pending-order',
      renotify: true,
      requireInteraction: true,
      vibrate: [250, 120, 250, 120, 300],
      data: { url: payload.url || '/admin.html#proofs' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/admin.html#proofs';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/admin.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
