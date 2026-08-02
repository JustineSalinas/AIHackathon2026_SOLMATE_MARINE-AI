// Offline support for the navigation console.
//
// The previous version was cache-first for every request, including navigations,
// against a cache name that never changed. That combination means a browser that
// has loaded the console once serves that copy forever: shipping a new build
// changes nothing for anyone who already visited, and there is no way to force
// an update short of clearing site data by hand. It cost a full debugging cycle
// to notice during a UI pass -- the page under test was three edits behind the
// file on disk -- and on demo day it is the failure where the screen shows
// yesterday's build and nobody can explain why.
//
// The split below is the standard one:
//
//   Navigations and HTML -> network first, cache as fallback. The page you get
//   is the page that was deployed, and if the network is gone you still get the
//   last one that worked. This is what makes the offline claim true without
//   making it permanent.
//
//   Static assets -> cache first. Vite content-hashes them, so a changed asset
//   is a changed URL and a stale entry can never shadow a new one.
//
// Bump CACHE_VERSION whenever the precache list changes.

const CACHE_VERSION = 'v2';
const CACHE_NAME = `marine-ai-console-${CACHE_VERSION}`;

const PRECACHE = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Individually, so one 404 does not fail the whole install.
      Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache the API. A cached throttle recommendation is a stale
  // recommendation presented as a live one, which is the one thing the product
  // spec refuses outright.
  if (url.pathname.startsWith('/api/')) return;

  // Cross-origin (tiles, map libraries, fonts) is left to the browser's own HTTP
  // cache; intercepting opaque responses here buys nothing and hides failures.
  if (url.origin !== self.location.origin) return;

  const isNavigation =
    request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put('/index.html', fresh.clone());
          return fresh;
        } catch {
          const cached = (await caches.match(request)) || (await caches.match('/index.html'));
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const fresh = await fetch(request);
        if (fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch {
        return Response.error();
      }
    })(),
  );
});
