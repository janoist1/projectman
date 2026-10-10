import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type {
  FullTestSpec,
  PermissionBroker,
  RunnerEvent,
  RunningSessionInfo,
  ScreenshotRunEnded,
  ScreenshotRunSpec,
  StartSessionSpec,
} from '../../contracts';
import { MergeError } from '../../contracts';
import type { EngineEvent } from '../protocol';
import { createCloudRemote } from './index';
import type { CloudDomain, CloudRemote } from './index';
import { createFakeCloud, helloOf, silentLogger } from './test-support';
import type { FakeCloud, FakeEngine } from './test-support';

const spec = (over: Partial<StartSessionSpec> = {}): StartSessionSpec => ({
  sessionId: 's1',
  claudeSessionId: 'c1',
  resume: false,
  cwd: '/fictional/work',
  displayName: 'Tester',
  appendSystemPrompt: 'be brief',
  mcpUrl: 'http://127.0.0.1:4700/mcp/tok-abc',
  allowedTools: [],
  ...over,
});
const running = (sessionId: string, pid = 100): RunningSessionInfo => ({
  sessionId,
  pid,
  state: 'idle',
  cols: 80,
  rows: 24,
});
const screenshotSpec = (runId: string): ScreenshotRunSpec => ({
  runId,
  cwd: '/fictional/work',
  sessionDir: '/fictional/folders/s1',
  args: [],
  sandbox: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
  label: 'shots',
  timeoutMs: 1000,
});
const fullTestSpec = (runId: string): FullTestSpec => ({
  runId,
  cwd: '/fictional/work',
  command: 'npm test',
  maxWorkers: 1,
  timeoutMs: 1000,
  sandbox: { denyRead: [], allowRead: [] },
});
const permissionRequest = (sessionId: string) => ({
  sessionId,
  toolName: 'Bash',
  toolInput: {},
  raw: {},
});

describe('cloud mode remote parts', () => {
  let cloud: FakeCloud;
  let remote: CloudRemote;
  let spool: string;
  let sessionEngines: Map<string, string>;
  let domain: CloudDomain & { reconciled: Array<{ engine: string; reported: string[] }> };
  let app: FastifyInstance;
  let broker: PermissionBroker;
  let nanogptKey: string | null;
  let skewMs = 0;

  beforeEach(() => {
    spool = mkdtempSync(path.join(tmpdir(), 'pm-remote-'));
    skewMs = 0;
    cloud = createFakeCloud();
    sessionEngines = new Map();
    remote = createCloudRemote({
      links: cloud.links,
      registry: cloud.registry,
      recordedEngine: (sessionId) => (sessionEngines.get(sessionId) as never) ?? null,
      spoolDir: path.join(spool, 'engine-spool'),
      logger: silentLogger(),
      now: () => Date.now() + skewMs,
    });
    domain = {
      reconciled: [],
      sessions: {
        resolveToken: (token) =>
          token === 'tok-abc' ? { sessionId: 's1', projectKey: 'AR', member: 'dev', taskKey: null } : null,
        engineOf: (sessionId) => (sessionEngines.get(sessionId) ?? 'eng_other') as never,
        async reconcileEngine(engine, reported) {
          domain.reconciled.push({ engine, reported: [...reported] });
        },
      },
    };
    app = Fastify();
    app.post('/mcp/:token', async (request, reply) => {
      reply.type('application/json');
      return JSON.stringify({ via: 'inject', token: (request.params as { token: string }).token });
    });
    remote.bind(domain, app);
    nanogptKey = 'key-from-store';
    broker = {
      decide: vi.fn(
        (_request, signal: AbortSignal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'cut' }), {
              once: true,
            });
          }),
      ),
    } as unknown as PermissionBroker;
    remote.createRunnerModule(broker, async () => nanogptKey);
  });
  afterEach(async () => {
    remote.close();
    await app.close();
    rmSync(spool, { recursive: true, force: true });
  });

  const online = async (
    id = 'eng_a',
    hello: Parameters<typeof helloOf>[0] = {},
    prepare?: (engine: FakeEngine) => void,
  ): Promise<FakeEngine> => {
    const engine = cloud.connect(id as never, { hello, ...(prepare ? { prepare } : {}) });
    // The connect hooks run before the engine counts as connected.
    await vi.waitFor(() => expect(remote.hub.mirror(id as never).connected).toBe(true));
    await vi.waitFor(() => expect(domain.reconciled.some((entry) => entry.engine === id)).toBe(true));
    cloud.registry.setOnline(id as never, true);
    return engine;
  };

  describe('runner', () => {
    it('starts on the default engine with the token, not the address, and mirrors the session', async () => {
      const engine = await online();
      engine.answer('session.start', (params) => running(params.sessionId));
      const info = await remote.runner.start(spec());
      expect(info).toMatchObject({ sessionId: 's1' });
      const sent = engine.requests[0]!.params as Record<string, unknown>;
      expect(sent.mcpToken).toBe('tok-abc');
      expect(sent).not.toHaveProperty('mcpUrl');
      expect(remote.runner.isRunning('s1')).toBe(true);
      expect(remote.runner.engineOf('s1')).toBe('eng_a');
      expect(remote.runner.list().map((item) => item.sessionId)).toEqual(['s1']);
      expect(remote.runner.snapshot('s1')).toBeNull();
      expect(remote.directory.get('eng_a' as never)?.processExists(100)).toBe(true);
      expect(remote.directory.get('eng_a' as never)?.processExists(101)).toBe(false);
    });

    it('refuses a start while no engine is connected', async () => {
      await expect(remote.runner.start(spec())).rejects.toMatchObject({ code: 'engine_offline' });
      cloud.registry.add('eng_a' as never);
      await expect(remote.runner.start(spec())).rejects.toMatchObject({ code: 'engine_offline' });
    });

    it('turns runner events and terminal frames into events, and drops those of a foreign session', async () => {
      const a = await online('eng_a');
      const b = await online('eng_b');
      a.answer('session.start', (params) => running(params.sessionId));
      await remote.runner.start(spec());
      const seen: RunnerEvent[] = [];
      remote.runner.onEvent((event) => seen.push(event));
      const state = (value: 'working' | 'exited'): EngineEvent => ({
        kind: 'runner',
        event: { type: 'state', sessionId: 's1', state: value, activity: null },
      });
      await a.emit(state('working'));
      await b.emit(state('exited'));
      await a.terminal('s1', 'hello');
      await b.terminal('s1', 'forged');
      expect(seen).toEqual([
        { type: 'state', sessionId: 's1', state: 'working', activity: null },
        { type: 'terminal_data', sessionId: 's1', data: 'hello' },
      ]);
      expect(remote.hub.mirror('eng_a' as never).running.get('s1')?.state).toBe('working');
    });

    it('applies a repeated event twice without harm and ends the session on exit', async () => {
      const engine = await online();
      engine.answer('session.start', (params) => running(params.sessionId));
      await remote.runner.start(spec());
      const ended: string[] = [];
      remote.runner.onSessionEnded((id) => ended.push(id));
      const exit: EngineEvent = {
        kind: 'runner',
        event: { type: 'exit', sessionId: 's1', exitCode: 0, signal: null },
      };
      await engine.emit(exit);
      await engine.emit(exit);
      expect(remote.runner.isRunning('s1')).toBe(false);
      expect(ended).toEqual(['s1']);
    });

    it('does not send a terminal input to a session that is not running', async () => {
      const engine = await online();
      remote.runner.writeTerminal('nope', 'x');
      expect(engine.requests).toEqual([]);
    });

    it('treats a session the reconnected engine no longer reports as ended', async () => {
      const engine = await online();
      engine.answer('session.start', (params) => running(params.sessionId));
      await remote.runner.start(spec());
      const ended: string[] = [];
      remote.runner.onSessionEnded((id) => ended.push(id));
      engine.disconnect();
      await online('eng_a', { running: [] });
      expect(ended).toEqual(['s1']);
      expect(remote.runner.isRunning('s1')).toBe(false);
    });

    it('keeps a session the engine still reports across a reconnect', async () => {
      const engine = await online();
      engine.answer('session.start', (params) => running(params.sessionId));
      await remote.runner.start(spec());
      engine.disconnect();
      await online('eng_a', { running: [running('s1')] });
      expect(remote.runner.isRunning('s1')).toBe(true);
      expect(domain.reconciled.at(-1)).toEqual({ engine: 'eng_a', reported: ['s1'] });
    });

    it('does not let an engine take over a session of another engine by reporting it in its hello', async () => {
      const a = await online('eng_a');
      a.answer('session.start', (params) => running(params.sessionId));
      await remote.runner.start(spec());
      // After a cloud restart the database is all the cloud knows of who runs what.
      sessionEngines.set('s2', 'eng_a');
      const b = await online('eng_b', { running: [running('s1'), running('s2')] }, (engine) =>
        engine.answer('session.stop', () => null),
      );
      // It is stopped on the engine that reported it, and is not in that engine's mirror.
      await vi.waitFor(() =>
        expect(b.requests.filter((item) => item.method === 'session.stop')).toHaveLength(2),
      );
      expect(a.requests.some((item) => item.method === 'session.stop')).toBe(false);
      expect(remote.hub.mirror('eng_b').running.size).toBe(0);
      expect(remote.runner.engineOf('s1')).toBe('eng_a');
      expect(remote.runner.engineOf('s2')).toBe('eng_a');
      expect(remote.runner.list().map((item) => item.sessionId)).toEqual(['s1']);
      const seen: RunnerEvent[] = [];
      remote.runner.onEvent((event) => seen.push(event));
      await b.emit({
        kind: 'runner',
        event: { type: 'exit', sessionId: 's1', exitCode: 0, signal: null },
      });
      await a.emit({
        kind: 'runner',
        event: { type: 'state', sessionId: 's1', state: 'working', activity: null },
      });
      expect(seen).toEqual([{ type: 'state', sessionId: 's1', state: 'working', activity: null }]);
      expect(remote.runner.isRunning('s1')).toBe(true);
      a.answer('terminal.input', () => null);
      b.answer('terminal.input', () => null);
      remote.runner.writeTerminal('s1', 'x');
      await vi.waitFor(() => expect(a.requests.some((item) => item.method === 'terminal.input')).toBe(true));
      expect(b.requests.some((item) => item.method === 'terminal.input')).toBe(false);
    });

    it('does not end a session whose start is still being answered when its engine reconnects', async () => {
      const engine = await online();
      let answer: (value: RunningSessionInfo) => void = () => {};
      engine.answer(
        'session.start',
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      const starting = remote.runner.start(spec());
      await vi.waitFor(() => expect(engine.requests).toHaveLength(1));
      expect(remote.runner.isStarting('s1')).toBe(true);
      answer(running('s1'));
      await starting;
      expect(remote.runner.isStarting('s1')).toBe(false);
    });
  });

  describe('NanoGPT key', () => {
    it('is given only to the session that is starting on the requesting engine, once', async () => {
      const engine = await online();
      const other = await online('eng_b');
      let first: unknown;
      let second: unknown;
      let foreign: unknown;
      let unrelated: unknown;
      engine.answer('session.start', async (params) => {
        first = await engine.call('secret.nanogpt_key', { sessionId: params.sessionId });
        second = await engine.call('secret.nanogpt_key', { sessionId: params.sessionId }).catch((e) => e);
        foreign = await other.call('secret.nanogpt_key', { sessionId: params.sessionId }).catch((e) => e);
        unrelated = await engine.call('secret.nanogpt_key', { sessionId: 'someone-else' }).catch((e) => e);
        return running(params.sessionId);
      });
      await remote.runner.start(spec({ provider: 'nanogpt' }));
      expect(first).toEqual({ key: 'key-from-store' });
      for (const refused of [second, foreign, unrelated])
        expect(refused).toMatchObject({ linkCode: 'secret_not_allowed' });
      // After the start call returned nothing is given any more.
      await expect(engine.call('secret.nanogpt_key', { sessionId: 's1' })).rejects.toMatchObject({
        linkCode: 'secret_not_allowed',
      });
    });

    it('is not given to a start of another provider, or when there is no key', async () => {
      const engine = await online();
      let claude: unknown;
      engine.answer('session.start', async (params) => {
        claude = await engine.call('secret.nanogpt_key', { sessionId: params.sessionId }).catch((e) => e);
        return running(params.sessionId);
      });
      await remote.runner.start(spec({ provider: 'claude' }));
      expect(claude).toMatchObject({ linkCode: 'secret_not_allowed' });

      nanogptKey = null;
      let none: unknown;
      engine.answer('session.start', async (params) => {
        none = await engine.call('secret.nanogpt_key', { sessionId: params.sessionId }).catch((e) => e);
        return running(params.sessionId);
      });
      await remote.runner.start(spec({ sessionId: 's2', provider: 'nanogpt', mcpUrl: 'http://x/mcp/t2' }));
      expect(none).toMatchObject({ linkCode: 'secret_not_allowed' });
    });
  });

  describe('team tools relay', () => {
    const relay = (engine: FakeEngine, token: string) =>
      engine.call('mcp.relay', {
        token,
        contentType: 'application/json',
        accept: 'application/json, text/event-stream',
        body: '{"jsonrpc":"2.0"}',
      });

    it('runs the request of the engine the session runs on through the MCP route', async () => {
      const engine = await online();
      sessionEngines.set('s1', 'eng_a');
      const answer = await relay(engine, 'tok-abc');
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toEqual({ via: 'inject', token: 'tok-abc' });
    });

    it('answers 404 for a token of a session on another engine, an unknown token, and the same body', async () => {
      const a = await online('eng_a');
      const b = await online('eng_b');
      sessionEngines.set('s1', 'eng_a');
      const foreign = await relay(b, 'tok-abc');
      const unknown = await relay(a, 'tok-zzz');
      expect(foreign.status).toBe(404);
      expect(unknown).toEqual(foreign);
    });
  });

  describe('permission', () => {
    it('decides for the engine’s own session and cuts the decision on permission.cancel', async () => {
      const engine = await online();
      sessionEngines.set('s1', 'eng_a');
      const deciding = engine.call('permission.decide', { request: permissionRequest('s1') } as never);
      await vi.waitFor(() => expect(broker.decide).toHaveBeenCalledTimes(1));
      // The engine names the request by the id its own call frame carried.
      expect(engine.callIds).toHaveLength(1);
      await engine.call('permission.cancel', { reqId: engine.callIds[0]! });
      await expect(deciding).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('refuses to decide for a session of another engine', async () => {
      const engine = await online();
      sessionEngines.set('s1', 'eng_other');
      await expect(
        engine.call('permission.decide', { request: permissionRequest('s1') } as never),
      ).rejects.toMatchObject({ linkCode: 'not_running' });
      expect(broker.decide).not.toHaveBeenCalled();
    });
  });

  describe('file transfers', () => {
    let file: string;
    let content: string;
    beforeEach(() => {
      content = 'attachment body';
      file = path.join(spool, 'stored.txt');
      writeFileSync(file, content);
      remote.transfers.register(app);
    });
    const sha = () => createHash('sha256').update(content).digest('hex');
    const download = (token: string, engine = 'eng_a') =>
      app.inject({ method: 'GET', url: routes.engineDownload(token), headers: { 'x-engine': engine } });

    it('gives a download to its engine once', async () => {
      const token = remote.transfers.issueDownload('eng_a' as never, {
        path: file,
        size: content.length,
        sha256: sha(),
      });
      const first = await download(token);
      expect(first.statusCode).toBe(200);
      expect(first.body).toBe(content);
      expect((await download(token)).statusCode).toBe(404);
    });

    it('answers 404 for another engine’s token, an unknown token and a request without a key', async () => {
      const token = remote.transfers.issueDownload('eng_a' as never, {
        path: file,
        size: content.length,
        sha256: sha(),
      });
      expect((await download(token, 'eng_b')).statusCode).toBe(404);
      expect((await download('x'.repeat(43))).statusCode).toBe(404);
      const anonymous = await app.inject({ method: 'GET', url: routes.engineDownload(token) });
      expect(anonymous.statusCode).toBe(401);
      // The refused attempts did not use the token up.
      expect((await download(token)).statusCode).toBe(200);
    });

    it('does not give a download after five minutes', async () => {
      const token = remote.transfers.issueDownload('eng_a' as never, {
        path: file,
        size: content.length,
        sha256: sha(),
      });
      skewMs = 5 * 60_000 + 1;
      expect((await download(token)).statusCode).toBe(404);
    });

    it('refuses a file that changed since it was announced', async () => {
      const token = remote.transfers.issueDownload('eng_a' as never, { path: file, size: 3, sha256: sha() });
      expect((await download(token)).statusCode).toBe(404);
    });

    it('stores an upload, checks it against the engine’s receipt and refuses a second one', async () => {
      const ticket = remote.transfers.issueUpload('eng_a' as never, 'file');
      const send = (engine = 'eng_a') =>
        app.inject({
          method: 'POST',
          url: routes.engineUpload(ticket.token),
          headers: { 'x-engine': engine, 'content-type': 'application/octet-stream' },
          payload: content,
        });
      expect((await send('eng_b')).statusCode).toBe(404);
      expect((await send()).statusCode).toBe(204);
      expect((await send()).statusCode).toBe(404);
      const stored = ticket.take({ sha256: sha(), size: content.length } as never);
      expect(stored.size).toBe(content.length);
      expect(() => ticket.take({ sha256: 'f'.repeat(64), size: content.length } as never)).toThrow();
      ticket.dispose();
    });
  });

  describe('engine host', () => {
    it('answers the synchronous questions from the engine’s hello and says nothing before it', async () => {
      expect(remote.directory.get('eng_a' as never)).toBeNull();
      await online('eng_a', {
        projects: [{ project: 'AR', workspacePath: '/fictional/ar', repos: [] }] as never,
      });
      const host = remote.directory.get('eng_a' as never)!;
      expect(host.workspacePath('AR')).toBe('/fictional/ar');
      expect(host.workspacePath('XX')).toBeNull();
      expect(host.paths().sessionFoldersRoot).toBe('/fictional/folders');
      expect(host.platform).toBe('darwin');
      expect(remote.directory.engineFor('AR', 'dev' as never)).toBe('eng_a');
    });

    it('mirrors the session folders the cloud makes and removes', async () => {
      const engine = await online();
      engine.answer('folders.make', () => null);
      engine.answer('folders.remove', () => null);
      const folders = remote.directory.get('eng_a' as never)!.sessionFolders!;
      const dir = folders.allocate('s1');
      expect(dir.startsWith('/fictional/folders/s1.')).toBe(true);
      await folders.make('s1', dir);
      expect(folders.of('s1')).toBe(dir);
      await folders.remove('s1');
      expect(folders.of('s1')).toBeUndefined();
    });

    it('keeps the folders of the sessions the engine runs when it sweeps', async () => {
      const engine = await online('eng_a', { running: [running('live')] });
      engine.answer('folders.make', () => null);
      engine.answer('folders.sweep', () => ['gone']);
      const folders = remote.directory.get('eng_a' as never)!.sessionFolders!;
      await folders.make('gone', folders.allocate('gone'));
      const removed = await folders.sweep((id) => id === 'live');
      expect(engine.requests.at(-1)!.params).toEqual({ keepSessionIds: ['live'] });
      expect(removed).toEqual(['gone']);
      expect(folders.of('gone')).toBeUndefined();
    });

    it('reports a screenshot run started by the engine and cancels it with the signal', async () => {
      const engine = await online();
      let finish: (value: ScreenshotRunEnded) => void = () => {};
      engine.answer(
        'screenshots.run',
        () =>
          new Promise<ScreenshotRunEnded>((resolve) => {
            finish = resolve;
          }),
      );
      engine.answer('screenshots.cancel', () => null);
      const controller = new AbortController();
      const onStarted = vi.fn();
      const executor = remote.directory.get('eng_a' as never)!.screenshotExecutor!;
      const run = executor.run(screenshotSpec('r1'), controller.signal, onStarted);
      await vi.waitFor(() =>
        expect(engine.requests.some((item) => item.method === 'screenshots.run')).toBe(true),
      );
      await engine.emit({ kind: 'screenshot_started', runId: 'r1' } as never);
      expect(onStarted).toHaveBeenCalledTimes(1);
      controller.abort();
      await vi.waitFor(() =>
        expect(engine.requests.some((item) => item.method === 'screenshots.cancel')).toBe(true),
      );
      finish({ exitCode: null, timedOut: false, aborted: true, output: '' });
      await expect(run).resolves.toMatchObject({ aborted: true });
    });

    it('sends the merge calls with the repository named and not a path, and keeps the error codes', async () => {
      const engine = await online();
      const ref = { projectKey: 'AR', repo: 'ar' };
      const sha = 'a'.repeat(40);
      const state = {
        local: sha,
        remote: null,
        relation: 'same' as const,
        contains: { local: false, remote: null },
        checkout: null,
      };
      engine.answer('merge.prepare', () => state);
      engine.answer('merge.release_check', () => null);
      engine.answer('merge.push', () => ({ ok: false, reason: 'non_fast_forward', message: 'fetch first' }));
      engine.answer('merge.build', () => {
        throw Object.assign(new Error('no identity'), { code: 'no_identity' });
      });
      engine.answer('merge.advance', () => {
        throw Object.assign(new Error('not allowed'), { code: 'merge_not_allowed' });
      });
      const merger = remote.directory.get('eng_a' as never)!.merger!;
      expect(await merger.prepare(ref, { base: 'main', commit: sha })).toEqual(state);
      expect(engine.requests.at(-1)).toEqual({
        method: 'merge.prepare',
        params: { ref, base: 'main', commit: sha },
      });
      await expect(merger.releaseCheck(ref, { mergeId: 'mrg_abcdefgh1' })).resolves.toBeUndefined();
      expect(await merger.push(ref, { base: 'main', mergeCommit: sha })).toEqual({
        ok: false,
        reason: 'non_fast_forward',
        message: 'fetch first',
      });
      // The engine's MergeError comes out as a MergeError, like a local merger's.
      const built = await merger.build(ref, { onto: sha, commit: sha, message: 'Merge' }).catch((e) => e);
      expect(built).toBeInstanceOf(MergeError);
      expect(built).toMatchObject({ code: 'no_identity', message: 'no identity' });
      // A refusal of the link stays a call error with its link code.
      const refused = await merger.advance(ref, { base: 'main', from: sha, to: sha }).catch((e) => e);
      expect(refused).not.toBeInstanceOf(MergeError);
      expect(refused).toMatchObject({ code: 'merge_not_allowed' });
    });

    it('ends a screenshot run with engine_offline when the link drops, and a full test too', async () => {
      const engine = await online();
      engine.answer('screenshots.run', () => new Promise(() => {}));
      engine.answer('full_test.run', () => new Promise(() => {}));
      const host = remote.directory.get('eng_a' as never)!;
      const shot = host.screenshotExecutor!.run(screenshotSpec('r2'), new AbortController().signal, () => {});
      const test = host.fullTestExecutor!.run(fullTestSpec('r3'), new AbortController().signal);
      await vi.waitFor(() => expect(engine.requests).toHaveLength(2));
      engine.disconnect();
      await expect(shot).resolves.toMatchObject({ spawnError: 'engine_offline' });
      await expect(test).resolves.toMatchObject({ outcome: 'error', reason: 'engine_offline' });
    });
  });

  describe('transcripts and plan usage', () => {
    it('reads a summary as null while the engine is not available', async () => {
      const reader = remote.createRunnerModule(broker, undefined).transcripts;
      await expect(reader.summary('/x.jsonl', {} as never)).resolves.toBeNull();
      await expect(reader.hasContent('/x.jsonl', {} as never)).resolves.toBe(false);
    });

    it('asks the plan usage at most once a minute', async () => {
      const engine = await online();
      engine.answer('usage.plan', () => null);
      const { planUsage } = remote.createRunnerModule(broker, undefined);
      await planUsage.get();
      await planUsage.get();
      expect(engine.requests.filter((item) => item.method === 'usage.plan')).toHaveLength(1);
    });
  });

  describe('machine display', () => {
    it('shows the default engine’s process and refuses a signal without an engine', async () => {
      expect(remote.machineProbe.available()).toBe(false);
      await expect(remote.machineProbe.signal(1, 'SIGTERM')).rejects.toMatchObject({
        code: 'engine_offline',
      });
      await online('eng_a', { pid: 777, uid: 12, instanceTag: 'abcdef0123456789' });
      expect(remote.machineProbe.available()).toBe(true);
      expect(remote.machineProbe.identity()).toEqual({ pid: 777, uid: 12, instanceTag: 'abcdef0123456789' });
    });

    it('signals through the engine, whose answer is awaited', async () => {
      const engine = await online();
      engine.answer('machine.signal', () => 'sent');
      await expect(remote.machineProbe.signal(5, 'SIGTERM')).resolves.toBe('sent');
    });
  });

  describe('connection', () => {
    it('waits for the link of an engine that counts as available and then fails with link_down', async () => {
      vi.useFakeTimers();
      try {
        const engine = await online();
        engine.answer('session.start', (params) => running(params.sessionId));
        engine.disconnect();
        const waiting = remote.hub.call('eng_a' as never, 'host.free_disk', {});
        const outcome = expect(waiting).rejects.toMatchObject({ linkCode: 'link_down' });
        await vi.advanceTimersByTimeAsync(61_000);
        await outcome;
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops waiting for an engine at once when it no longer counts as available (revoked)', async () => {
      const engine = await online();
      engine.disconnect();
      const waiting = remote.hub.call('eng_a' as never, 'host.free_disk', {});
      const outcome = expect(waiting).rejects.toMatchObject({ linkCode: 'link_down' });
      cloud.registry.setOnline('eng_a' as never, false);
      await outcome;
    });

    it('goes on with a call once the engine is back, and tells the domain only after the reconciliation', async () => {
      const first = await online();
      first.disconnect();
      const waiting = remote.hub.call('eng_a' as never, 'host.free_disk', {});
      const second = cloud.connect('eng_a' as never, { hello: {} });
      second.answer('host.free_disk', () => 321);
      await expect(waiting).resolves.toBe(321);
      const changes: boolean[] = [];
      remote.hub.onChange((id, value) => id === 'eng_a' && changes.push(value));
      second.disconnect();
      cloud.connect('eng_a' as never, { hello: {} });
      await vi.waitFor(() => expect(changes).toEqual([true]));
      expect(domain.reconciled.length).toBeGreaterThanOrEqual(2);
    });
  });
});
