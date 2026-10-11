import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppHarness } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { rawRequest } from './helpers/raw-http';

const PUBLIC_HOST = 'jelolo.example.com';
const NOT_FOUND = { error: { code: 'not_found', message: 'route not found' } };

// The widget's public entrance (PM-513): on its own hostname only the widget's paths are served. The
// requests are written raw to the socket, because `app.inject` normalizes `..`, `%2e` and `//`.
describe('the feedback widget public entrance', () => {
  let h: AppHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(feedbackPublicUrl: string | undefined, feedbackWidgetFile?: string): Promise<number> {
    h = await createAppHarness({ app: { feedbackPublicUrl, feedbackWidgetFile } });
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    return (h.app.server.address() as AddressInfo).port;
  }

  it.each([
    '/',
    '/index.html',
    '/api/setup',
    '/api/auth/login',
    '/ws',
    '/hooks/x',
    '/mcp/x',
    '/feedback',
    '/feedback/',
    '/feedback/../api/setup',
    '/feedback/%2e%2e/api/setup',
    '/feedback/%2E%2E/api/setup',
    '/feedback/api/v1//marks',
    '/feedback/api/v1/marks/..%2f..%2fx',
    '/FEEDBACK/widget.js',
    '/feedback/api/v1/marks/../../../api/setup',
  ])('answers the unknown-route 404 to %s on the public hostname', async (target) => {
    const port = await start(`https://${PUBLIC_HOST}`);
    const res = await rawRequest(port, target, { host: PUBLIC_HOST });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual(NOT_FOUND);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses every method on a path that is not the widget', async () => {
    const port = await start(`https://${PUBLIC_HOST}`);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
      const res = await rawRequest(port, '/api/auth/login', { host: PUBLIC_HOST, method });
      expect([method, res.status]).toEqual([method, 404]);
    }
  });

  it('refuses a websocket upgrade on a path that is not the widget', async () => {
    const port = await start(`https://${PUBLIC_HOST}`);
    const upgrade = await rawRequest(port, '/ws', {
      host: PUBLIC_HOST,
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        Origin: `https://${PUBLIC_HOST}`,
      },
    });
    expect(upgrade.status).toBe(404);
  });

  it('serves the widget script and reaches the widget API on the public hostname', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-entrance-'));
    try {
      const file = join(dir, 'widget.js');
      writeFileSync(file, '(function(){})();\n');
      const port = await start(`https://${PUBLIC_HOST}`, file);
      const script = await rawRequest(port, '/feedback/widget.js?v=1', { host: PUBLIC_HOST });
      expect(script.status).toBe(200);
      expect(script.body).toBe('(function(){})();\n');
      // The API answers itself (its own session check), not the guard's route-not-found.
      const list = await rawRequest(port, '/feedback/api/v1/marks', {
        host: PUBLIC_HOST,
        headers: { Origin: 'https://shop.example.com' },
      });
      expect(list.status).toBe(403);
      expect(JSON.parse(list.body).error.code).toBe('feedback_origin_not_allowed');
      const preflight = await rawRequest(port, '/feedback/api/v1/marks', {
        host: PUBLIC_HOST,
        method: 'OPTIONS',
        headers: { Origin: 'https://other.example.com', 'Access-Control-Request-Method': 'POST' },
      });
      expect(preflight.status).toBe(403);
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the application hostname unchanged', async () => {
    const port = await start(`https://${PUBLIC_HOST}`);
    for (const host of [`127.0.0.1:${port}`, 'chopper.example.com']) {
      const setup = await rawRequest(port, '/api/setup', { host });
      expect([host, setup.status]).toEqual([host, 200]);
      expect(JSON.parse(setup.body)).toHaveProperty('needsSetup');
    }
  });

  it('judges the host without the case, and the root label dot, of the Host header', async () => {
    const port = await start(`https://${PUBLIC_HOST}`);
    for (const host of ['JELOLO.EXAMPLE.COM', `${PUBLIC_HOST}.`]) {
      const res = await rawRequest(port, '/api/setup', { host });
      expect([host, res.status]).toEqual([host, 404]);
    }
  });

  it('has no guard without a public address, or with a loopback one', async () => {
    for (const url of [undefined, 'http://127.0.0.1:4700']) {
      const port = await start(url);
      const res = await rawRequest(port, '/api/setup', { host: PUBLIC_HOST });
      expect([url, res.status]).toEqual([url, 200]);
      await h?.close();
      h = undefined;
    }
  });

  it.each(['http://jelolo.example.com', 'https://jelolo.example.com/feedback', 'not a url'])(
    'does not start with the public address %s',
    async (feedbackPublicUrl) => {
      await expect(createAppHarness({ app: { feedbackPublicUrl } })).rejects.toThrow(
        /invalid PROJECTMAN_FEEDBACK_PUBLIC_URL/,
      );
    },
  );
});
