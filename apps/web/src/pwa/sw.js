/*
 * Service worker of the installable web app. It makes the app installable and shows the static
 * offline page when a page load finds no network. Nothing else is cached: no API, authentication,
 * WebSocket or Cloudflare Access response, and no app shell, so a new release runs at the next open.
 *
 * The build (vite-plugin-pwa.ts) copies this file to /sw.js and fills in BUILD_ID, a hash of the offline
 * page and of this file, so the cached offline page is replaced when either changes.
 */
const BUILD_ID = '__BUILD_ID__';
const CACHE_PREFIX = 'projectman-shell-';
const CACHE_NAME = CACHE_PREFIX + BUILD_ID;
const OFFLINE_URL = '/offline.html';
// Paths served by the server itself (apps/server/src/http/errors.ts SERVER_PREFIXES): never answered here.
const SERVER_PREFIXES = ['/api', '/ws', '/hooks', '/mcp', '/feedback'];

function isServerPath(pathname) {
  return SERVER_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        const response = await fetch(OFFLINE_URL, { cache: 'reload' });
        // An Access login page behind a redirect is not the offline page.
        if (!response.ok || response.redirected) throw new Error('offline page unavailable');
        await cache.put(OFFLINE_URL, response);
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Page loads go to the network; only a failed load falls back to the cached offline page.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isServerPath(url.pathname)) return;
  event.respondWith(
    fetch(request).catch(
      async () => (await caches.match(OFFLINE_URL, { cacheName: CACHE_NAME })) ?? Response.error(),
    ),
  );
});

// Web push (a `push` and a `notificationclick` handler) is added here by the notification card (PM-815).
