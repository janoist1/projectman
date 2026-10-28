import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_EXIT } from '@projectman/shared';
import { main } from '../../../scripts/projectman/cli';
import {
  CANARY_ACCESS_ID,
  CANARY_ACCESS_SECRET,
  CANARY_KEY,
  createClientHome,
  createTestIo,
  jsonResponse,
  type ClientHome,
  type Handler,
  type TestIoOptions,
} from './helpers/projectman-client';

const BODY_TEXT = 'tool-argument-that-must-not-be-logged';
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
const call = {
  jsonrpc: '2.0',
  id: 'a-2',
  method: 'tools/call',
  params: { name: 'x', arguments: { text: BODY_TEXT } },
};
const notification = { jsonrpc: '2.0', method: 'notifications/initialized' };
const lines = (...messages: unknown[]) => messages.map((message) => `${JSON.stringify(message)}\n`).join('');

describe('projectman mcp-proxy (PM-765)', () => {
  let fx: ClientHome;
  beforeEach(() => {
    fx = createClientHome({ access: true });
  });
  afterEach(() => fx.cleanup());

  const proxy = async (handler: Handler, options: TestIoOptions, extra: string[] = []) => {
    const t = createTestIo(fx.home, handler, options);
    const code = await main(['mcp-proxy', ...extra], t.io);
    return { code, ...t };
  };
  const result = (id: unknown) => ({ jsonrpc: '2.0', id, result: { ok: true } });

  it('forwards each line to /mcp with the key and the Access headers, and writes the answer as one line', async () => {
    const run = await proxy(() => jsonResponse(result(1)), { stdin: lines(initialize) });
    expect(run.code).toBe(CLIENT_EXIT.ok);
    expect(run.requests).toHaveLength(1);
    const [request] = run.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url.href).toBe('https://pm.example.com/mcp');
    expect(request?.headers).toMatchObject({
      authorization: `Bearer ${CANARY_KEY}`,
      'cf-access-client-id': CANARY_ACCESS_ID,
      'cf-access-client-secret': CANARY_ACCESS_SECRET,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });
    // The server counts /mcp as the MCP channel by itself; the proxy claims nothing else.
    expect(request?.headers['x-projectman-client']).toBeUndefined();
    expect(request?.redirect).toBe('manual');
    expect(JSON.parse(request?.body ?? '')).toEqual(initialize);
    expect(run.stdout).toEqual([`${JSON.stringify(result(1))}\n`]);
    expect(run.stderr).toEqual([]);
  });

  it('is a transport only: the body goes through untouched, whatever the method', async () => {
    const run = await proxy(() => jsonResponse(result('a-2')), { stdin: lines(call) });
    expect(JSON.parse(run.requests[0]?.body ?? '')).toEqual(call);
    expect(run.stderr.join('')).not.toContain(BODY_TEXT);
  });

  it('answers a notification with nothing on standard output', async () => {
    const run = await proxy(() => new Response(null, { status: 202 }), { stdin: lines(notification) });
    expect(run.code).toBe(0);
    expect(run.requests).toHaveLength(1);
    expect(run.stdout).toEqual([]);
    expect(run.stderr).toEqual([]);
  });

  it('assembles lines from chunks that split them, and takes a last line without a newline', async () => {
    const text = lines(initialize, notification) + JSON.stringify(call);
    const chunks = [text.slice(0, 7), text.slice(7, 90), text.slice(90)];
    const run = await proxy(
      (request) => {
        const id = (JSON.parse(request.body ?? '{}') as { id?: unknown }).id;
        return id === undefined ? new Response(null, { status: 202 }) : jsonResponse(result(id));
      },
      { stdin: chunks },
    );
    expect(run.requests.map((request) => JSON.parse(request.body ?? '{}'))).toEqual([
      initialize,
      notification,
      call,
    ]);
    expect(run.stdout.map((line) => JSON.parse(line).id).sort()).toEqual([1, 'a-2']);
  });

  it('skips blank lines and writes a server-sent-event answer as one protocol message per line', async () => {
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\n\nevent: message\ndata: ${JSON.stringify(result(1))}\n\n`;
    const run = await proxy(
      () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      { stdin: `\n\r\n${lines(initialize)}\n` },
    );
    expect(run.requests).toHaveLength(1);
    expect(run.stdout.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', method: 'notifications/progress' },
      result(1),
    ]);
  });

  it('standard output holds protocol messages only, even when the server misbehaves', async () => {
    const answers: Array<() => Response> = [
      () => jsonResponse(result(1)),
      () =>
        new Response('<html>gateway</html>', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      () => new Response('boom', { status: 502 }),
    ];
    const run = await proxy((_request, index) => answers[index]!(), {
      stdin: lines(initialize, { ...call, id: 2 }, { ...call, id: 3 }),
    });
    expect(run.stdout.length).toBeGreaterThanOrEqual(3);
    for (const line of run.stdout) {
      expect(line.endsWith('\n')).toBe(true);
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }
    expect(run.code).toBe(CLIENT_EXIT.failed);
  });

  it('answers each request that cannot be served with a JSON-RPC error, so the client does not wait', async () => {
    const run = await proxy(
      () => jsonResponse({ error: { code: 'internal_error', message: BODY_TEXT } }, 500),
      {
        stdin: lines(call, notification),
      },
    );
    expect(run.code).toBe(CLIENT_EXIT.failed);
    expect(run.stdout).toHaveLength(1);
    expect(JSON.parse(run.stdout[0]!)).toMatchObject({ jsonrpc: '2.0', id: 'a-2', error: { code: -32000 } });
    expect(run.stderr.join('')).toContain('HTTP 500');
    expect(run.stderr.join('')).toContain('internal_error');
    // No body of any message reaches the error stream.
    expect(run.output()).not.toContain(BODY_TEXT);
  });

  it('ends with status 3 for a refused key', async () => {
    const run = await proxy(
      () => jsonResponse({ error: { code: 'integrator_key_invalid', message: `Bearer ${CANARY_KEY}` } }, 401),
      { stdin: lines(initialize) },
    );
    expect(run.code).toBe(CLIENT_EXIT.auth);
    expect(run.stderr.join('')).toContain('integrator_key_invalid');
    expect(run.output()).not.toContain(CANARY_KEY);
  });

  it('does not follow a redirect and does not hang the client', async () => {
    const run = await proxy(
      () => new Response(null, { status: 307, headers: { location: 'https://evil.example/mcp' } }),
      { stdin: lines(initialize) },
    );
    expect(run.requests).toHaveLength(1);
    expect(run.code).toBe(CLIENT_EXIT.failed);
    expect(JSON.parse(run.stdout[0]!)).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(run.output()).not.toContain('evil.example');
  });

  it('redacts a network failure and answers the request', async () => {
    const run = await proxy(
      () => {
        throw new TypeError(`fetch failed ${CANARY_KEY}`, { cause: { code: 'ECONNREFUSED' } });
      },
      { stdin: lines(initialize) },
      ['--verbose'],
    );
    expect(run.code).toBe(CLIENT_EXIT.failed);
    expect(run.stderr.join('')).toContain('ECONNREFUSED');
    expect(JSON.parse(run.stdout[0]!).error.message).not.toContain(CANARY_KEY);
    for (const secret of [CANARY_KEY, CANARY_ACCESS_ID, CANARY_ACCESS_SECRET])
      expect(run.output()).not.toContain(secret);
  });

  it('--verbose adds status lines without any message body', async () => {
    const run = await proxy(() => jsonResponse(result('a-2')), { stdin: lines(call) }, ['--verbose']);
    expect(run.stderr.join('')).toContain('POST /mcp -> 200');
    expect(run.output()).not.toContain(BODY_TEXT);
    expect(run.stderr.join('').toLowerCase()).not.toContain('authorization');
  });

  it('stops reading when a credential file is wrong, before it touches standard input', async () => {
    fs.chmodSync(fx.keyFile, 0o644);
    let read = false;
    const stdin = (async function* () {
      read = true;
      yield lines(initialize);
    })();
    const run = await proxy(() => jsonResponse(result(1)), { stdin });
    expect(run.code).toBe(CLIENT_EXIT.auth);
    expect(read).toBe(false);
    expect(run.requests).toEqual([]);
    expect(run.stdout).toEqual([]);
  });

  it('takes no secret as an argument', async () => {
    const run = await proxy(() => jsonResponse(result(1)), { stdin: '' }, ['--token', CANARY_KEY]);
    expect(run.code).toBe(CLIENT_EXIT.usage);
    expect(run.requests).toEqual([]);
    expect(run.output()).not.toContain(CANARY_KEY);
  });

  it('ends on the signal while standard input is open and silent (SIGTERM, Ctrl-C)', async () => {
    let closed = false;
    const stdin: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<string>>(() => undefined),
        return: async () => {
          closed = true;
          return { done: true, value: undefined };
        },
      }),
    };
    const t = createTestIo(fx.home, () => jsonResponse(result(1)), { stdin });
    const finished = main(['mcp-proxy'], t.io);
    setTimeout(() => t.controller.abort(), 10);
    expect(await finished).toBe(CLIENT_EXIT.ok);
    expect(closed).toBe(true);
    expect(t.requests).toEqual([]);
  });

  it('answers a request that was already read before the signal, then ends on the signal', async () => {
    let t: ReturnType<typeof createTestIo> | undefined;
    const stdin = (async function* () {
      yield lines(initialize);
      await new Promise<void>(() => undefined);
    })();
    t = createTestIo(
      fx.home,
      () => {
        setTimeout(() => t?.controller.abort(), 0);
        return jsonResponse(result(1));
      },
      { stdin },
    );
    expect(await main(['mcp-proxy'], t.io)).toBe(CLIENT_EXIT.ok);
    expect(t.requests).toHaveLength(1);
  });

  it('stops after the signal and leaves unanswered requests alone', async () => {
    let t: ReturnType<typeof createTestIo> | undefined;
    t = createTestIo(
      fx.home,
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          queueMicrotask(() => t?.controller.abort());
        }),
      { stdin: lines(initialize) },
    );
    const code = await main(['mcp-proxy'], t.io);
    expect(code).toBe(CLIENT_EXIT.ok);
    expect(t.stdout).toEqual([]);
  });
});
