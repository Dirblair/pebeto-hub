// sw.js - Updated
const CACHE_NAME = 'pebeto-v2';
const urlsToCache = [
  '/',
  '/index.html',
  '/signup.html',
  '/login.html',
  '/community.html',
  '/creator-dashboard.html',
  '/business-dashboard.html',
  '/admin-dashboard.html',
  '/creator-profile.html',
  '/bids.html'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
      .catch(err => console.error('Cache add failed:', err))
  );
  self.skipWaiting();
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Return cached response if found, otherwise fetch from network
        if (response) {
          return response;
        }
        return fetch(event.request).catch(() => {
          // Return offline page if needed
          return new Response('Offline - Please check your connection');
        });
      })
  );
});

self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});
