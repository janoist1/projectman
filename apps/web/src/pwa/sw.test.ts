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
}

/** Runs the worker source against a fake worker scope; no network, no real Cache API. */
function load(options: { buildId?: string; cacheNames?: string[] } = {}): Harness {
  const handlers = new Map<string, Handler>();
  const cachesPut = vi.fn(async () => undefined);
  const cachesDelete = vi.fn(async () => true);
  const match = vi.fn(async () => 'OFFLINE_PAGE');
  const fetchMock = vi.fn();
  const skipWaiting = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const scope = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting,
    clients: { claim },
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
  return { handlers, cachesPut, cachesDelete, fetchMock, match, skipWaiting, claim };
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

  it('puts into a cache only in the install step', () => {
    expect(SOURCE.match(/\.put\(/g)).toHaveLength(1);
    expect(SOURCE).not.toMatch(/\.add(All)?\(/);
  });
});
