// Service worker — kitchen-crm PWA
// Strategy: stale-while-revalidate for the app shell (HTML/CSS/JS/icons),
// network-only for Supabase API calls (so realtime data is always fresh).

const VERSION = 'kcrm-v1-2026-05-08';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Skip non-GET requests entirely (PUT/POST/DELETE go straight to network)
  if (e.request.method !== 'GET') return;

  // Bypass cache for Supabase API calls and any cross-origin request — let realtime data through.
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate for same-origin GETs (the app shell + icons).
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(e.request);
      const fetchPromise = fetch(e.request).then(net => {
        if (net && net.ok) cache.put(e.request, net.clone());
        return net;
      }).catch(() => cached); // offline fallback
      return cached || fetchPromise;
    })
  );
});
