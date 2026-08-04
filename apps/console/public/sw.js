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

const CACHE_VERSION = 'v3';
const CACHE_NAME = `marine-ai-console-${CACHE_VERSION}`;

// Map tiles live in their own cache, kept across version bumps. Re-fetching a
// warmed demo area over venue wifi is exactly the failure this is here to stop,
// so a new build must not throw the imagery away with the app shell.
const TILE_CACHE = 'marine-ai-tiles-v1';

// Every tile host the console draws from. Anything not on this list is left to
// the browser, so a typo here degrades to the old behaviour rather than caching
// something it should not.
const TILE_HOSTS = new Set([
  'server.arcgisonline.com',   // Esri World Imagery + Ocean Reference
  'tile.openstreetmap.org',    // OSM roadmap
  'a.basemaps.cartocdn.com',   // CARTO dark + labels
  'b.basemaps.cartocdn.com',
  'c.basemaps.cartocdn.com',
  'd.basemaps.cartocdn.com',
  'tiles.openseamap.org',      // seamark overlay
]);

// A demo route's worth of imagery at several zooms, not a world atlas. Once past
// this, the oldest entries go first -- tiles are the definition of a cache that
// should be allowed to forget.
const TILE_CACHE_MAX = 1200;

const PRECACHE = ['/', '/index.html', '/manifest.json'];

/** Stale-while-revalidate. A warm tile paints immediately and refreshes behind
 *  the paint; a cold one is fetched and stored. On a dead network a warm tile
 *  still paints, which is the whole point on a venue connection. */
async function tileResponse(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((fresh) => {
      // `opaque` responses (status 0) are kept too: tile <img> requests are
      // no-cors, so opaque is the NORMAL case here, not a failure. It cannot be
      // inspected, but it can be replayed, and replaying it is the whole job.
      if (fresh && (fresh.ok || fresh.type === 'opaque')) {
        cache.put(request, fresh.clone()).then(() => trimTileCache(cache));
      }
      return fresh;
    })
    .catch(() => undefined);

  return cached || (await network) || Response.error();
}

async function trimTileCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= TILE_CACHE_MAX) return;
  // keys() is insertion-ordered, so the head is the oldest.
  await Promise.all(keys.slice(0, keys.length - TILE_CACHE_MAX).map((k) => cache.delete(k)));
}

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
      await Promise.all(
        names
          .filter((n) => n !== CACHE_NAME && n !== TILE_CACHE)
          .map((n) => caches.delete(n)),
      );
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

  // Map tiles ARE intercepted, and this is a reversal of the note that used to
  // sit here ("intercepting opaque responses buys nothing"). It buys the demo.
  // Observed on venue wifi: the satellite layer arrives in fragments or not at
  // all, so the 2D chart shows place labels floating over a dark void and the 3D
  // view shows the boat on flat blue. The browser's HTTP cache did not save it,
  // because it is per-response and freely evicted. Serving a warmed tile from
  // here makes the second run of a demo look like the first.
  if (TILE_HOSTS.has(url.hostname)) {
    event.respondWith(tileResponse(request));
    return;
  }

  // Everything else cross-origin (map libraries, fonts) stays with the browser.
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
