import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeCloud } from '../../test/helpers/fake-cloud';
import type { FakeCloud } from '../../test/helpers/fake-cloud';
import { waitFor } from '../../test/helpers/wait';
import {
  createEngineClient,
  ENGINE_BACKOFF_MAX_MS,
  ENGINE_BACKOFF_MIN_MS,
  ENGINE_HANDSHAKE_TIMEOUT_MS,
} from './engine-client';
import type { EngineClient, LinkSocket } from './engine-client';
import type { ResolvedEngineConfig } from './engine-config';
import { createEngineStatusWriter } from './engine-status';
import { createEngineEventBuffer } from './event-buffer';
import type { EngineEvent, Hello } from './protocol';

const KEY = 'machine-key-0123456789abcdef';
const logger = Fastify({ logger: false }).log;

const facts = (): Omit<Hello, 't' | 'protocol' | 'nextSeq'> => ({
  version: '0.0.0-test',
  hostname: 'mac',
  platform: 'darwin',
  paths: {
    userHome: '/Users/me',
    home: '/Users/me/.projectman',
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
  projects: [{ project: 'PM', workspacePath: '/Users/me/work' }],
  repos: [{ project: 'PM', repo: 'projectman', fullTest: true }],
  providers: [],
  running: [],
  instanceTag: 'a'.repeat(16),
  pid: 4242,
  uid: 501,
  bootId: 'b'.repeat(16),
});

const pendingInput = (sessionId: string): EngineEvent => ({
  kind: 'pending_input',
  sessionId,
  pending: true,
});

describe('engine link client', () => {
  let dir: string;
  let cloud: FakeCloud;
  let client: EngineClient | null;

  /** The cloud sends its welcome before the engine has read it: wait for the engine's side too. */
  const online = async (started: EngineClient, afterConnections = 0) => {
    await cloud.connected(afterConnections);
    await waitFor(() => started.connected(), 'the engine to be connected');
  };

  const config = (overrides: Partial<ResolvedEngineConfig> = {}): ResolvedEngineConfig => ({
    schemaVersion: 1,
    cloudUrl: cloud.url,
    engineId: 'eng_aaaaaaaaaaaa',
    name: 'mac',
    keyFile: path.join(dir, 'engine.key'),
    projects: [],
    repos: [],
    maxPermissionMode: 'auto',
    allowRemoteTerminalInput: true,
    ...overrides,
  });

  const make = (
    options: { buffer?: ReturnType<typeof createEngineEventBuffer>; config?: ResolvedEngineConfig } = {},
  ) => {
    const buffer = options.buffer ?? createEngineEventBuffer();
    const status = createEngineStatusWriter(
      path.join(dir, 'status.json'),
      { pid: 4242, bootId: 'b'.repeat(16) },
      { delayMs: 5 },
    );
    const created = createEngineClient({
      config: options.config ?? config(),
      hello: async () => facts(),
      register: () => undefined,
      onRefused: () => undefined,
      buffer,
      status,
      logger,
      random: () => 0,
    });
    client = created;
    return { client: created, buffer, status };
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'engine-client-'));
    writeFileSync(path.join(dir, 'engine.key'), `${KEY}\n`, { mode: 0o600 });
    chmodSync(path.join(dir, 'engine.key'), 0o600);
    client = null;
  });

  afterEach(async () => {
    await client?.close();
    await cloud?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('says hello with the identity facts and the machine key', async () => {
    cloud = await startFakeCloud();
    writeFileSync(path.join(dir, 'headers.json'), JSON.stringify({ 'CF-Access-Client-Id': 'abc' }), {
      mode: 0o600,
    });
    chmodSync(path.join(dir, 'headers.json'), 0o600);
    const { client: started } = make({ config: config({ linkHeadersFile: path.join(dir, 'headers.json') }) });
    started.start();
    await cloud.connected();
    expect(cloud.authorizations).toEqual([`Bearer ${KEY}`]);
    expect(cloud.requestHeaders[0]?.['cf-access-client-id']).toBe('abc');
    expect(cloud.hellos[0]).toMatchObject({
      protocol: 1,
      instanceTag: 'a'.repeat(16),
      pid: 4242,
      uid: 501,
      bootId: 'b'.repeat(16),
      nextSeq: 1,
    });
    await online(started);
  });

  it('keeps events while the cloud is away and delivers them in order once it is there', async () => {
    cloud = await startFakeCloud();
    const { client: started } = make();
    started.emit(pendingInput('s1'));
    started.emit(pendingInput('s2'));
    started.emit(pendingInput('s3'));
    started.start();
    await cloud.connected();
    await waitFor(() => cloud.received.length === 3, 'three events');
    expect(cloud.received.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    await started.flush(5000);
    expect(cloud.hellos[0]?.nextSeq).toBe(1);
  });

  it('replays what the cloud has not acknowledged after a reconnect, without repeating acknowledged events', async () => {
    cloud = await startFakeCloud({ holdAcks: true });
    const { client: started, buffer } = make();
    started.start();
    await cloud.connected();
    started.emit(pendingInput('s1'));
    started.emit(pendingInput('s2'));
    await waitFor(() => cloud.received.length === 2, 'both events');
    cloud.ackUpTo(1);
    await waitFor(() => buffer.pending() === 1, 'the acknowledgement');
    cloud.drop();
    await cloud.connected(1);
    expect(cloud.hellos[1]?.nextSeq).toBe(2);
    await waitFor(() => cloud.received.length === 3, 'the replay');
    expect(cloud.received.map((entry) => entry.seq)).toEqual([1, 2, 2]);
    started.emit(pendingInput('s3'));
    await waitFor(() => cloud.received.length === 4, 'the new event');
    expect(cloud.received[3]?.seq).toBe(3);
  });

  it('drops the oldest events past the cap and tells the cloud where it starts', async () => {
    cloud = await startFakeCloud();
    const buffer = createEngineEventBuffer({ maxEvents: 3 });
    const { client: started, status } = make({ buffer });
    for (let i = 1; i <= 5; i += 1) started.emit(pendingInput(`s${i}`));
    expect(buffer.dropped()).toBe(2);
    expect(status.get().droppedEvents).toBe(2);
    started.start();
    await cloud.connected();
    expect(cloud.hellos[0]?.nextSeq).toBe(3);
    await waitFor(() => cloud.received.length === 3, 'the kept events');
    expect(cloud.received.map((entry) => entry.seq)).toEqual([3, 4, 5]);
  });

  it('sends terminal data only while connected and never buffers it', async () => {
    cloud = await startFakeCloud();
    const { client: started, buffer } = make();
    started.terminal('s1', 'lost');
    expect(buffer.pending()).toBe(0);
    started.start();
    await online(started);
    started.terminal('s1', 'seen');
    await waitFor(() => cloud.terminals.length === 1, 'the terminal data');
    expect(cloud.terminals).toEqual([{ sessionId: 's1', data: 'seen' }]);
  });

  it('calls the cloud over the link', async () => {
    cloud = await startFakeCloud();
    cloud.handle('secret.nanogpt_key', (params) => {
      expect(params.sessionId).toBe('s1');
      return { key: 'k' };
    });
    const { client: started } = make();
    started.start();
    await cloud.connected();
    await expect(started.call('secret.nanogpt_key', { sessionId: 's1' })).resolves.toEqual({ key: 'k' });
  });

  it('fails a call with link_down when the cloud does not come back within the wait', async () => {
    cloud = await startFakeCloud();
    const { client: started } = make();
    await expect(
      started.call('secret.nanogpt_key', { sessionId: 's1' }, { timeoutMs: 20 }),
    ).rejects.toMatchObject({
      code: 'link_down',
    });
  });

  it('stops for good when the cloud revoked the engine, and says why in the status', async () => {
    cloud = await startFakeCloud();
    const { client: started, status } = make();
    started.start();
    await cloud.connected();
    cloud.drop(4403);
    await waitFor(() => status.get().connection === 'stopped', 'the stop');
    expect(status.get().lastError?.code).toBe('engine_revoked');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(cloud.connections()).toBe(1);
  });

  it('stops for good when another process replaced it', async () => {
    cloud = await startFakeCloud();
    const { client: started, status } = make();
    started.start();
    await cloud.connected();
    cloud.drop(4410);
    await waitFor(() => status.get().connection === 'stopped', 'the stop');
    expect(status.get().lastError?.code).toBe('engine_replaced');
  });

  it('reconnects by itself after a lost connection', async () => {
    cloud = await startFakeCloud();
    const { client: started } = make();
    started.start();
    await cloud.connected();
    cloud.drop();
    await online(started, 1);
    expect(cloud.hellos).toHaveLength(2);
  });

  it('retries after the cloud rejects the first WebSocket upgrade', async () => {
    cloud = await startFakeCloud({ rejectUpgrades: 1 });
    const { client: started, status } = make();
    started.start();
    await online(started);
    expect(cloud.hellos).toHaveLength(1);
    expect(cloud.connections()).toBe(1);
    expect(status.get()).toMatchObject({ connection: 'connected', attempts: 2 });
  });

  it('closes the link cleanly on close and does not come back', async () => {
    cloud = await startFakeCloud();
    const { client: started } = make();
    started.start();
    await online(started);
    await started.close();
    // Node's WebSocket cannot send 1001; a normal close with the reason engine_shutdown is what it can do.
    await waitFor(() => cloud.closeCodes.includes(1000), 'the close code');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(cloud.connections()).toBe(1);
  });

  it('refuses to open the link with a key file that others can read', async () => {
    cloud = await startFakeCloud();
    chmodSync(path.join(dir, 'engine.key'), 0o644);
    const { client: started, status } = make();
    started.start();
    await waitFor(() => status.get().lastError?.code === 'secret_permissions', 'the refusal');
    expect(cloud.hellos).toHaveLength(0);
    expect(status.get().lastError?.message).not.toContain(KEY);
  });

  it('refuses a link headers file that carries an authorization header', async () => {
    cloud = await startFakeCloud();
    writeFileSync(path.join(dir, 'headers.json'), JSON.stringify({ Authorization: 'Bearer x' }), {
      mode: 0o600,
    });
    chmodSync(path.join(dir, 'headers.json'), 0o600);
    const { client: started, status } = make({
      config: config({ linkHeadersFile: path.join(dir, 'headers.json') }),
    });
    started.start();
    await waitFor(() => status.get().lastError?.code === 'link_headers_invalid', 'the refusal');
    expect(cloud.hellos).toHaveLength(0);
  });
});

describe('engine link handshake recovery', () => {
  let dir: string;
  let client: EngineClient;

  const manualSocket = () => {
    const events = new EventTarget();
    const socket = {
      readyState: 0,
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: events.addEventListener.bind(events) as LinkSocket['addEventListener'],
    } satisfies LinkSocket;
    return {
      socket,
      error: () => events.dispatchEvent(new Event('error')),
      close: (code = 1006) => events.dispatchEvent(Object.assign(new Event('close'), { code })),
      open() {
        socket.readyState = 1;
        events.dispatchEvent(new Event('open'));
      },
      message: (frame: object) =>
        events.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) })),
      /** `heartbeat: false` is the welcome of an older cloud, which promises no heartbeat. */
      welcome: (opts: { heartbeat?: boolean } = {}) =>
        events.dispatchEvent(
          Object.assign(new Event('message'), {
            data: JSON.stringify({
              t: 'welcome',
              engineId: 'eng_aaaaaaaaaaaa',
              ackedSeq: 0,
              serverTime: new Date().toISOString(),
              ...(opts.heartbeat === false ? {} : { heartbeat: true }),
            }),
          }),
        ),
    };
  };

  const fakeLogger = () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { log, logger: log as unknown as typeof logger };
  };

  const make = (useLogger: typeof logger = logger) => {
    const buffer = createEngineEventBuffer();
    const sockets: ReturnType<typeof manualSocket>[] = [];
    const createSocket = vi.fn(() => {
      const created = manualSocket();
      sockets.push(created);
      return created.socket;
    });
    const hello = vi.fn(async () => facts());
    const register = vi.fn();
    const status = createEngineStatusWriter(path.join(dir, 'status.json'), {
      pid: 4242,
      bootId: 'b'.repeat(16),
    });
    client = createEngineClient({
      config: {
        schemaVersion: 1,
        cloudUrl: 'http://127.0.0.1:1',
        engineId: 'eng_aaaaaaaaaaaa',
        name: 'mac',
        keyFile: path.join(dir, 'engine.key'),
        projects: [],
        repos: [],
        maxPermissionMode: 'auto',
        allowRemoteTerminalInput: true,
      },
      hello,
      register,
      onRefused: () => undefined,
      buffer,
      status,
      logger: useLogger,
      createSocket,
      random: () => 1 - Number.EPSILON,
    });
    client.start();
    return { sockets, createSocket, hello, register, status, buffer };
  };

  /** A welcomed link on the first socket. */
  const connectFirst = async (useLogger: typeof logger = logger) => {
    const made = make(useLogger);
    made.sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    made.sockets[0]!.welcome();
    return made;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(path.join(os.tmpdir(), 'engine-handshake-'));
    writeFileSync(path.join(dir, 'engine.key'), `${KEY}\n`, { mode: 0o600 });
    chmodSync(path.join(dir, 'engine.key'), 0o600);
  });

  afterEach(async () => {
    await client?.close();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retries when a handshake emits only an error without a close', async () => {
    const { sockets, createSocket, status } = make();
    sockets[0]!.error();
    expect(status.get().connection).toBe('disconnected');
    expect(sockets[0]!.socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ENGINE_BACKOFF_MIN_MS);
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(status.get().attempts).toBe(2);
  });

  it.each(['immediate', 'delayed'])(
    'schedules only one retry when the close after an error is %s',
    async (timing) => {
      const { sockets, createSocket, status } = make();
      sockets[0]!.error();
      if (timing === 'immediate') sockets[0]!.close();
      await vi.advanceTimersByTimeAsync(ENGINE_BACKOFF_MIN_MS);
      expect(createSocket).toHaveBeenCalledTimes(2);
      sockets[1]!.open();
      await vi.advanceTimersByTimeAsync(0);
      sockets[1]!.welcome();
      sockets[0]!.close(4410);
      sockets[0]!.error();
      await vi.advanceTimersByTimeAsync(ENGINE_BACKOFF_MAX_MS);
      expect(createSocket).toHaveBeenCalledTimes(2);
      expect(status.get().connection).toBe('connected');
      expect(client.connected()).toBe(true);
    },
  );

  it('ignores late open and welcome events from a failed attempt', async () => {
    const { sockets, hello, register } = make();
    sockets[0]!.error();
    sockets[0]!.open();
    sockets[0]!.welcome();
    await vi.advanceTimersByTimeAsync(0);
    expect(hello).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(client.connected()).toBe(false);
  });

  it.each([false, true])('retries a handshake without a welcome (opened: %s)', async (opened) => {
    const { sockets, createSocket, status } = make();
    if (opened) sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(ENGINE_HANDSHAKE_TIMEOUT_MS - 1);
    expect(sockets[0]!.socket.close).not.toHaveBeenCalled();
    expect(createSocket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(status.get()).toMatchObject({
      connection: 'disconnected',
      lastError: { code: 'handshake_timeout' },
    });
    expect(sockets[0]!.socket.close).toHaveBeenCalledExactlyOnceWith(4000, 'handshake_timeout');
    await vi.advanceTimersByTimeAsync(ENGINE_BACKOFF_MIN_MS);
    expect(createSocket).toHaveBeenCalledTimes(2);
  });

  it('keeps the timeout diagnostic when closing the socket emits error and close synchronously', async () => {
    const { sockets, createSocket, status } = make();
    sockets[0]!.socket.close.mockImplementation(() => {
      sockets[0]!.error();
      sockets[0]!.close();
    });
    await vi.advanceTimersByTimeAsync(ENGINE_HANDSHAKE_TIMEOUT_MS);
    expect(status.get().lastError?.code).toBe('handshake_timeout');
    await vi.advanceTimersByTimeAsync(ENGINE_BACKOFF_MIN_MS);
    expect(createSocket).toHaveBeenCalledTimes(2);
  });

  it('cancels the handshake timeout after a welcome and waits for close after an established link error', async () => {
    const { sockets, createSocket, status } = make();
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.welcome();
    sockets[0]!.error();
    await vi.advanceTimersByTimeAsync(ENGINE_HANDSHAKE_TIMEOUT_MS + ENGINE_BACKOFF_MAX_MS);
    expect(client.connected()).toBe(true);
    expect(status.get().connection).toBe('connected');
    expect(sockets[0]!.socket.close).not.toHaveBeenCalled();
    expect(createSocket).toHaveBeenCalledTimes(1);
    sockets[0]!.close();
    expect(client.connected()).toBe(false);
    await vi.advanceTimersByTimeAsync(ENGINE_BACKOFF_MIN_MS);
    expect(createSocket).toHaveBeenCalledTimes(2);
  });

  describe('silent link watchdog', () => {
    it('reports link_silent only on the second silent tick in a row, with nothing pending', async () => {
      const { sockets, status } = await connectFirst();
      await vi.advanceTimersByTimeAsync(100_000);
      expect(sockets[0]!.socket.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sockets[0]!.socket.close).toHaveBeenCalledExactlyOnceWith(4000, 'silent');
      expect(status.get().lastError?.code).toBe('link_silent');
    });

    it('leaves an idle link of a cloud that promised no heartbeat alone', async () => {
      const made = make();
      made.sockets[0]!.open();
      await vi.advanceTimersByTimeAsync(0);
      made.sockets[0]!.welcome({ heartbeat: false });
      await vi.advanceTimersByTimeAsync(400_000);
      expect(made.sockets[0]!.socket.close).not.toHaveBeenCalled();
      expect(made.createSocket).toHaveBeenCalledTimes(1);
    });

    it('does not drop the link when frames arrive after one late tick', async () => {
      const { sockets, buffer } = await connectFirst();
      buffer.emit(pendingInput('ses_a'));
      await vi.advanceTimersByTimeAsync(100_000);
      sockets[0]!.message({ t: 'ack', seq: 0 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets[0]!.socket.close).not.toHaveBeenCalled();
    });

    it('counts consecutive ticks only', async () => {
      const { sockets } = await connectFirst();
      // The first silent tick, then the cloud's heartbeat ack arrives: the count starts over.
      await vi.advanceTimersByTimeAsync(100_000);
      sockets[0]!.message({ t: 'ack', seq: 0 });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sockets[0]!.socket.close).not.toHaveBeenCalled();
    });
  });

  describe('info log', () => {
    it('logs the connection and the disconnection with the time away and no secret', async () => {
      const { log, logger: fake } = fakeLogger();
      const { sockets, createSocket } = await connectFirst(fake);
      expect(log.info).toHaveBeenCalledWith({ attempts: 1, downForMs: null }, 'engine link: connected');
      await vi.advanceTimersByTimeAsync(5_000);
      sockets[0]!.close(1006);
      expect(log.info).toHaveBeenCalledWith(
        { code: 1006, connectedForMs: 5_000, pendingEvents: 0 },
        'engine link: disconnected',
      );
      await vi.advanceTimersByTimeAsync(ENGINE_BACKOFF_MIN_MS);
      expect(createSocket).toHaveBeenCalledTimes(2);
      sockets[1]!.open();
      await vi.advanceTimersByTimeAsync(0);
      sockets[1]!.welcome();
      expect(log.info).toHaveBeenLastCalledWith(
        { attempts: 2, downForMs: ENGINE_BACKOFF_MIN_MS },
        'engine link: connected',
      );
      expect(JSON.stringify(log.info.mock.calls)).not.toContain(KEY);
      expect(JSON.stringify(log.info.mock.calls)).not.toContain('127.0.0.1');
    });

    it('logs nothing at info level for a handshake that never got a welcome', async () => {
      const { log, logger: fake } = fakeLogger();
      const { sockets } = make(fake);
      sockets[0]!.error();
      await vi.advanceTimersByTimeAsync(ENGINE_HANDSHAKE_TIMEOUT_MS);
      expect(log.info).not.toHaveBeenCalled();
    });
  });

  it.each([4403, 4410])('stops permanently on close code %s before welcome', async (code) => {
    const { sockets, createSocket, status } = make();
    sockets[0]!.close(code);
    expect(status.get()).toMatchObject({
      connection: 'stopped',
      lastError: { code: code === 4403 ? 'engine_revoked' : 'engine_replaced' },
    });
    await vi.advanceTimersByTimeAsync(ENGINE_HANDSHAKE_TIMEOUT_MS + ENGINE_BACKOFF_MAX_MS);
    expect(createSocket).toHaveBeenCalledTimes(1);
  });

  it.each(['handshake', 'backoff'])(
    'does not retry or overwrite the status after shutdown during %s',
    async (phase) => {
      const { sockets, createSocket, status } = make();
      if (phase === 'backoff') sockets[0]!.error();
      await client.close();
      status.flush();
      const stopped = status.get();
      sockets[0]!.open();
      sockets[0]!.welcome();
      sockets[0]!.error();
      sockets[0]!.close();
      await vi.advanceTimersByTimeAsync(ENGINE_HANDSHAKE_TIMEOUT_MS + ENGINE_BACKOFF_MAX_MS);
      expect(createSocket).toHaveBeenCalledTimes(1);
      expect(status.get()).toEqual(stopped);
      expect(client.connected()).toBe(false);
    },
  );
});

describe('engine link client backoff', () => {
  it('doubles the wait from one second to thirty seconds', async () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'engine-backoff-'));
      writeFileSync(path.join(dir, 'engine.key'), `${KEY}\n`, { mode: 0o600 });
      chmodSync(path.join(dir, 'engine.key'), 0o600);
      const opened: number[] = [];
      const createSocket = (): LinkSocket => {
        opened.push(Date.now());
        const closers: Array<(event: { code: number }) => void> = [];
        const socket: LinkSocket = {
          readyState: 0,
          send: () => undefined,
          close: () => undefined,
          addEventListener(type: string, listener: unknown) {
            if (type === 'close') closers.push(listener as (event: { code: number }) => void);
          },
        } as LinkSocket;
        queueMicrotask(() => closers.forEach((listener) => listener({ code: 1006 })));
        return socket;
      };
      const client = createEngineClient({
        config: {
          schemaVersion: 1,
          cloudUrl: 'http://127.0.0.1:1',
          engineId: 'eng_aaaaaaaaaaaa',
          name: 'mac',
          keyFile: path.join(dir, 'engine.key'),
          projects: [],
          repos: [],
          maxPermissionMode: 'auto',
          allowRemoteTerminalInput: true,
        },
        hello: async () => facts(),
        register: () => undefined,
        onRefused: () => undefined,
        buffer: createEngineEventBuffer(),
        status: createEngineStatusWriter(path.join(dir, 'status.json'), { pid: 1, bootId: 'b'.repeat(16) }),
        logger,
        createSocket,
        random: () => 1 - Number.EPSILON,
      });
      client.start();
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(ENGINE_BACKOFF_MAX_MS);
      const gaps = opened.slice(1).map((time, index) => time - opened[index]!);
      expect(gaps[0]).toBeGreaterThanOrEqual(ENGINE_BACKOFF_MIN_MS * 0.99);
      expect(gaps[0]).toBeLessThanOrEqual(ENGINE_BACKOFF_MIN_MS);
      expect(gaps[1]).toBeGreaterThan(gaps[0]!);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(ENGINE_BACKOFF_MAX_MS);
      expect(gaps.at(-1)).toBe(ENGINE_BACKOFF_MAX_MS);
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
