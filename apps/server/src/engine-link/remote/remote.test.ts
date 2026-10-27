import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type {
  FullTestResult,
  FullTestSpec,
  PermissionBroker,
  RunnerEvent,
  RunningSessionInfo,
  ScreenshotRunEnded,
  ScreenshotRunSpec,
  StartSessionSpec,
} from '../../contracts';
import { MergeError } from '../../contracts';
import { ScreenshotRuns } from '../../services/full-tests';
import { outputTail } from '../../full-test';
import { testConfig } from '../../../test/helpers/test-template';
import type { EngineEvent } from '../protocol';
import { EngineCallError } from '../rpc';
import { createCloudRemote } from './index';
import { createRemoteGithub } from './github';
import { createRemoteRunner } from './runner';
import type { CloudDomain, CloudRemote } from './index';
import { createFakeCloud, helloOf, silentLogger } from './test-support';
import type { FakeCloud, FakeEngine } from './test-support';

const spec = (over: Partial<StartSessionSpec> = {}): StartSessionSpec => ({
  sessionId: 's1',
  projectKey: 'AR',
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
      recordedProject: () => 'AR',
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

  describe('waiting for a ready engine link', () => {
    it('waits for connect hooks and survives the registry offline transition', async () => {
      const first = await online();
      await expect(remote.hub.awaitLink(first.id, 0)).resolves.toBe('connected');
      first.disconnect();
      await expect(remote.hub.awaitLink(first.id, 0)).resolves.toBe('timeout');
      let release!: () => void;
      domain.sessions.reconcileEngine = async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const wait = remote.directory.awaitConnected!(first.id, 900_000);
      cloud.registry.setOnline(first.id, false);
      let done = false;
      void wait.then(() => {
        done = true;
      });
      cloud.connect(first.id);
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(done).toBe(false);
      await expect(remote.hub.awaitLink(first.id, 0)).resolves.toBe('timeout');
      release();
      await expect(wait).resolves.toBe('connected');
    });

    it('times out or aborts by signal and close, while stopWaiting leaves it to the caller', async () => {
      cloud.registry.add('eng_a' as never);
      vi.useFakeTimers();
      try {
        const wait = remote.hub.awaitLink('eng_a' as never, 900_000);
        await vi.advanceTimersByTimeAsync(900_000);
        await expect(wait).resolves.toBe('timeout');
        const controller = new AbortController();
        const aborted = remote.hub.awaitLink('eng_a' as never, 900_000, controller.signal);
        controller.abort();
        await expect(aborted).resolves.toBe('aborted');
        await expect(remote.hub.awaitLink('eng_a' as never, 900_000, controller.signal)).resolves.toBe(
          'aborted',
        );
        const stopping = remote.hub.awaitLink('eng_a' as never, 900_000);
        remote.hub.stopWaiting();
        let ended = false;
        void stopping.then(() => {
          ended = true;
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(ended).toBe(false);
        const afterStop = remote.hub.awaitLink('eng_a' as never, 900_000);
        remote.hub.close();
        await expect(stopping).resolves.toBe('aborted');
        await expect(afterStop).resolves.toBe('aborted');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('following a full test after a lost link', () => {
    const passed: FullTestResult = {
      outcome: 'passed',
      exitCode: 0,
      durationMs: 1,
      failedFiles: [],
      outputTail: '',
    };
    async function lostRun() {
      const engine = await online();
      engine.answer('full_test.run', () => new Promise(() => {}));
      const controller = new AbortController();
      const onStarted = vi.fn();
      const onLinkWait = vi.fn();
      const run = remote.directory
        .get(engine.id)!
        .fullTestExecutor!.run(fullTestSpec('f1'), controller.signal, onStarted, {
          linkWaitMs: 900_000,
          onLinkWait,
        });
      await vi.waitFor(() => expect(engine.requests.some((r) => r.method === 'full_test.run')).toBe(true));
      engine.disconnect();
      await vi.waitFor(() => expect(onLinkWait).toHaveBeenCalledWith(true));
      return { engine, controller, onStarted, onLinkWait, run };
    }

    it.each(['internal', 'module_error'] as const)(
      'ends a refused initial run as spawn_failed without waiting for a link (%s)',
      async (code) => {
        const engine = await online();
        engine.answer('full_test.run', () => {
          throw new EngineCallError({
            code,
            message: 'fixture failure',
            ...(code === 'module_error' ? { module: { code: 'fixture_failure' } } : {}),
          });
        });
        const onLinkWait = vi.fn();
        const result = await remote.directory
          .get(engine.id)!
          .fullTestExecutor!.run(fullTestSpec('f1'), new AbortController().signal, undefined, {
            linkWaitMs: 900_000,
            onLinkWait,
          });
        expect(result).toMatchObject({ outcome: 'error', reason: 'spawn_failed' });
        expect(result.outputTail).toContain(code);
        // The engine's reason reaches the hub, not only the code (PM-915).
        expect(result.outputTail).toContain('fixture failure');
        expect(onLinkWait).not.toHaveBeenCalled();
        expect(engine.requests.map((request) => request.method)).toEqual(['full_test.run']);
      },
    );

    it.each(['internal', 'module_error'] as const)(
      'does not classify a refused attach as another link loss (%s)',
      async (code) => {
        const { run, onLinkWait } = await lostRun();
        const engine = await online('eng_a', {}, (engine) =>
          engine.answer('full_test.attach', () => {
            throw new EngineCallError({
              code,
              message: 'fixture failure',
              ...(code === 'module_error' ? { module: { code: 'fixture_failure' } } : {}),
            });
          }),
        );
        await expect(run).resolves.toMatchObject({ outcome: 'error', reason: 'spawn_failed' });
        expect(onLinkWait.mock.calls).toEqual([[true], [false]]);
        expect(engine.requests.map((request) => request.method)).toEqual(['full_test.attach']);
      },
    );

    it('attaches and retains the start callback until the original result arrives', async () => {
      const lost = await lostRun();
      const calls = vi.spyOn(remote.hub, 'call');
      skewMs = 60_000;
      let finish!: (value: { state: 'ended'; result: FullTestResult }) => void;
      const engine = await online('eng_a', {}, (engine) =>
        engine.answer(
          'full_test.attach',
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
      );
      await vi.waitFor(() => expect(finish).toBeDefined());
      expect(calls).toHaveBeenCalledWith('eng_a', 'full_test.attach', { runId: 'f1' }, { timeoutMs: 60_000 });
      expect(lost.onLinkWait.mock.calls).toEqual([[true], [false]]);
      await engine.emit({ kind: 'full_test_started', runId: 'f1' });
      expect(lost.onStarted).toHaveBeenCalledTimes(1);
      finish({ state: 'ended', result: passed });
      await expect(lost.run).resolves.toEqual(passed);
      await engine.emit({ kind: 'full_test_started', runId: 'f1' });
      expect(lost.onStarted).toHaveBeenCalledTimes(1);
      expect(engine.requests).toEqual([{ method: 'full_test.attach', params: { runId: 'f1' } }]);
    });

    it('ends after fifteen minutes without a reconnect', async () => {
      vi.useFakeTimers();
      try {
        const { run } = await lostRun();
        await vi.advanceTimersByTimeAsync(900_000);
        await expect(run).resolves.toMatchObject({
          reason: 'engine_offline',
          outputTail: 'engine eng_a did not reconnect within 15 minutes',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('aborts a disconnected run without sending cancel', async () => {
      const { run, controller, engine } = await lostRun();
      controller.abort();
      await expect(run).resolves.toMatchObject({ reason: 'killed' });
      expect(engine.requests.some((r) => r.method === 'full_test.cancel')).toBe(false);
    });

    it('reports a run forgotten by a restarted engine', async () => {
      const { run } = await lostRun();
      await online('eng_a', {}, (engine) => engine.answer('full_test.attach', () => ({ state: 'unknown' })));
      await expect(run).resolves.toMatchObject({
        reason: 'engine_offline',
        outputTail: 'the engine no longer knows the run',
      });
    });

    it('waits for cancellation on an engine that does not support attach', async () => {
      const { run } = await lostRun();
      let finish!: () => void;
      const engine = await online('eng_a', {}, (engine) =>
        engine.answer(
          'full_test.cancel',
          () =>
            new Promise<null>((resolve) => {
              finish = () => resolve(null);
            }),
        ),
      );
      await vi.waitFor(() => expect(finish).toBeDefined());
      let done = false;
      void run.then(() => {
        done = true;
      });
      expect(done).toBe(false);
      finish();
      await expect(run).resolves.toMatchObject({
        reason: 'engine_offline',
        outputTail: 'the engine cannot hand over a run after a reconnect; update it',
      });
      expect(engine.requests).toEqual([{ method: 'full_test.cancel', params: { runId: 'f1' } }]);
    });

    it('follows repeated link losses but gives up after five reconnects', async () => {
      const { run, onLinkWait } = await lostRun();
      for (let loss = 0; loss < 5; loss++) {
        const engine = await online('eng_a', {}, (engine) =>
          engine.answer('full_test.attach', () => new Promise(() => {})),
        );
        await vi.waitFor(() =>
          expect(engine.requests.some((r) => r.method === 'full_test.attach')).toBe(true),
        );
        engine.disconnect();
      }
      await expect(run).resolves.toMatchObject({
        reason: 'engine_offline',
        outputTail: 'the engine kept losing its link',
      });
      expect(onLinkWait.mock.calls.filter(([waiting]) => waiting)).toHaveLength(5);
    });

    it.each([false, true])('cancels an attach that timed out (aborted: %s)', async (aborted) => {
      const { run, controller } = await lostRun();
      vi.useFakeTimers();
      try {
        const engine = await online('eng_a', {}, (engine) => {
          engine.answer('full_test.attach', () => new Promise(() => {}));
          engine.answer('full_test.cancel', async () => null);
        });
        await vi.waitFor(() =>
          expect(engine.requests.some((r) => r.method === 'full_test.attach')).toBe(true),
        );
        if (aborted) controller.abort();
        await vi.advanceTimersByTimeAsync(61_000);
        await expect(run).resolves.toMatchObject({ reason: aborted ? 'killed' : 'timeout' });
        expect(engine.requests.filter((r) => r.method === 'full_test.cancel')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('runner', () => {
    it('relays cleanup and recovery without changing a resumed running generation', async () => {
      const engine = await online('eng_a', { processScope: 'process_group' });
      engine.answer('session.start', (params) => ({
        ...running(params.sessionId),
        scopeId: 'scp_0123456789abcdef',
      }));
      await remote.runner.start(spec());
      const seen: RunnerEvent[] = [];
      remote.runner.onEvent((event) => seen.push(event));
      const cleanup = {
        scopeId: 'scp_1111111111111111',
        kind: 'process_group' as const,
        outcome: 'clean' as const,
        reason: 'recovery' as const,
        killed: true,
        survivors: 0,
        durationMs: 5000,
      };
      await engine.emit({ kind: 'runner', event: { type: 'scope_recovered', sessionId: 's1', cleanup } });
      expect(remote.runner.isRunning('s1')).toBe(true);
      expect(remote.runner.list()[0]?.scopeId).toBe('scp_0123456789abcdef');
      await engine.emit({
        kind: 'runner',
        event: { type: 'exit', sessionId: 's1', exitCode: 0, signal: null, cleanup },
      });
      expect(remote.runner.isRunning('s1')).toBe(false);
      expect(seen).toEqual([
        expect.objectContaining({ type: 'scope_recovered', cleanup }),
        expect.objectContaining({ type: 'exit', cleanup }),
      ]);
    });
    it('routes failed-scope retries to the recorded session engine after exit', async () => {
      const engine = await online();
      engine.answer('session.start', (params) => running(params.sessionId));
      await remote.runner.start(spec());
      sessionEngines.set('s1', 'eng_a');
      await engine.emit({
        kind: 'runner',
        event: { type: 'exit', sessionId: 's1', exitCode: 0, signal: null },
      });
      expect(remote.runner.isRunning('s1')).toBe(false);
      const scopeId = 'scp_0123456789abcdef';
      const cleanup = {
        scopeId,
        kind: 'process_group' as const,
        outcome: 'clean' as const,
        reason: 'recovery' as const,
        killed: false,
        survivors: 0,
        durationMs: 0,
      };
      engine.answer('session.close_scopes', (params) =>
        params.scopes.map((scope) => ({ sessionId: scope.sessionId, cleanup })),
      );
      expect(await remote.runner.closeScopes!([{ sessionId: 's1', scopeId, sinceAgeMs: 1000 }])).toEqual([
        { sessionId: 's1', cleanup },
      ]);
      expect(engine.requests.at(-1)).toMatchObject({
        method: 'session.close_scopes',
        params: { scopes: [{ sessionId: 's1', scopeId, sinceAgeMs: 1000 }] },
      });
    });
    it('reads heavy-run sessions and falls back for old or disconnected engines', async () => {
      const engine = await online();
      const host = remote.directory.host('eng_a' as never)!;
      // An older engine has no handler: its RPC responds unknown_method.
      expect(await host.heavyRunSessions()).toEqual([]);
      engine.answer('host.heavy_run_sessions', () => ['s1']);
      expect(await host.heavyRunSessions()).toEqual(['s1']);
      engine.disconnect();
      expect(await host.heavyRunSessions()).toEqual([]);
    });

    it('reads a working directory as a directory or missing, `not_held` outside the roots, and passes other failures on (PM-1077)', async () => {
      const engine = await online();
      const host = remote.directory.host('eng_a' as never)!;
      engine.answer('host.is_directory', ({ path: target }) => target === '/engine/work');
      expect(await host.workspaceState('/engine/work')).toBe('directory');
      expect(await host.workspaceState('/engine/typo')).toBe('missing');
      engine.answer('host.is_directory', () => {
        throw Object.assign(new Error('outside'), { code: 'path_outside_roots' });
      });
      expect(await host.workspaceState('/owner/disk')).toBe('not_held');
      engine.answer('host.is_directory', () => {
        throw Object.assign(new Error('boom'), { code: 'timeout' });
      });
      await expect(host.workspaceState('/owner/disk')).rejects.toMatchObject({ linkCode: 'timeout' });
    });

    it('skips preparation on old engines, otherwise returns readiness and preserves dependency refusals', async () => {
      const engine = await online();
      const manager = remote.directory.host('eng_a' as never)!.memberWorkspaces!;
      const key = { project: testConfig(), repoName: testConfig().project.repos[0]!.name, member: 'dev' };
      expect(await manager.prepareDependencies(key)).toEqual({ status: 'skipped', reason: 'not_configured' });
      const ready = { status: 'ready' as const, key: 'a'.repeat(64), changed: true };
      engine.answer('workspace.prepareDependencies', () => ready);
      expect(await manager.prepareDependencies(key)).toEqual(ready);
      expect(engine.requests.at(-1)).toEqual({ method: 'workspace.prepareDependencies', params: [key] });
      engine.answer('workspace.prepareDependencies', () => {
        throw Object.assign(new Error('still running'), {
          code: 'workspace_dependencies_pending',
          details: { startedAt: '2026-10-16T20:00:00.000Z' },
        });
      });
      await expect(manager.prepareDependencies(key)).rejects.toMatchObject({
        code: 'workspace_dependencies_pending',
        details: { startedAt: '2026-10-16T20:00:00.000Z' },
      });
    });

    it('hands a task commit over on the engine, and asks for an update when the engine cannot (PM-739)', async () => {
      const engine = await online();
      const host = remote.directory.host('eng_a' as never)!;
      const key = {
        project: testConfig({ workspacePath: '/cloud/path' }),
        repoName: testConfig().project.repos[0]!.name,
        member: 'dev',
      };
      const commit = 'a'.repeat(40);
      // An older engine has no handler: the call is refused, and nothing is assumed handed over.
      await expect(
        host.memberWorkspaces!.publishTaskBranch(key, 'PM-1', 'PM-1-work', commit),
      ).rejects.toMatchObject({
        code: 'workspace_source_missing',
        details: { reason: 'engine_update_required', method: 'workspace.publishTaskBranch' },
      });
      const source = { path: '/engine/repo', ref: `refs/projectman/workspaces/dev/PM-1/${commit}` };
      engine.answer('workspace.publishTaskBranch', () => source);
      await expect(
        host.memberWorkspaces!.publishTaskBranch(key, 'PM-1', 'PM-1-work', commit),
      ).resolves.toEqual(source);
      // The fake records the calls it answered: only the second.
      expect(engine.requests.filter((item) => item.method === 'workspace.publishTaskBranch')).toEqual([
        { method: 'workspace.publishTaskBranch', params: [key, 'PM-1', 'PM-1-work', commit] },
      ]);
    });

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

    describe('status', () => {
      const reported = (over: Record<string, unknown> = {}) => ({
        provider: 'nanogpt' as const,
        loggedIn: true,
        method: 'api_key' as const,
        checkedAt: '2026-10-19T10:00:00.000Z',
        ...over,
      });
      const noKeyStatus = reported({ loggedIn: false, problem: 'no_key' });

      it('is ready when the cloud holds the key, though the engine reported it missing', async () => {
        const engine = await online();
        engine.answer('provider.status', async () => noKeyStatus);
        const status = await remote.runner.providerStatus!('nanogpt', { refresh: true });
        expect(status).toMatchObject({ loggedIn: true });
        expect(status).not.toHaveProperty('problem');
        expect(JSON.stringify(status)).not.toContain('key-from-store');
      });

      it('is a missing key when the cloud holds none, though the engine reported it ready', async () => {
        const engine = await online();
        engine.answer('provider.status', async () => reported());
        nanogptKey = null;
        await expect(remote.runner.providerStatus!('nanogpt', { refresh: true })).resolves.toMatchObject({
          loggedIn: false,
          problem: 'no_key',
        });
      });

      it('follows a saved or deleted key at the next read, from the cached engine answer', async () => {
        const engine = await online();
        const asked = vi.fn(async () => reported());
        engine.answer('provider.status', asked);
        await expect(remote.runner.providerStatus!('nanogpt')).resolves.toMatchObject({ loggedIn: true });
        nanogptKey = null;
        await expect(remote.runner.providerStatus!('nanogpt')).resolves.toMatchObject({
          loggedIn: false,
          problem: 'no_key',
        });
        nanogptKey = 'key-from-store';
        await expect(remote.runner.providerStatus!('nanogpt')).resolves.toMatchObject({ loggedIn: true });
        expect(asked).toHaveBeenCalledTimes(1);
      });

      it('counts a failing key store as no key', async () => {
        const engine = await online();
        engine.answer('provider.status', async () => reported());
        const failing = createRemoteRunner({
          hub: remote.hub,
          directory: remote.directory,
          recordedEngine: () => null,
          logger: silentLogger(),
          nanogptKeySet: async () => {
            throw new Error('the key store is down');
          },
        });
        await expect(failing.providerStatus!('nanogpt', { refresh: true })).resolves.toMatchObject({
          loggedIn: false,
          problem: 'no_key',
        });
      });

      it('leaves another provider and an engine that is not connected as they are', async () => {
        const engine = await online();
        engine.answer('provider.status', async (params) =>
          reported({ provider: params.provider, loggedIn: false, problem: 'no_key' }),
        );
        await expect(remote.runner.providerStatus!('codex', { refresh: true })).resolves.toMatchObject({
          provider: 'codex',
          loggedIn: false,
          problem: 'no_key',
        });
        await expect(
          remote.runner.providerStatus!('nanogpt', { engineId: 'eng_gone' as never }),
        ).resolves.toMatchObject({ loggedIn: null, detail: 'The engine is not connected' });
      });
    });
  });

  describe('an engine per project (PM-1059)', () => {
    // PA is on engine A, PB on engine B; the host (provider status, machine view) is A.
    const A = 'eng_aaaaaaaaaaaa';
    const B = 'eng_bbbbbbbbbbbb';
    let projectEngines: Record<string, string>;
    beforeEach(() => {
      projectEngines = { PA: A, PB: B };
      cloud.registry.bindProject('PA', A as never);
      cloud.registry.bindProject('PB', B as never);
    });
    const directory = {
      projectEngine: (projectKey: string) => (projectEngines[projectKey] ?? null) as never,
      hostEngine: () => A as never,
    };
    const asked = (engine: FakeEngine, method: string) =>
      engine.requests.filter((item) => item.method === method);
    const bothOnline = async (prepare: (engine: FakeEngine) => void) => ({
      a: await online(A, {}, prepare),
      b: await online(B, {}, prepare),
    });
    const changed = (number: number) =>
      ({
        repo: 'acme/web',
        number,
        title: 'Add login page',
        url: `https://github.com/acme/web/pull/${number}`,
        state: 'open',
        draft: false,
        headRef: 'task/AR-1',
        baseRef: 'main',
        checks: 'none',
        reviewDecision: null,
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        updatedAt: '2026-10-27T10:00:00.000Z',
      }) as const;

    describe('runner', () => {
      const runnerOver = () =>
        createRemoteRunner({
          hub: remote.hub,
          directory,
          recordedEngine: () => null,
          logger: silentLogger(),
        });

      it('starts a session on its project engine, never on a chosen engine of another project, and never falls back', async () => {
        const { a, b } = await bothOnline((engine) =>
          engine.answer('session.start', (params) => running(params.sessionId)),
        );
        const runner = runnerOver();
        await runner.start(spec({ sessionId: 'sa', projectKey: 'PA' }));
        await runner.start(spec({ sessionId: 'sb', projectKey: 'PB' }));
        // The chosen engine is checked too (PM-1061): A is not bound to PB, so nothing is sent.
        await expect(
          runner.start(spec({ sessionId: 'sc', projectKey: 'PB', engineId: A as never })),
        ).rejects.toMatchObject({ code: 'engine_not_bound' });
        expect(['sa', 'sb', 'sc'].map((id) => runner.engineOf(id))).toEqual([A, B, null]);
        expect(asked(a, 'session.start')).toHaveLength(1);
        expect(asked(b, 'session.start')).toHaveLength(1);
        // The project is not part of what the engine is sent.
        expect(asked(b, 'session.start')[0]!.params).not.toHaveProperty('projectKey');
        b.disconnect();
        cloud.registry.setOnline(B as never, false);
        await expect(runner.start(spec({ sessionId: 'sd', projectKey: 'PB' }))).rejects.toMatchObject({
          code: 'engine_offline',
        });
        expect(asked(a, 'session.start')).toHaveLength(1);
      });

      it('refuses a start that names neither an engine nor a project', async () => {
        await bothOnline((engine) => engine.answer('session.start', (params) => running(params.sessionId)));
        await expect(runnerOver().start(spec({ projectKey: undefined }))).rejects.toMatchObject({
          code: 'engine_offline',
        });
      });

      it('checks the workspace on the engine it is given, and provider status on the host', async () => {
        const { a, b } = await bothOnline((engine) => {
          engine.answer('session.assert_workspace_config', () => null);
          engine.answer('provider.status', async (params) => ({
            provider: params.provider,
            loggedIn: true,
            method: 'subscription' as const,
            checkedAt: '2026-10-27T10:00:00.000Z',
          }));
        });
        const runner = runnerOver();
        await runner.assertWorkspaceConfig!({ provider: 'claude', cwd: '/w', engineId: B as never });
        await expect(runner.assertWorkspaceConfig!({ provider: 'claude', cwd: '/w' })).rejects.toMatchObject({
          code: 'engine_offline',
        });
        await runner.providerStatus!('claude', { refresh: true });
        expect(asked(b, 'session.assert_workspace_config')).toHaveLength(1);
        expect(asked(a, 'session.assert_workspace_config')).toHaveLength(0);
        expect(asked(a, 'provider.status')).toHaveLength(1);
        expect(asked(b, 'provider.status')).toHaveLength(0);
      });
    });

    describe('GitHub', () => {
      const githubOver = () => createRemoteGithub({ hub: remote.hub, directory, logger: silentLogger() });
      const watchIdOf = (engine: FakeEngine) =>
        (asked(engine, 'github.watch')[0]!.params as { watchId: string }).watchId;
      const acceptWatches = (engine: FakeEngine) => {
        engine.answer('github.watch', () => null);
        engine.answer('github.unwatch', () => null);
      };

      it('reads and publishes through the project engine, and reports no gh while that engine is away', async () => {
        const { a, b } = await bothOnline((engine) => {
          engine.answer('github.get_pull_request', (params) => changed(params.number));
          engine.answer('github.publish_release', () => ({
            url: 'https://github.com/acme/web/releases/tag/v1',
          }));
          engine.answer('github.is_available', () => true);
        });
        const github = githubOver();
        await github.getPullRequest('PB', 'acme/web', 7);
        await github.publishRelease('PB', 'acme/web', { tag: 'v1', title: 'v1', notes: 'n' });
        expect(asked(b, 'github.get_pull_request')).toHaveLength(1);
        expect(asked(b, 'github.publish_release')).toHaveLength(1);
        expect(a.requests).toEqual([]);
        await github.getPullRequest('PA', 'acme/web', 8);
        expect(asked(a, 'github.get_pull_request')).toHaveLength(1);
        b.disconnect();
        cloud.registry.setOnline(B as never, false);
        expect(await github.isAvailable('PB')).toBe(false);
        expect(await github.isAvailable('PA')).toBe(true);
        await expect(github.getPullRequest('PB', 'acme/web', 7)).rejects.toMatchObject({
          code: 'unreachable',
        });
        expect(asked(a, 'github.get_pull_request')).toHaveLength(1);
      });

      it('keeps the same pull request of two projects as two watches, each on its own engine', async () => {
        const { a, b } = await bothOnline(acceptWatches);
        const github = githubOver();
        const heardA = vi.fn();
        const heardB = vi.fn();
        const stopA = github.watch('PA', [{ repo: 'acme/web', number: 7 }], heardA);
        const stopB = github.watch('PB', [{ repo: 'acme/web', number: 7 }], heardB);
        await vi.waitFor(() => expect(asked(a, 'github.watch')).toHaveLength(1));
        await vi.waitFor(() => expect(asked(b, 'github.watch')).toHaveLength(1));
        expect(watchIdOf(a)).not.toBe(watchIdOf(b));
        // An engine that reports a watch it does not hold is not heard.
        await b.emit({ kind: 'github_changed', watchId: watchIdOf(a), change: changed(7) });
        expect(heardA).not.toHaveBeenCalled();
        await a.emit({ kind: 'github_changed', watchId: watchIdOf(a), change: changed(7) });
        await b.emit({ kind: 'github_changed', watchId: watchIdOf(b), change: changed(7) });
        expect(heardA).toHaveBeenCalledTimes(1);
        expect(heardB).toHaveBeenCalledTimes(1);
        stopB();
        await vi.waitFor(() => expect(asked(b, 'github.unwatch')).toHaveLength(1));
        expect(asked(b, 'github.unwatch')[0]!.params).toEqual({ watchId: watchIdOf(b) });
        expect(asked(a, 'github.unwatch')).toHaveLength(0);
        stopA();
      });

      it('sends the watches of the engine that connects, and does not move a watch to another engine', async () => {
        const a = await online(A, {}, acceptWatches);
        const github = githubOver();
        github.watch('PA', [{ repo: 'acme/web', number: 7 }], vi.fn());
        github.watch('PB', [{ repo: 'acme/web', number: 8 }], vi.fn());
        await vi.waitFor(() => expect(asked(a, 'github.watch')).toHaveLength(1));
        // PB's engine is away: its watch waits, and is not given to the engine that is there.
        expect(a.requests.filter((item) => item.method === 'github.watch')).toHaveLength(1);
        const b = await online(B, {}, acceptWatches);
        await vi.waitFor(() => expect(asked(b, 'github.watch')).toHaveLength(1));
        expect(asked(b, 'github.watch')[0]!.params).toMatchObject({
          targets: [{ repo: 'acme/web', number: 8 }],
        });
        // A reconnect of one engine sends that engine's watches again, not the other's.
        a.disconnect();
        const a2 = await online(A, {}, acceptWatches);
        await vi.waitFor(() => expect(asked(a2, 'github.watch')).toHaveLength(1));
        expect(asked(a2, 'github.watch')[0]!.params).toMatchObject({
          targets: [{ repo: 'acme/web', number: 7 }],
        });
        expect(asked(b, 'github.watch')).toHaveLength(1);
      });

      it('ignores an event of the engine that held a watch once the project has another engine', async () => {
        const { b } = await bothOnline(acceptWatches);
        const github = githubOver();
        const heard = vi.fn();
        github.watch('PB', [{ repo: 'acme/web', number: 7 }], heard);
        await vi.waitFor(() => expect(asked(b, 'github.watch')).toHaveLength(1));
        projectEngines.PB = A;
        await b.emit({ kind: 'github_changed', watchId: watchIdOf(b), change: changed(7) });
        expect(heard).not.toHaveBeenCalled();
      });

      it('moves a watch to the new base engine of its project, and no longer hears the old one (PM-1060)', async () => {
        const { a, b } = await bothOnline(acceptWatches);
        const github = githubOver();
        const heard = vi.fn();
        github.watch('PB', [{ repo: 'acme/web', number: 7 }], heard);
        await vi.waitFor(() => expect(asked(b, 'github.watch')).toHaveLength(1));
        const watchId = watchIdOf(b);
        projectEngines.PB = A;
        cloud.registry.bindProject('PB', A as never);
        await vi.waitFor(() => expect(asked(a, 'github.watch')).toHaveLength(1));
        await vi.waitFor(() => expect(asked(b, 'github.unwatch')).toHaveLength(1));
        expect(asked(b, 'github.unwatch')[0]!.params).toEqual({ watchId });
        await b.emit({ kind: 'github_changed', watchId, change: changed(7) });
        expect(heard).not.toHaveBeenCalled();
        await a.emit({ kind: 'github_changed', watchId, change: changed(7) });
        expect(heard).toHaveBeenCalledTimes(1);
      });
    });

    describe('files', () => {
      const homeOf = (name: string) => ({ paths: { ...helloOf().paths, home: `/fictional/${name}` } });
      const onBoth = async () => {
        const prepare = (engine: FakeEngine) =>
          engine.answer('files.materialize', (params) => ({
            path: `/fictional/${engine.id}/${params.name}`,
          }));
        const a = await online(A, homeOf('a'), prepare);
        const b = await online(B, homeOf('b'), prepare);
        vi.spyOn(remote.directory, 'projectEngine').mockImplementation(
          (projectKey) => (projectEngines[projectKey] ?? null) as never,
        );
        return { a, b };
      };
      const input = (sessionId: string, projectKey: string, storedPath: string) =>
        ({
          sessionId,
          projectKey,
          taskKey: `${projectKey}-1`,
          attachment: { id: 'att1', fileName: 'x.pdf' },
          storedPath,
        }) as never;

      it('keeps a card’s files on the project engine and none on a project without one', async () => {
        await onBoth();
        await expect(remote.attachments.directory('PA', 'PA-1')).resolves.toBe(
          '/fictional/a/attachments-cache/PA/PA-1',
        );
        await expect(remote.attachments.directory('PB', 'PB-1')).resolves.toBe(
          '/fictional/b/attachments-cache/PB/PB-1',
        );
        await expect(remote.attachments.directory('PZ', 'PZ-1')).rejects.toMatchObject({
          code: 'engine_offline',
        });
      });

      it('gives a file to the session’s engine first, the project’s otherwise, and never to another one', async () => {
        const { a, b } = await onBoth();
        const file = path.join(spool, 'x.pdf');
        writeFileSync(file, 'abc');
        sessionEngines.set('s1', B);
        // PA is also bound to B (a second binding): the session ran there, so the file goes there.
        cloud.registry.bindAlso('PA', B as never);
        await expect(remote.attachments.materialize(input('s1', 'PA', file))).resolves.toBe(
          `/fictional/${B}/att1-x.pdf`,
        );
        await expect(remote.attachments.materialize(input('s2', 'PA', file))).resolves.toBe(
          `/fictional/${A}/att1-x.pdf`,
        );
        expect(asked(b, 'files.materialize')).toHaveLength(1);
        expect(asked(a, 'files.materialize')).toHaveLength(1);
        b.disconnect();
        cloud.registry.setOnline(B as never, false);
        await expect(remote.attachments.materialize(input('s1', 'PA', file))).rejects.toMatchObject({
          code: 'engine_offline',
        });
        expect(asked(a, 'files.materialize')).toHaveLength(1);
      });

      it('refuses a file of a project to an engine it is not bound to', async () => {
        const { b } = await onBoth();
        const file = path.join(spool, 'x.pdf');
        writeFileSync(file, 'abc');
        sessionEngines.set('s1', B);
        // The session claims to be on B, but PA is bound to A only (PM-1061).
        await expect(remote.attachments.materialize(input('s1', 'PA', file))).rejects.toMatchObject({
          code: 'engine_not_bound',
        });
        expect(asked(b, 'files.materialize')).toHaveLength(0);
      });

      it('copies a message file into the folder of the engine the session folder is on', async () => {
        const { a, b } = await onBoth();
        for (const engine of [a, b])
          engine.answer('files.materialize_into_session', () => ({ path: `/fictional/${engine.id}/f` }));
        const file = path.join(spool, 'x.pdf');
        writeFileSync(file, 'abc');
        const sha = createHash('sha256').update('abc').digest('hex');
        const folders = remote.directory.get(B as never)!.sessionFolders!;
        await folders.materializeFile('s1', {
          name: 'msa_1-x.pdf',
          source: { path: file, size: 3, sha256: sha },
        });
        expect(asked(b, 'files.materialize_into_session')).toHaveLength(1);
        expect(asked(a, 'files.materialize_into_session')).toHaveLength(0);
      });
    });

    describe('transcripts', () => {
      it('asks only the engine the session ran on and never another one when none is named', async () => {
        const { a, b } = await bothOnline((engine) => {
          engine.answer('transcript.has_content', () => true);
          engine.answer('transcript.summary', () => null);
        });
        const reader = remote.createRunnerModule(broker, undefined).transcripts;
        await expect(reader.hasContent('/x.jsonl', { engineId: B as never })).resolves.toBe(true);
        await expect(reader.hasContent('/x.jsonl', {})).resolves.toBe(false);
        await expect(reader.summary('/x.jsonl', { provider: 'claude' } as never)).resolves.toBeNull();
        await expect(reader.read('/x.jsonl', {})).rejects.toMatchObject({ code: 'engine_offline' });
        expect(asked(b, 'transcript.has_content')).toHaveLength(1);
        expect(a.requests.filter((item) => item.method.startsWith('transcript.'))).toEqual([]);
        expect(b.requests.filter((item) => item.method !== 'transcript.has_content')).toEqual([]);
      });
    });

    describe('machine', () => {
      it('shows, signals and identifies the host’s machine and no other project’s engine', async () => {
        const prepare = (engine: FakeEngine) => engine.answer('machine.signal', () => 'sent');
        const a = await online(A, { pid: 111, uid: 1 }, prepare);
        const b = await online(B, { pid: 222, uid: 2 }, prepare);
        vi.spyOn(remote.directory, 'hostEngine').mockReturnValue(A as never);
        vi.spyOn(remote.directory, 'projectEngine').mockImplementation(
          (projectKey) => (projectEngines[projectKey] ?? null) as never,
        );
        expect(remote.machineProbe.identity()).toMatchObject({ pid: 111, uid: 1 });
        await remote.machineProbe.signal(5, 'SIGTERM');
        expect(asked(a, 'machine.signal')).toHaveLength(1);
        expect(asked(b, 'machine.signal')).toHaveLength(0);
        // The host's engine is away: the view is unavailable, not served from the project's engine.
        a.disconnect();
        cloud.registry.setOnline(A as never, false);
        expect(remote.machineProbe.available()).toBe(false);
        await expect(remote.machineProbe.signal(5, 'SIGTERM')).rejects.toMatchObject({
          code: 'engine_offline',
        });
        expect(asked(b, 'machine.signal')).toHaveLength(0);
      });
    });
  });

  describe('two owners’ engines (PM-1061)', () => {
    // A is the host owner's engine, B belongs to another owner; project PA runs on A and PB on B.
    const A = 'eng_aaaaaaaaaaaa';
    const B = 'eng_bbbbbbbbbbbb';
    const asked = (engine: FakeEngine, method: string) =>
      engine.requests.filter((item) => item.method === method);
    let a: FakeEngine;
    let b: FakeEngine;
    beforeEach(async () => {
      cloud.registry.bindProject('PA', A as never);
      cloud.registry.bindProject('PB', B as never);
      cloud.registry.setForeign(B as never);
      const prepare = (engine: FakeEngine) => {
        engine.answer('machine.processes', () => null);
        engine.answer('workspace.home', () => '/fictional/home');
        engine.answer('session.start', (params) => running(params.sessionId));
      };
      a = await online(A, {}, prepare);
      b = await online(B, {}, prepare);
    });
    const homeCall = (engine: string, projectKey: string) =>
      remote.hub.call(engine as never, 'workspace.home', [{ projectKey, member: 'dev' }]);

    it('sends a call of a project only to an engine bound to it', async () => {
      await homeCall(A, 'PA');
      await homeCall(B, 'PB');
      await expect(homeCall(B, 'PA')).rejects.toMatchObject({ code: 'engine_not_bound' });
      await expect(homeCall(A, 'PB')).rejects.toMatchObject({ code: 'engine_not_bound' });
      expect(asked(a, 'workspace.home')).toHaveLength(1);
      expect(asked(b, 'workspace.home')).toHaveLength(1);
    });

    it('sends the machine and administration calls only to the host owner’s engine', async () => {
      await remote.hub.call(A as never, 'machine.processes', {});
      await expect(remote.hub.call(B as never, 'machine.processes', {})).rejects.toMatchObject({
        code: 'engine_not_host',
      });
      await expect(remote.hub.call(B as never, 'admin.status', {} as never)).rejects.toMatchObject({
        code: 'engine_not_host',
      });
      expect(b.requests).toEqual([]);
    });

    it('does not give the NanoGPT key to another owner’s engine, nor start a NanoGPT session on it', async () => {
      await expect(b.call('secret.nanogpt_key', { sessionId: 's1' })).rejects.toMatchObject({
        linkCode: 'secret_not_allowed',
      });
      await expect(
        remote.runner.start(spec({ provider: 'nanogpt', projectKey: 'PB', engineId: B as never })),
      ).rejects.toMatchObject({ code: 'nanogpt_key_not_for_engine' });
    });

    it('refuses a team tools relay and a permission request of a session of a project the engine is not bound to', async () => {
      // The recorded session s1 runs on B, but its project (AR) is bound to A only.
      cloud.registry.bindProject('AR', A as never);
      sessionEngines.set('s1', B);
      const body = {
        token: 'tok-abc',
        contentType: 'application/json',
        accept: 'application/json, text/event-stream',
        body: '{"jsonrpc":"2.0"}',
      };
      expect((await b.call('mcp.relay', body)).status).toBe(404);
      await expect(
        b.call('permission.decide', { request: permissionRequest('s1') } as never),
      ).rejects.toMatchObject({ linkCode: 'not_running' });
      expect(broker.decide).not.toHaveBeenCalled();
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

    it('has the engine fetch a message file with a single-use token and put it into a session folder (PM-518)', async () => {
      const engine = await online();
      engine.answer('files.materialize_into_session', () => ({ path: '/fictional/folders/s1/f/x.pdf' }));
      const folders = remote.directory.get('eng_a' as never)!.sessionFolders!;
      const file = path.join(spool, 'x.pdf');
      writeFileSync(file, 'abc');
      const sha = createHash('sha256').update('abc').digest('hex');
      const reply = await folders.materializeFile('s1', {
        name: 'msa_1-x.pdf',
        source: { path: file, size: 3, sha256: sha },
      });
      expect(reply).toEqual({ path: '/fictional/folders/s1/f/x.pdf' });
      const sent = engine.requests.at(-1)!;
      expect(sent.method).toBe('files.materialize_into_session');
      expect(sent.params).toMatchObject({
        sessionId: 's1',
        name: 'msa_1-x.pdf',
        size: 3,
        sha256: sha,
        downloadToken: expect.stringMatching(/^[A-Za-z0-9_-]{20,}$/),
      });
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

    it('takes screenshots through the remote host with only scenario roots crossing the RPC boundary', async () => {
      const engine = await online();
      const host = remote.directory.get('eng_a' as never)!;
      const scope = {
        cwd: '/fictional/work',
        sessionDir: '/fictional/folders/s1',
        browsersDir: '/fictional/browsers',
        sandbox: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
      };
      const scenario = '/fictional/work/shots/login.mjs';
      const image = '/fictional/folders/s1/shots/login.png';
      const resolve = vi.fn(() => ({ path: scenario }));
      engine.answer('files.resolve_scenario', resolve);
      engine.answer('files.list_images', () => [image]);
      engine.answer('screenshots.run', () => ({
        exitCode: 0,
        timedOut: false,
        aborted: false,
        output: 'ok',
      }));
      const runs = new ScreenshotRuns({
        executorFor: () => host.screenshotExecutor,
        diskFor: () => host,
        sessions: { screenshotScope: () => scope },
        outputTail,
        logger: silentLogger(),
        platform: 'darwin',
      });
      try {
        await expect(
          runs.take(
            { sessionId: 's1', projectKey: 'PM', member: 'codex', taskKey: 'PM-785' },
            { scenario: 'shots/login.mjs' },
          ),
        ).resolves.toMatchObject({ status: 'done', files: [image], exitCode: 0 });
        expect(resolve).toHaveBeenCalledWith({
          roots: { cwd: scope.cwd, sessionDir: scope.sessionDir },
          requested: 'shots/login.mjs',
        });
        expect(engine.requests.find((request) => request.method === 'screenshots.run')?.params).toMatchObject(
          {
            spec: { ...scope, args: [scenario] },
          },
        );
      } finally {
        await runs.stop();
      }
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

    it('reports a full test started by the engine, once, and only for its own run', async () => {
      const engine = await online();
      let finish: (value: FullTestResult) => void = () => {};
      engine.answer(
        'full_test.run',
        () =>
          new Promise<FullTestResult>((resolve) => {
            finish = resolve;
          }),
      );
      const onStarted = vi.fn();
      const executor = remote.directory.get('eng_a' as never)!.fullTestExecutor!;
      const run = executor.run(fullTestSpec('f1'), new AbortController().signal, onStarted);
      await vi.waitFor(() =>
        expect(engine.requests.some((item) => item.method === 'full_test.run')).toBe(true),
      );
      await engine.emit({ kind: 'full_test_started', runId: 'other' } as never);
      expect(onStarted).not.toHaveBeenCalled();
      await engine.emit({ kind: 'full_test_started', runId: 'f1' } as never);
      expect(onStarted).toHaveBeenCalledTimes(1);
      finish({ outcome: 'passed', exitCode: 0, durationMs: 1, failedFiles: [], outputTail: '' });
      await expect(run).resolves.toMatchObject({ outcome: 'passed' });
      // The run is over: a late event reaches nobody.
      await engine.emit({ kind: 'full_test_started', runId: 'f1' } as never);
      expect(onStarted).toHaveBeenCalledTimes(1);
    });

    it('blocks the run on an older engine that refuses requireHeavyLock, without repeating it without the flag', async () => {
      const engine = await online();
      let ran = false;
      // An older engine's strict schema: the unknown field makes the request invalid before it runs.
      const oldSpecKeys = ['runId', 'cwd', 'command', 'maxWorkers', 'timeoutMs', 'sandbox'];
      engine.answer('full_test.run', (params) => {
        if (Object.keys(params.spec).some((key) => !oldSpecKeys.includes(key)))
          throw Object.assign(new Error('Invalid method parameters'), { code: 'invalid_params' });
        ran = true;
        return { outcome: 'passed' as const, exitCode: 0, durationMs: 1, failedFiles: [], outputTail: '' };
      });
      const executor = remote.directory.get('eng_a' as never)!.fullTestExecutor!;
      const onStarted = vi.fn();
      const result = await executor.run(
        { ...fullTestSpec('f1'), requireHeavyLock: true },
        new AbortController().signal,
        onStarted,
      );
      expect(result).toMatchObject({
        outcome: 'error',
        reason: 'heavy_lock_unavailable',
        outputTail: expect.stringContaining('Update the engine'),
      });
      expect(ran).toBe(false);
      expect(onStarted).not.toHaveBeenCalled();
      expect(engine.requests.filter((item) => item.method === 'full_test.run')).toHaveLength(1);
      // A request without the flag still runs there.
      await expect(executor.run(fullTestSpec('f2'), new AbortController().signal)).resolves.toMatchObject({
        outcome: 'passed',
      });
      expect(ran).toBe(true);
    });

    describe('GitHub Actions descriptor (PM-900)', () => {
      const githubSpec = (runId: string): FullTestSpec => ({
        ...fullTestSpec(runId),
        cwd: 'github-actions:acme/web',
        githubActions: {
          ref: { projectKey: 'AR', repo: 'ar' },
          mergeId: 'merge_1',
          repo: 'acme/web',
          base: 'main',
          commit: 'a'.repeat(40),
          workflow: 'merge-check.yml',
          files: ['a.test.ts'],
        },
      });

      it('sends the descriptor to the engine and relays the run page of its result', async () => {
        const engine = await online();
        const externalUrl = 'https://github.com/acme/web/actions/runs/7';
        engine.answer('full_test.run', () => ({
          outcome: 'passed' as const,
          exitCode: 0,
          durationMs: 1,
          failedFiles: [],
          outputTail: '',
          externalUrl,
        }));
        const executor = remote.directory.get('eng_a' as never)!.fullTestExecutor!;
        const result = await executor.run(githubSpec('f1'), new AbortController().signal);
        expect(result).toMatchObject({ outcome: 'passed', externalUrl });
        expect(engine.requests.filter((item) => item.method === 'full_test.run')).toEqual([
          { method: 'full_test.run', params: { spec: expect.objectContaining(githubSpec('f1')) } },
        ]);
      });

      it('blocks the run on an older engine that refuses the descriptor, without running it', async () => {
        const engine = await online();
        let ran = false;
        // An older engine's strict schema: the unknown field makes the request invalid before it runs.
        engine.answer('full_test.run', (params) => {
          if ('githubActions' in params.spec)
            throw Object.assign(new Error('Invalid method parameters'), { code: 'invalid_params' });
          ran = true;
          return { outcome: 'passed' as const, exitCode: 0, durationMs: 1, failedFiles: [], outputTail: '' };
        });
        const onStarted = vi.fn();
        const result = await remote.directory
          .get('eng_a' as never)!
          .fullTestExecutor!.run(githubSpec('f1'), new AbortController().signal, onStarted);
        expect(result).toMatchObject({
          outcome: 'error',
          reason: 'github_unavailable',
          outputTail: expect.stringContaining('Update the engine'),
        });
        expect(ran).toBe(false);
        expect(onStarted).not.toHaveBeenCalled();
      });
    });

    describe('step report (PM-876)', () => {
      const passed = {
        outcome: 'passed' as const,
        exitCode: 0,
        durationMs: 1,
        failedFiles: [],
        outputTail: '',
      };
      const report = {
        scope: 'modules' as const,
        workers: 4,
        commandMs: 90,
        steps: [
          {
            index: 0,
            kind: 'test' as const,
            workspace: 'apps/server',
            result: 'passed' as const,
            durationMs: 80,
          },
        ],
      };

      it('fetches the report after the run and puts it on the result', async () => {
        const engine = await online();
        engine.answer('full_test.run', () => passed);
        engine.answer('full_test.report', () => ({ state: 'ended' as const, report }));
        const result = await remote.directory
          .get('eng_a' as never)!
          .fullTestExecutor!.run(fullTestSpec('f1'), new AbortController().signal);
        expect(result).toEqual({ ...passed, report });
        expect(engine.requests.filter((item) => item.method === 'full_test.report')).toEqual([
          { method: 'full_test.report', params: { runId: 'f1' } },
        ]);
      });

      it.each([
        ['an older engine without the method', undefined],
        ['an engine that no longer knows the run', () => ({ state: 'unknown' as const })],
        [
          'a failing report call',
          () => {
            throw new Error('boom');
          },
        ],
      ])('leaves the report out, without an error, for %s', async (_name, handler) => {
        const engine = await online();
        engine.answer('full_test.run', () => passed);
        if (handler) engine.answer('full_test.report', handler);
        const result = await remote.directory
          .get('eng_a' as never)!
          .fullTestExecutor!.run(fullTestSpec('f1'), new AbortController().signal);
        expect(result).toEqual(passed);
      });
    });

    it('blocks the run on an older engine that refuses npmCi, without repeating it without the field', async () => {
      const engine = await online();
      let ran = false;
      const oldSpecKeys = [
        'runId',
        'cwd',
        'command',
        'maxWorkers',
        'timeoutMs',
        'sandbox',
        'requireHeavyLock',
      ];
      engine.answer('full_test.run', (params) => {
        if (Object.keys(params.spec).some((key) => !oldSpecKeys.includes(key)))
          throw Object.assign(new Error('Invalid method parameters'), { code: 'invalid_params' });
        ran = true;
        return { outcome: 'passed' as const, exitCode: 0, durationMs: 1, failedFiles: [], outputTail: '' };
      });
      const executor = remote.directory.get('eng_a' as never)!.fullTestExecutor!;
      const onStarted = vi.fn();
      const npmCi = { ref: { projectKey: 'AR', repo: 'ar' }, mergeId: 'mrg_1' };
      for (const requireHeavyLock of [undefined, true]) {
        const result = await executor.run(
          { ...fullTestSpec('f1'), npmCi, requireHeavyLock },
          new AbortController().signal,
          onStarted,
        );
        expect(result).toMatchObject({
          outcome: 'error',
          reason: 'dependency_install_failed',
          outputTail: expect.stringContaining('Update the engine'),
        });
      }
      expect(ran).toBe(false);
      expect(onStarted).not.toHaveBeenCalled();
      expect(engine.requests.filter((item) => item.method === 'full_test.run')).toHaveLength(2);
    });

    it('sends npmCi and requireHeavyLock to the engine and relays its result (PM-658, PM-681)', async () => {
      const engine = await online();
      engine.answer('full_test.run', () => ({
        outcome: 'error' as const,
        reason: 'dependency_install_failed' as const,
        exitCode: 1,
        durationMs: 5,
        failedFiles: [],
        outputTail: 'npm ci failed',
      }));
      const npmCi = { ref: { projectKey: 'AR', repo: 'ar' }, mergeId: 'mrg_1' };
      const executor = remote.directory.get('eng_a' as never)!.fullTestExecutor!;
      const result = await executor.run(
        { ...fullTestSpec('f1'), npmCi, requireHeavyLock: true },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ outcome: 'error', reason: 'dependency_install_failed', exitCode: 1 });
      expect(engine.requests.filter((item) => item.method === 'full_test.run')).toEqual([
        {
          method: 'full_test.run',
          params: { spec: expect.objectContaining({ npmCi, requireHeavyLock: true }) },
        },
      ]);
    });

    it('cancels the run on its engine when the call times out, ending it as a timeout (PM-681)', async () => {
      const engine = await online();
      engine.answer('full_test.run', () => new Promise(() => {}));
      // The engine answers the cancel only when the run has ended, so the caller removes the checkout after.
      let engineStopped: () => void = () => {};
      engine.answer(
        'full_test.cancel',
        () =>
          new Promise<null>((resolve) => {
            engineStopped = () => resolve(null);
          }),
      );
      const executor = remote.directory.get('eng_a' as never)!.fullTestExecutor!;
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        const npmCi = { ref: { projectKey: 'AR', repo: 'ar' }, mergeId: 'mrg_1' };
        const run = executor.run(
          { ...fullTestSpec('f1'), npmCi, requireHeavyLock: true },
          new AbortController().signal,
        );
        let ended = false;
        void run.then(() => {
          ended = true;
        });
        await vi.waitFor(() =>
          expect(engine.requests.some((item) => item.method === 'full_test.run')).toBe(true),
        );
        await vi.advanceTimersByTimeAsync(1000 + 60_000);
        await vi.waitFor(() =>
          expect(engine.requests.some((item) => item.method === 'full_test.cancel')).toBe(true),
        );
        expect(ended).toBe(false);
        engineStopped();
        await expect(run).resolves.toMatchObject({ outcome: 'error', reason: 'timeout' });
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() =>
        expect(engine.requests.filter((item) => item.method === 'full_test.cancel')).toEqual([
          { method: 'full_test.cancel', params: { runId: 'f1' } },
        ]),
      );
    });

    it('ends an aborted run whose call then times out as killed, after a single cancel (PM-681)', async () => {
      const engine = await online();
      engine.answer('full_test.run', () => new Promise(() => {}));
      let engineStopped: () => void = () => {};
      engine.answer(
        'full_test.cancel',
        () =>
          new Promise<null>((resolve) => {
            engineStopped = () => resolve(null);
          }),
      );
      const executor = remote.directory.get('eng_a' as never)!.fullTestExecutor!;
      const controller = new AbortController();
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        const run = executor.run({ ...fullTestSpec('f1'), requireHeavyLock: true }, controller.signal);
        await vi.waitFor(() =>
          expect(engine.requests.some((item) => item.method === 'full_test.run')).toBe(true),
        );
        controller.abort();
        await vi.advanceTimersByTimeAsync(1000 + 60_000);
        engineStopped();
        await expect(run).resolves.toMatchObject({ outcome: 'error', reason: 'killed' });
      } finally {
        vi.useRealTimers();
      }
      expect(engine.requests.filter((item) => item.method === 'full_test.cancel')).toHaveLength(1);
    });

    it('sends allowDependencyInstall, and blocks once on an older engine that refuses it (PM-681)', async () => {
      const engine = await online();
      const ref = { projectKey: 'AR', repo: 'ar' };
      const input = { mergeId: 'mrg_abcdefgh1', mergeCommit: 'a'.repeat(40), depsFrom: null };
      let ran = 0;
      engine.answer('merge.checkout_for_check', (params) => {
        ran += 1;
        if ('allowDependencyInstall' in params)
          throw Object.assign(new Error('Invalid method parameters'), { code: 'invalid_params' });
        return { path: '/w/_merge/m', gitDir: '/r/.git' };
      });
      const merger = remote.directory.get('eng_a' as never)!.merger!;
      const refused = await merger
        .checkoutForCheck(ref, { ...input, allowDependencyInstall: true })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(MergeError);
      expect(refused).toMatchObject({
        code: 'git_failed',
        message: expect.stringContaining('Update the engine'),
      });
      expect(ran).toBe(1);
      // Without the switch the request is the old one and still runs.
      await expect(merger.checkoutForCheck(ref, input)).resolves.toMatchObject({ path: '/w/_merge/m' });
      expect(ran).toBe(2);
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

    it('sends the release tags and the GitHub release, and names an engine that is too old (PM-968)', async () => {
      const merger = () => remote.directory.get('eng_a' as never)!.merger!;
      const ref = { projectKey: 'AR', repo: 'ar' };
      const sha = 'a'.repeat(40);
      const input = { repo: 'acme/ar', tag: 'v1', title: 'v1', notes: 'n' };
      const engine = await online();
      // An older engine has no handler: its RPC responds unknown_method.
      await expect(merger().remoteTags(ref, { base: 'main' })).rejects.toMatchObject({
        code: 'git_failed',
        message: expect.stringContaining('update the engine'),
      });
      await expect(remote.github.publishRelease('AR', input.repo, input)).rejects.toMatchObject({
        code: 'failed',
      });

      engine.answer('merge.remote_tags', () => [{ name: 'v0', commit: sha }]);
      engine.answer('merge.push_tag', () => ({ ok: true }));
      engine.answer('github.publish_release', () => ({ url: 'https://github.com/acme/ar/releases/tag/v1' }));
      expect(await merger().remoteTags(ref, { base: 'main' })).toEqual([{ name: 'v0', commit: sha }]);
      expect(await merger().pushTag(ref, { base: 'main', tag: 'v1', commit: sha })).toEqual({ ok: true });
      expect(engine.requests.at(-1)).toEqual({
        method: 'merge.push_tag',
        params: { ref, base: 'main', tag: 'v1', commit: sha },
      });
      expect(await remote.github.publishRelease('AR', input.repo, input)).toEqual({
        url: 'https://github.com/acme/ar/releases/tag/v1',
      });
      expect(engine.requests.at(-1)).toEqual({
        method: 'github.publish_release',
        params: input,
      });
    });

    it('sends the document read and commit with the repository named, and returns their results', async () => {
      const engine = await online();
      const ref = { projectKey: 'AR', repo: 'ar' };
      const sha = 'a'.repeat(40);
      engine.answer('merge.read_file', () => ({ commit: sha, text: 'log\n' }));
      engine.answer('merge.commit_files', () => ({ commit: 'b'.repeat(40), changed: ['docs/log.md'] }));
      const merger = remote.directory.get('eng_a' as never)!.merger!;
      expect(await merger.readFile(ref, { at: { base: 'main' }, path: 'docs/log.md' })).toEqual({
        commit: sha,
        text: 'log\n',
      });
      expect(engine.requests.at(-1)).toEqual({
        method: 'merge.read_file',
        params: { ref, at: { base: 'main' }, path: 'docs/log.md' },
      });
      const files = [{ path: 'docs/log.md', text: 'new\n' }];
      expect(await merger.commitFiles(ref, { onto: sha, files, message: 'Docs' })).toEqual({
        commit: 'b'.repeat(40),
        changed: ['docs/log.md'],
      });
      expect(engine.requests.at(-1)).toEqual({
        method: 'merge.commit_files',
        params: { ref, onto: sha, files, message: 'Docs' },
      });
    });

    it('sends the path reads with the repository named, and returns their results', async () => {
      const engine = await online();
      const ref = { projectKey: 'AR', repo: 'ar' };
      const sha = 'a'.repeat(40);
      engine.answer('merge.list_paths', () => ({ commit: sha, paths: ['a.ts', 'b/c.ts'], truncated: false }));
      const changed = [
        { id: 'AR-1', ok: true as const, commit: sha, paths: ['a.ts'], truncated: false },
        { id: 'AR-2', ok: false as const, reason: 'unknown' as const },
      ];
      engine.answer('merge.changed_paths', () => changed);
      const merger = remote.directory.get('eng_a' as never)!.merger!;
      expect(await merger.listPaths(ref, { base: 'main' })).toEqual({
        commit: sha,
        paths: ['a.ts', 'b/c.ts'],
        truncated: false,
      });
      expect(engine.requests.at(-1)).toEqual({ method: 'merge.list_paths', params: { ref, base: 'main' } });
      const items = [
        { id: 'AR-1', at: { branch: 'AR-1-card' } },
        { id: 'AR-2', at: { commit: sha } },
      ];
      expect(await merger.changedPaths(ref, { base: 'main', items })).toEqual(changed);
      expect(engine.requests.at(-1)).toEqual({
        method: 'merge.changed_paths',
        params: { ref, base: 'main', items },
      });
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
      await planUsage.get('eng_a' as never);
      await planUsage.get('eng_a' as never);
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
