import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'sw.js'), 'utf8');
const ORIGIN = 'https://board.example';

type Handler = (event: unknown) => void;

interface Harness {
  handlers: Map<string, Handler>;
  cachesPut: ReturnType<typeof vi.fn>;
  cachesDelete: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
  skipWaiting: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  showNotification: ReturnType<typeof vi.fn>;
  matchAll: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
}

/** Runs the worker source against a fake worker scope; no network, no real Cache API. */
function load(options: { buildId?: string; cacheNames?: string[]; windows?: unknown[] } = {}): Harness {
  const handlers = new Map<string, Handler>();
  const cachesPut = vi.fn(async () => undefined);
  const cachesDelete = vi.fn(async () => true);
  const match = vi.fn(async () => 'OFFLINE_PAGE');
  const fetchMock = vi.fn();
  const skipWaiting = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const showNotification = vi.fn(async () => undefined);
  const matchAll = vi.fn(async () => options.windows ?? []);
  const openWindow = vi.fn(async () => undefined);
  const scope = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting,
    registration: { showNotification },
    clients: { claim, matchAll, openWindow },
  };
  const cachesStub = {
    open: vi.fn(async () => ({ put: cachesPut })),
    keys: vi.fn(async () => options.cacheNames ?? []),
    delete: cachesDelete,
    match,
  };
  const source = SOURCE.replaceAll('__BUILD_ID__', options.buildId ?? 'b1');
  new Function('self', 'caches', 'fetch', 'Response', source)(scope, cachesStub, fetchMock, {
    error: () => 'NETWORK_ERROR',
  });
  return {
    handlers,
    cachesPut,
    cachesDelete,
    fetchMock,
    match,
    skipWaiting,
    claim,
    showNotification,
    matchAll,
    openWindow,
  };
}

/** A `push` event carrying `payload` (an object is sent as JSON, a string as it is). */
async function receivePush(h: Harness, payload: unknown) {
  let waited: Promise<unknown> | undefined;
  h.handlers.get('push')!({
    data:
      payload === null ? null : { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) },
    waitUntil: (p: Promise<unknown>) => (waited = p),
  });
  await waited;
}

async function tap(h: Harness, data: unknown) {
  const close = vi.fn();
  let waited: Promise<unknown> | undefined;
  h.handlers.get('notificationclick')!({
    notification: { close, data },
    waitUntil: (p: Promise<unknown>) => (waited = p),
  });
  await waited;
  return close;
}

function navigation(url: string, init: { mode?: string; method?: string } = {}) {
  let responded: Promise<unknown> | undefined;
  const event = {
    request: { url, mode: init.mode ?? 'navigate', method: init.method ?? 'GET' },
    respondWith: (value: Promise<unknown>) => {
      responded = value;
    },
  };
  return { event, responded: () => responded };
}

describe('service worker', () => {
  it('caches only the offline page when it installs', async () => {
    const h = load();
    h.fetchMock.mockResolvedValue({ ok: true, redirected: false });
    let waited: Promise<unknown> | undefined;
    h.handlers.get('install')!({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.fetchMock.mock.calls[0]![0]).toBe('/offline.html');
    expect(h.cachesPut).toHaveBeenCalledTimes(1);
    expect(h.cachesPut.mock.calls[0]![0]).toBe('/offline.html');
    expect(h.skipWaiting).toHaveBeenCalled();
  });

  it('does not install when the offline page came through a redirect (for example an Access login)', async () => {
    const h = load();
    h.fetchMock.mockResolvedValue({ ok: true, redirected: true });
    let waited: Promise<unknown> | undefined;
    h.handlers.get('install')!({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await expect(waited).rejects.toThrow();
    expect(h.cachesPut).not.toHaveBeenCalled();
  });

  it('drops the caches of older builds only, and takes over the open pages', async () => {
    const h = load({
      buildId: 'new',
      cacheNames: ['projectman-shell-old', 'projectman-shell-new', 'someone-elses-cache'],
    });
    let waited: Promise<unknown> | undefined;
    h.handlers.get('activate')!({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    expect(h.cachesDelete.mock.calls).toEqual([['projectman-shell-old']]);
    expect(h.claim).toHaveBeenCalled();
  });

  it('serves a page load from the network', async () => {
    const h = load();
    h.fetchMock.mockResolvedValue('NETWORK_PAGE');
    const nav = navigation(`${ORIGIN}/board/PM`);
    h.handlers.get('fetch')!(nav.event);
    await expect(nav.responded()).resolves.toBe('NETWORK_PAGE');
    expect(h.match).not.toHaveBeenCalled();
    expect(h.cachesPut).not.toHaveBeenCalled();
  });

  it('shows the offline page when a page load finds no network', async () => {
    const h = load();
    h.fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const nav = navigation(`${ORIGIN}/board/PM`);
    h.handlers.get('fetch')!(nav.event);
    await expect(nav.responded()).resolves.toBe('OFFLINE_PAGE');
    expect(h.match).toHaveBeenCalledWith('/offline.html', { cacheName: 'projectman-shell-b1' });
  });

  it('never answers an API, authentication, WebSocket, hook, MCP or feedback request', () => {
    const h = load();
    h.fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const paths = [
      '/api/me',
      '/api/auth/login',
      '/ws',
      '/ws/events',
      '/hooks/x',
      '/mcp',
      '/feedback/widget.js',
    ];
    for (const path of paths) {
      // Navigations (a link to an attachment) and the app's own requests (mode `cors`, `same-origin`).
      for (const mode of ['navigate', 'cors', 'same-origin']) {
        const req = navigation(`${ORIGIN}${path}`, { mode });
        h.handlers.get('fetch')!(req.event);
        expect(req.responded(), `${mode} ${path}`).toBeUndefined();
      }
    }
    expect(h.match).not.toHaveBeenCalled();
  });

  it('leaves everything that is not a same-origin page load to the browser', () => {
    const h = load();
    const cases = [
      navigation(`${ORIGIN}/assets/app.js`, { mode: 'no-cors' }),
      navigation(`${ORIGIN}/board`, { mode: 'navigate', method: 'POST' }),
      navigation('https://team.cloudflareaccess.com/login', { mode: 'navigate' }),
    ];
    for (const c of cases) {
      h.handlers.get('fetch')!(c.event);
      expect(c.responded()).toBeUndefined();
    }
  });

  describe('web push', () => {
    const item = {
      v: 1,
      kind: 'item',
      title: 'A decision waits for you',
      body: 'PM-123',
      tag: 'item-1',
      url: '/p/PM/inbox?via=push#inbox-item-1',
    };

    it('shows the notification the server wrote, with its tag and the page a tap opens', async () => {
      const h = load();
      await receivePush(h, item);
      expect(h.showNotification).toHaveBeenCalledWith('A decision waits for you', {
        body: 'PM-123',
        icon: '/icons/icon-192.png',
        tag: 'item-1',
        renotify: true,
        data: { url: '/p/PM/inbox?via=push#inbox-item-1' },
      });
    });

    it('still shows something for a push it cannot read, because a push must be visible', async () => {
      const h = load();
      for (const payload of [null, '{not json', { v: 2, title: 'x' }]) {
        h.showNotification.mockClear();
        await receivePush(h, payload);
        expect(h.showNotification).toHaveBeenCalledTimes(1);
        expect(h.showNotification.mock.calls[0]![0]).toBe('projectman');
        expect(h.showNotification.mock.calls[0]![1]).toMatchObject({ body: '', data: { url: '/' } });
      }
    });

    it('opens only pages of this app', async () => {
      const h = load();
      await receivePush(h, { ...item, url: 'https://evil.example/phish' });
      expect(h.showNotification.mock.calls[0]![1]).toMatchObject({ data: { url: '/' } });
    });

    it('opens the page of a tapped notification in a new window when none is open', async () => {
      const h = load();
      const close = await tap(h, { url: '/p/PM/inbox?via=push#inbox-item-1' });
      expect(close).toHaveBeenCalled();
      expect(h.openWindow).toHaveBeenCalledWith('/p/PM/inbox?via=push#inbox-item-1');
    });

    it('takes an open window to the page instead of opening another', async () => {
      const navigate = vi.fn(async () => undefined);
      const client = { focused: false, focus: vi.fn(async () => ({ navigate })), navigate: vi.fn() };
      const h = load({ windows: [client] });
      await tap(h, { url: '/p/PM/inbox?via=push' });
      expect(client.focus).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith('/p/PM/inbox?via=push');
      expect(h.openWindow).not.toHaveBeenCalled();
    });

    it('opens a new window when the open one cannot be navigated', async () => {
      const client = {
        focused: true,
        focus: vi.fn(async () => ({
          navigate: vi.fn(async () => Promise.reject(new TypeError('uncontrolled'))),
        })),
      };
      const h = load({ windows: [client] });
      await tap(h, { url: '/p/PM/inbox' });
      expect(h.openWindow).toHaveBeenCalledWith('/p/PM/inbox');
    });

    it('sends a tap with no or a foreign address to the front page', async () => {
      const h = load();
      await tap(h, undefined);
      await tap(h, { url: 'https://evil.example/' });
      expect(h.openWindow.mock.calls).toEqual([['/'], ['/']]);
    });
  });

  it('puts into a cache only in the install step', () => {
    expect(SOURCE.match(/\.put\(/g)).toHaveLength(1);
    expect(SOURCE).not.toMatch(/\.add(All)?\(/);
  });
});
