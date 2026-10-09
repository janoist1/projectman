import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateEngineResponse, EngineView, ServerEvent } from '@projectman/shared';
import { routes } from '@projectman/shared';
import { createAppHarness, setupOwner, createProject, addHumanAndLogin, inject } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { machineKeyHash } from '../src/domain';
import { decodeFrame, encodeFrame, ENGINE_MAX_FRAME_BYTES } from '../src/engine-link';
import type { EngineFrame, Hello } from '../src/engine-link';

interface Socket {
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'close', listener: (code: number) => void): void;
}
const hello: Hello = {
  t: 'hello',
  protocol: 1,
  version: 'test-version',
  hostname: 'fake-engine',
  platform: 'darwin',
  paths: {
    userHome: '/fictional/user',
    home: '/fictional/engine',
    worktreesRoot: null,
    workspacesRoot: null,
    installDir: null,
    sessionFoldersRoot: null,
    sessionTmpRoot: null,
    claudeTmpRoots: [],
    browsersDir: null,
    heavyLockDir: null,
    gitExcludesFile: null,
  },
  projects: [],
  repos: [],
  providers: [{ provider: 'nanogpt', available: true, version: '1' }],
  running: [],
  nextSeq: 1,
  instanceTag: '0123456789abcdef',
  pid: 42,
  uid: 501,
  bootId: 'aaaaaaaaaaaaaaaa',
};
const spyIntervals = () => vi.spyOn(globalThis, 'setInterval');
describe('cloud engine registry and link', () => {
  let h: AppHarness;
  let cookie: string;
  let logs: string[];
  let intervals: ReturnType<typeof spyIntervals>;
  const sockets: Socket[] = [];
  beforeEach(async () => {
    logs = [];
    intervals = spyIntervals();
    h = await createAppHarness({
      now: () => new Date(),
      app: { engineMode: 'cloud', appVersion: 'test-version', claudeTmpRoots: [] },
    });
    cookie = await setupOwner(h.app);
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const socket of sockets.splice(0)) socket.terminate();
    await h.close();
    vi.restoreAllMocks();
  });
  const create = async (name = 'Office'): Promise<CreateEngineResponse> => {
    const response = await inject(h.app, 'POST', routes.engines(), cookie, { name });
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };
  const connect = async (key: string) => {
    const frames: EngineFrame[] = [];
    let closed: number | undefined;
    const ws = (await h.app.injectWS(
      routes.engineLink(),
      { headers: { authorization: `Bearer ${key}` } },
      {
        onInit: (raw) => {
          const socket = raw as unknown as Socket;
          socket.on('message', (data) => frames.push(decodeFrame(data)));
          socket.on('close', (code) => {
            closed = code;
          });
        },
      },
    )) as unknown as Socket;
    sockets.push(ws);
    return { ws, frames, closed: () => closed };
  };
  const handshake = async (key: string, greeting = hello) => {
    const connection = await connect(key);
    connection.ws.send(encodeFrame(greeting));
    await vi.waitFor(() => expect(connection.frames.some((frame) => frame.t === 'welcome')).toBe(true));
    return connection;
  };

  it('stores only the key hash, reveals the key once and manages the default transactionally', async () => {
    const one = await create('  Office  ');
    expect(one.key).toMatch(/^pme_[A-Za-z0-9_-]{43}$/);
    expect(one.engine).toMatchObject({ name: 'Office', isDefault: true, online: false });
    const row = h.app.projectman.repos.engines.get(one.engine.id)!;
    expect(row.key_hash).toBe(machineKeyHash(one.key));
    expect(JSON.stringify(row)).not.toContain(one.key);
    const two = await create('Remote');
    expect(two.engine.isDefault).toBe(false);
    const listed = await inject(h.app, 'GET', routes.engines(), cookie);
    expect(listed.body).not.toContain(one.key);
    expect(listed.body).not.toContain(row.key_hash);
    await inject(h.app, 'POST', routes.revokeEngine(one.engine.id), cookie);
    expect(h.app.projectman.engineRegistry!.status().some((engine) => engine.isDefault)).toBe(false);
    expect((await create('Third')).engine.isDefault).toBe(false);
    const selected = await inject(h.app, 'POST', routes.defaultEngine(two.engine.id), cookie);
    expect(
      selected
        .json<EngineView[]>()
        .filter((engine) => engine.isDefault)
        .map((engine) => engine.id),
    ).toEqual([two.engine.id]);
    expect((await inject(h.app, 'POST', routes.defaultEngine(one.engine.id), cookie)).statusCode).toBe(409);
    expect((await inject(h.app, 'POST', routes.revokeEngine('eng_missing'), cookie)).statusCode).toBe(404);
  });

  it('restricts mutation to host owner login and status to internal users', async () => {
    await createProject(h, cookie);
    const developer = await addHumanAndLogin(h.app, { handle: 'human' });
    const client = await addHumanAndLogin(h.app, { handle: 'client', access: 'client' });
    expect((await inject(h.app, 'GET', routes.engines(), developer)).statusCode).toBe(403);
    expect((await inject(h.app, 'POST', routes.engines(), developer, { name: 'x' })).statusCode).toBe(403);
    expect((await inject(h.app, 'GET', routes.engineStatus(), developer)).statusCode).toBe(200);
    expect((await inject(h.app, 'GET', routes.engineStatus(), client)).statusCode).toBe(403);
    const keyResponse = await inject(h.app, 'POST', routes.integratorKey(), cookie, {});
    const headers = { authorization: `Bearer ${keyResponse.json().secret}` };
    const engine = await create();
    for (const url of [
      routes.engines(),
      routes.revokeEngine(engine.engine.id),
      routes.defaultEngine(engine.engine.id),
    ]) {
      const response = await h.app.inject({ method: 'POST', url, headers, payload: { name: 'x' } });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({
        code: 'owner_login_required',
        details: { category: 'engines' },
      });
    }
    expect((await h.app.inject({ method: 'GET', url: routes.engines(), headers })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: routes.engineStatus(), headers })).statusCode).toBe(200);
  });

  it('authenticates before upgrade and isolates machine keys from human endpoints', async () => {
    const engine = await create();
    for (const headers of [
      {},
      { cookie },
      { authorization: 'Bearer pmi_fictional' },
      { authorization: 'Bearer pme_bad' },
    ]) {
      await expect(h.app.injectWS(routes.engineLink(), { headers })).rejects.toThrow('401');
    }
    expect(
      (
        await h.app.inject({
          url: routes.engines(),
          headers: { authorization: `Bearer ${engine.key}`, cookie },
        })
      ).statusCode,
    ).toBe(401);
    await inject(h.app, 'POST', routes.revokeEngine(engine.engine.id), cookie);
    await expect(
      h.app.injectWS(routes.engineLink(), { headers: { authorization: `Bearer ${engine.key}` } }),
    ).rejects.toThrow('401');
  });

  it('limits invalid keys to ten attempts per IP per minute', async () => {
    for (let i = 0; i < 10; i++) await expect(h.app.injectWS(routes.engineLink(), {})).rejects.toThrow('401');
    await expect(h.app.injectWS(routes.engineLink(), {})).rejects.toThrow('429');
  });

  it('welcomes, replaces and immediately revokes connections', async () => {
    const engine = await create();
    const one = await handshake(engine.key);
    expect(h.app.projectman.engineLinks!.get(engine.engine.id)!.hello()).toEqual(hello);
    expect(h.app.projectman.engineRegistry!.list()[0]).toMatchObject({
      online: true,
      versionMismatch: false,
      hostname: 'fake-engine',
    });
    expect(JSON.parse(h.app.projectman.repos.engines.get(engine.engine.id)!.last_hello!)).toEqual({
      hostname: hello.hostname,
      platform: hello.platform,
      version: hello.version,
      providers: hello.providers,
    });
    const two = await handshake(engine.key, { ...hello, version: 'other-version' });
    await vi.waitFor(() => expect(one.closed()).toBe(4410));
    expect(one.frames).toContainEqual({ t: 'refuse', code: 'engine_replaced', message: 'engine_replaced' });
    expect(h.app.projectman.engineRegistry!.list()[0]!.versionMismatch).toBe(true);
    await inject(h.app, 'POST', routes.revokeEngine(engine.engine.id), cookie);
    await vi.waitFor(() => expect(two.closed()).toBe(4403));
    expect(h.app.projectman.engineLinks!.get(engine.engine.id)).toBeNull();
    expect(h.app.projectman.engineRegistry!.list()[0]!.online).toBe(false);
  });

  it('refuses protocol mismatch and oversized frames', async () => {
    const engine = await create();
    const mismatch = await connect(engine.key);
    mismatch.ws.send(encodeFrame({ ...hello, protocol: 2 }));
    await vi.waitFor(() => expect(mismatch.closed()).toBe(4409));
    expect(mismatch.frames[0]).toMatchObject({ t: 'refuse', code: 'protocol_mismatch' });
    const large = await handshake(engine.key);
    large.ws.send('x'.repeat(ENGINE_MAX_FRAME_BYTES + 1));
    await vi.waitFor(() => expect(large.closed()).toBe(1009));
  });

  it('acks only handled events and reuses results across new connections', async () => {
    const engine = await create();
    const handler = vi.fn(() => null);
    h.app.projectman.engineLinks!.onChange((id, online) => {
      if (!online) return;
      const link = h.app.projectman.engineLinks!.get(id)!;
      link.onEvent(() => {});
      link.handle('permission.cancel', handler);
    });
    const one = await handshake(engine.key);
    one.ws.send(
      encodeFrame({
        t: 'evt',
        seq: 1,
        event: { kind: 'pending_input', sessionId: 'ses_test', pending: true },
      }),
    );
    await vi.waitFor(() => expect(one.frames).toContainEqual({ t: 'ack', seq: 1 }));
    const request = { t: 'req', id: 'retry', method: 'permission.cancel', params: { reqId: 'x' } } as const;
    one.ws.send(encodeFrame(request));
    await vi.waitFor(() => expect(one.frames.some((frame) => frame.t === 'res')).toBe(true));
    const two = await handshake(engine.key, { ...hello, nextSeq: 2 });
    expect(two.frames[0]).toMatchObject({ t: 'welcome', ackedSeq: 1 });
    two.ws.send(encodeFrame(request));
    await vi.waitFor(() => expect(two.frames.some((frame) => frame.t === 'res')).toBe(true));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('sends welcome before requests made synchronously by connection listeners', async () => {
    const engine = await create();
    let request: Promise<unknown> | undefined;
    h.app.projectman.engineLinks!.onChange((id, online) => {
      if (online) request = h.app.projectman.engineLinks!.get(id)!.call('host.free_disk', {});
    });
    const connection = await handshake(engine.key);
    await vi.waitFor(() => expect(connection.frames).toHaveLength(2));
    expect(connection.frames[0]).toMatchObject({ t: 'welcome' });
    const frame = connection.frames[1];
    expect(frame).toMatchObject({ t: 'req', method: 'host.free_disk' });
    if (frame?.t !== 'req') throw new Error('Expected request after welcome');
    connection.ws.send(encodeFrame({ t: 'res', id: frame.id, ok: true, result: 123 }));
    await expect(request).resolves.toBe(123);
  });

  it('broadcasts status to internal sockets without disclosing keys to clients', async () => {
    await createProject(h, cookie);
    const developer = await addHumanAndLogin(h.app, { handle: 'human' });
    const client = await addHumanAndLogin(h.app, { handle: 'client', access: 'client' });
    const internalEvents: ServerEvent[] = [];
    const clientEvents: ServerEvent[] = [];
    for (const [login, events] of [
      [developer, internalEvents],
      [client, clientEvents],
    ] as const) {
      const ws = (await h.app.injectWS(
        '/ws',
        { headers: { cookie: login } },
        {
          onInit: (socket) => {
            (socket as unknown as Socket).on('message', (data) => events.push(JSON.parse(data.toString())));
          },
        },
      )) as unknown as Socket;
      sockets.push(ws);
    }
    await create();
    await vi.waitFor(() =>
      expect(internalEvents.some((event) => event.type === 'engine_changed')).toBe(true),
    );
    expect(clientEvents.some((event) => event.type === 'engine_changed')).toBe(false);
  });

  it('does not log secret requests or responses and reexecutes the same secret request id', async () => {
    await h.close();
    h = await createAppHarness({
      app: {
        engineMode: 'cloud',
        appVersion: 'test-version',
        claudeTmpRoots: [],
        logger: { level: 'debug', stream: { write: (line: string) => logs.push(line) } },
      },
    });
    cookie = await setupOwner(h.app);
    const engine = await create();
    const handler = vi.fn(() => ({ key: 'fictional-nanogpt-response-secret' }));
    h.app.projectman.engineLinks!.onChange((id, online) => {
      if (online) h.app.projectman.engineLinks!.get(id)!.handle('secret.nanogpt_key', handler);
    });
    const link = await handshake(engine.key);
    const request = {
      t: 'req',
      id: 'secret-retry',
      method: 'secret.nanogpt_key',
      params: { sessionId: 'ses_secret_request_marker' },
    } as const;
    link.ws.send(encodeFrame(request));
    link.ws.send(encodeFrame(request));
    await vi.waitFor(() => expect(link.frames.filter((frame) => frame.t === 'res')).toHaveLength(2));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('')).not.toContain('ses_secret_request_marker');
    expect(logs.join('')).not.toContain('fictional-nanogpt-response-secret');
    expect(logs.join('')).not.toContain(engine.key);
  });

  it('requires hello within ten seconds and closes sockets revoked before hello', async () => {
    const engine = await create();
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const silent = await connect(engine.key);
    const deadline = timeouts.mock.calls.find((args) => args[1] === 10_000)?.[0];
    expect(typeof deadline).toBe('function');
    if (typeof deadline === 'function') deadline();
    await vi.waitFor(() => expect(silent.closed()).toBe(4400));
    const pending = await connect(engine.key);
    await inject(h.app, 'POST', routes.revokeEngine(engine.engine.id), cookie);
    await vi.waitFor(() => expect(pending.closed()).toBe(4403));
  });

  it('keeps status online during the disconnect grace period', async () => {
    const engine = await create();
    const connected = await handshake(engine.key);
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    connected.ws.terminate();
    await vi.waitFor(() => expect(h.app.projectman.engineLinks!.get(engine.engine.id)).toBeNull());
    expect(h.app.projectman.engineRegistry!.status()[0]!.online).toBe(true);
    const index = timeouts.mock.calls.findIndex((args) => args[1] === 120_000);
    expect(index).toBeGreaterThanOrEqual(0);
    clearTimeout(timeouts.mock.results[index]!.value);
    const expire = timeouts.mock.calls[index]![0];
    if (typeof expire === 'function') expire();
    expect(h.app.projectman.engineRegistry!.status()[0]!.online).toBe(false);
  });

  it('throttles last-seen writes and terminates engines without a pong for 45 seconds', async () => {
    const engine = await create();
    const connected = await handshake(engine.key);
    const at = Date.now();
    const seen = vi.spyOn(h.app.projectman.repos.engines, 'seen');
    vi.useFakeTimers({ toFake: ['Date'] });
    const server = [...h.app.websocketServer.clients][0] as unknown as { emit(event: 'pong'): void };
    vi.setSystemTime(at + 30_000);
    server.emit('pong');
    expect(seen).not.toHaveBeenCalled();
    vi.setSystemTime(at + 61_000);
    server.emit('pong');
    expect(seen).toHaveBeenCalledTimes(1);
    const heartbeat = intervals.mock.calls.find((args) => args[1] === 20_000)?.[0];
    expect(typeof heartbeat).toBe('function');
    vi.setSystemTime(at + 106_001);
    if (typeof heartbeat === 'function') heartbeat();
    expect(h.app.projectman.engineLinks!.get(engine.engine.id)).toBeNull();
    connected.ws.terminate();
  });

  it('uses boot identity for resumption while retaining engine-scoped RPC results', async () => {
    const engine = await create();
    const one = await handshake(engine.key);
    expect(h.app.projectman.engineLinks!.get(engine.engine.id)!.resumed).toBe(false);
    const two = await handshake(engine.key);
    expect(h.app.projectman.engineLinks!.get(engine.engine.id)!.resumed).toBe(true);
    const three = await handshake(engine.key, { ...hello, bootId: 'bbbbbbbbbbbbbbbb' });
    expect(h.app.projectman.engineLinks!.get(engine.engine.id)!.resumed).toBe(false);
    expect(three.frames[0]).toMatchObject({ t: 'welcome', ackedSeq: 0 });
    one.ws.terminate();
    two.ws.terminate();
  });

  it('starts replay at hello nextSeq after cloud state loss', async () => {
    const engine = await create();
    const handled = vi.fn();
    h.app.projectman.engineLinks!.onChange((id, online) => {
      if (online) h.app.projectman.engineLinks!.get(id)!.onEvent(handled);
    });
    const link = await handshake(engine.key, { ...hello, nextSeq: 50 });
    expect(link.frames[0]).toMatchObject({ t: 'welcome', ackedSeq: 0 });
    expect(h.app.projectman.engineLinks!.get(engine.engine.id)!.resumed).toBe(false);
    link.ws.send(
      encodeFrame({
        t: 'evt',
        seq: 50,
        event: { kind: 'pending_input', sessionId: 'ses_test', pending: true },
      }),
    );
    await vi.waitFor(() => expect(link.frames).toContainEqual({ t: 'ack', seq: 50 }));
    expect(handled).toHaveBeenCalledTimes(1);
  });
});

it('registers only engine status in single mode', async () => {
  const h = await createAppHarness({ app: { claudeTmpRoots: [] } });
  try {
    const cookie = await setupOwner(h.app);
    expect((await inject(h.app, 'GET', routes.engineStatus(), cookie)).json()).toEqual({
      mode: 'single',
      engines: [],
    });
    expect((await inject(h.app, 'GET', routes.engines(), cookie)).statusCode).toBe(404);
    expect((await inject(h.app, 'GET', routes.engineLink(), cookie)).statusCode).toBe(404);
  } finally {
    await h.close();
  }
});
