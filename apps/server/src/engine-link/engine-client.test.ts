import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeCloud } from '../../test/helpers/fake-cloud';
import type { FakeCloud } from '../../test/helpers/fake-cloud';
import { createEngineClient, ENGINE_BACKOFF_MAX_MS, ENGINE_BACKOFF_MIN_MS } from './engine-client';
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

async function waitFor(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
