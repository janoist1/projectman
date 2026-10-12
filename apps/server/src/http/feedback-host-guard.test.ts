import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../../test/helpers/raw-http';
import {
  isPublicFeedbackPath,
  parseFeedbackPublicUrl,
  registerFeedbackHostGuard,
} from './feedback-host-guard';

describe('parseFeedbackPublicUrl', () => {
  it.each([
    ['https://jelolo.example.com', 'jelolo.example.com', false],
    ['https://jelolo.example.com/', 'jelolo.example.com', false],
    ['  https://Jelolo.Example.com  ', 'jelolo.example.com', false],
    ['https://jelolo.example.com:8443', 'jelolo.example.com:8443', false],
    ['https://jelolo.example.com.', 'jelolo.example.com', false],
    ['http://127.0.0.1:4700', '127.0.0.1:4700', true],
    ['http://localhost:4700/', 'localhost:4700', true],
    ['http://[::1]:4700', '[::1]:4700', true],
    ['https://localhost', 'localhost', true],
  ])('accepts %s', (raw, host, loopback) => {
    const address = parseFeedbackPublicUrl(raw);
    expect(address.host).toBe(host);
    expect(address.loopback).toBe(loopback);
  });

  it.each([
    ['http://jelolo.example.com', 'loopback'],
    ['jelolo.example.com', 'URL'],
    ['ftp://jelolo.example.com', 'https'],
    ['https://jelolo.example.com/feedback', 'path'],
    ['https://jelolo.example.com//', 'path'],
    ['https://jelolo.example.com/?a=1', 'query'],
    ['https://jelolo.example.com?', 'query'],
    ['https://jelolo.example.com/#x', '#'],
    ['https://jelolo.example.com#', '#'],
    ['https://user:secret@jelolo.example.com', 'user name'],
    ['', 'URL'],
  ])('rejects %s', (raw, why) => {
    expect(() => parseFeedbackPublicUrl(raw)).toThrow(
      new RegExp(`invalid PROJECTMAN_FEEDBACK_PUBLIC_URL.*${why}`),
    );
  });
});

describe('isPublicFeedbackPath', () => {
  it.each([
    '/feedback/widget.js',
    '/feedback/widget.js?v=3',
    '/feedback/api/v1/marks',
    '/feedback/api/v1/sessions/current',
    '/feedback/api/v1/marks/mk_a1-B2/comments',
    '/feedback/api/v1/marks?since=2026-10-11T10%3A00%3A00.000Z&limit=5',
  ])('serves %s', (target) => {
    expect(isPublicFeedbackPath(target)).toBe(true);
  });

  it.each([
    '/',
    '/api/setup',
    '/ws',
    '/hooks/x',
    '/mcp/x',
    '/feedback',
    '/feedback/',
    '/feedback/widget.js/',
    '/feedback/widget.jsx',
    '/feedback/widget.js/x',
    '/feedback/../api/setup',
    '/feedback/./widget.js',
    '/feedback/%2e%2e/api/setup',
    '/feedback/%2E%2E/api/setup',
    '/feedback/api/v1/%2e%2e/%2e%2e/api/setup',
    '/feedback/api/v1/marks/..%2f..%2fx',
    '/feedback/api/v1/marks/../x',
    '/feedback/api/v1/marks/./x',
    '/feedback/api/v1//marks',
    '/feedback//api/v1/marks',
    '//feedback/widget.js',
    '/feedback/api/v1/',
    '/feedback/api/v1/marks/',
    '/feedback/api/v1',
    '/feedback/api/v2/marks',
    '/feedback/api/v1/marks\\..\\x',
    '/feedback/api/v1/ma rks',
    '/feedback/api/v1/marks%2fx',
    '/feedback/api/v1/marks;x',
    '/feedback/api/v1/marks#x',
    '/feedback/api/v1/marks\n',
    '/FEEDBACK/widget.js',
    '/Feedback/api/v1/marks',
    '/feedback/API/v1/marks',
    '/feedback/widget.JS',
    'http://jelolo.example.com/feedback/widget.js',
    '*',
    '',
  ])('refuses %j', (target) => {
    expect(isPublicFeedbackPath(target)).toBe(false);
  });
});

describe('registerFeedbackHostGuard', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** An instance that answers 200 "served" on every path, behind the guard. */
  async function serve(url: string): Promise<number> {
    app = Fastify();
    registerFeedbackHostGuard(app, parseFeedbackPublicUrl(url));
    app.all('/*', async () => 'served');
    await app.listen({ host: '127.0.0.1', port: 0 });
    return (app.server.address() as AddressInfo).port;
  }

  it('lets the widget paths through and refuses everything else on the public host only', async () => {
    const port = await serve('https://jelolo.example.com');
    const host = 'jelolo.example.com';
    for (const target of [
      '/feedback/widget.js',
      '/feedback/api/v1/marks',
      '/feedback/api/v1/marks/mk1/read',
    ]) {
      const res = await rawRequest(port, target, { host });
      expect([target, res.status]).toEqual([target, 200]);
    }
    const options = await rawRequest(port, '/feedback/api/v1/marks', { host, method: 'OPTIONS' });
    expect(options.status).toBe(200);

    for (const target of ['/', '/api/setup', '/feedback/../api/setup', '/feedback/api/v1//marks']) {
      const res = await rawRequest(port, target, { host });
      expect([target, res.status]).toEqual([target, 404]);
      expect(JSON.parse(res.body)).toEqual({ error: { code: 'not_found', message: 'route not found' } });
    }
    // Any other hostname (the application's own) is untouched.
    const other = await rawRequest(port, '/api/setup', { host: 'chopper.example.com' });
    expect(other.status).toBe(200);
  });

  it('compares the Host header in lowercase, with its port, and without the root label dot', async () => {
    const port = await serve('https://jelolo.example.com:8443');
    for (const host of ['jelolo.example.com:8443', 'JELOLO.Example.com:8443', 'jelolo.example.com.:8443']) {
      const res = await rawRequest(port, '/api/setup', { host });
      expect([host, res.status]).toEqual([host, 404]);
    }
    // Another port is another host for the guard (and for Cloudflare's hostname rule).
    expect((await rawRequest(port, '/api/setup', { host: 'jelolo.example.com' })).status).toBe(200);
  });

  it('does nothing for a loopback address', async () => {
    const port = await serve('http://127.0.0.1:4700');
    const res = await rawRequest(port, '/api/setup', { host: '127.0.0.1:4700' });
    expect(res.status).toBe(200);
  });
});
