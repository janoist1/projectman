/*
 * Service worker of the installable web app. It makes the app installable and shows the static
 * offline page when a page load finds no network. It also shows web push notifications and opens the page
 * a tap on one names (the end of this file). Nothing else is cached: no API, authentication,
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

// Web push (PM-815). The server writes the whole notification (title, body, tag and the page to open), so the
// worker holds no text of its own; it only shows what arrived and sends a tap to the right page.
const PUSH_ICON = '/icons/icon-192.png';

function pushPayload(event) {
  try {
    const payload = event.data ? event.data.json() : null;
    return payload && payload.v === 1 ? payload : null;
  } catch {
    return null;
  }
}

// Only a page of this app is ever opened; anything else becomes the front page.
function targetPath(value) {
  try {
    const url = new URL(typeof value === 'string' ? value : '/', self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  const payload = pushPayload(event);
  const text = (value) => (typeof value === 'string' ? value : '');
  // A push must always show something (userVisibleOnly), so an unreadable one still shows the app's name.
  const title = (payload && text(payload.title)) || 'projectman';
  const options = {
    body: payload ? text(payload.body) : '',
    icon: PUSH_ICON,
    data: { url: targetPath(payload && payload.url) },
  };
  // The same tag replaces the earlier notification of that item instead of piling up.
  if (payload && text(payload.tag)) {
    options.tag = payload.tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

async function openApp(path) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((client) => client.focused) || windows[0];
  if (open) {
    try {
      const focused = await open.focus();
      await (focused || open).navigate(path);
      return;
    } catch {
      // A page this worker does not control cannot be navigated: open a new one instead.
    }
  }
  await self.clients.openWindow(path);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openApp(targetPath(event.notification.data && event.notification.data.url)));
});
