import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { FullTestExecutor, FullTestResult, FullTestSpec } from '../contracts';
import { CLOUD_METHODS, createEngineHandlers } from './engine-handlers';
import { methods } from './methods';
import type { EngineMethod, MethodParams, MethodResult } from './methods';
import { decodeFrame } from './protocol';
import { createEngineRpc, createRpcState } from './rpc';
import type { EngineRpc } from './rpc';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function temporaryCheckRoot() {
  const directory = await mkdtemp(path.join(tmpdir(), 'engine-check-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}

const passed: FullTestResult = {
  outcome: 'passed',
  exitCode: 0,
  durationMs: 1,
  failedFiles: [],
  outputTail: '',
};
const checkRoot = '/fictional/worktrees';
const checkCwd = `${checkRoot}/_merge/mrg_1`;
const fullSpec = (runId: string, cwd = checkCwd): FullTestSpec => ({
  runId,
  cwd,
  command: 'npm test',
  maxWorkers: 1,
  timeoutMs: 1000,
  sandbox: { denyRead: [], allowRead: [] },
});

const githubSpec = (runId: string, mergeId: string): FullTestSpec => ({
  ...fullSpec(runId, 'github-actions:acme/web'),
  githubActions: {
    ref: { projectKey: 'PM', repo: 'projectman' },
    mergeId,
    repo: 'acme/web',
    base: 'main',
    commit: 'a'.repeat(40),
    workflow: 'merge-check.yml',
  },
});

function fullTestHarness(
  run: FullTestExecutor['run'] = async () => passed,
  options: { now?: () => number; worktreesRoot?: string | null } = {},
) {
  const registered = new Map<string, (params: unknown, context: { id: string }) => Promise<unknown>>();
  const checkoutForCheck = vi.fn(async () => ({ path: checkCwd, gitDir: '/fictional/git' }));
  const releaseCheck = vi.fn(async () => {});
  const info = vi.fn();
  const warn = vi.fn();
  const service = createEngineHandlers({
    limit: { check: async (_method: string, params: unknown) => params } as never,
    audit: { record: () => undefined } as never,
    runner: {} as never,
    transcripts: {} as never,
    planUsageFor: (() => ({})) as never,
    engine: {
      fullTestExecutor: { run },
      paths: () => ({
        worktreesRoot: options.worktreesRoot === undefined ? checkRoot : options.worktreesRoot,
      }),
      merger: { checkoutForCheck, releaseCheck },
    } as never,
    github: {} as never,
    probe: {} as never,
    transfers: {} as never,
    mcpBase: 'http://127.0.0.1:4801',
    emit: () => undefined,
    terminals: new Set(),
    exportDir: '/nonexistent',
    now: options.now,
    logger: { info, warn },
  });
  service.register({
    handle: (method: string, handler: never) => {
      registered.set(method, handler);
      return () => undefined;
    },
  } as unknown as EngineRpc);
  const call = <M extends EngineMethod>(method: M, params: MethodParams<M>) =>
    registered.get(method)!(params, { id: 'request' }) as Promise<MethodResult<M>>;
  return { call, service, checkoutForCheck, releaseCheck, info, warn };
}

describe('engine handlers', () => {
  it.each([-1, 1.5, NaN])('rejects invalid scope retry age %s at the RPC boundary', (sinceAgeMs) => {
    expect(
      methods['session.close_scopes'].params.safeParse({
        scopes: [{ sessionId: 'session-1', scopeId: 'scp_0123456789abcdef', sinceAgeMs }],
      }).success,
    ).toBe(false);
  });
  it('carries the full-mode flag of a GitHub Actions check over the RPC boundary (PM-909)', () => {
    const spec = githubSpec('github', 'mrg_12345678');
    const parse = (all: boolean | undefined) =>
      methods['full_test.run'].params.safeParse({
        spec: { ...spec, githubActions: { ...spec.githubActions!, ...(all === undefined ? {} : { all }) } },
      });
    for (const all of [true, false, undefined]) {
      const parsed = parse(all);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.spec.githubActions?.all).toBe(all);
    }
    // The schema is strict: an engine built before the flag refuses it, which the host reports as github_unavailable.
    expect(
      methods['full_test.run'].params.safeParse({
        spec: { ...spec, githubActions: { ...spec.githubActions!, other: true } },
      }).success,
    ).toBe(false);
  });

  const registered = () => {
    const names: string[] = [];
    const rpc = {
      handle: (method: string) => {
        names.push(method);
        return () => undefined;
      },
    } as unknown as EngineRpc;
    createEngineHandlers({
      limit: {} as never,
      audit: { record: () => undefined } as never,
      runner: {} as never,
      transcripts: {} as never,
      planUsageFor: (() => ({})) as never,
      engine: {} as never,
      github: {} as never,
      probe: {} as never,
      transfers: {} as never,
      mcpBase: 'http://127.0.0.1:4801',
      emit: () => undefined,
      terminals: new Set(),
      exportDir: '/nonexistent',
    }).register(rpc);
    return names;
  };

  it('answers every method the engine is the receiver of, and no method of the cloud', () => {
    const names = registered();
    const engineMethods = (Object.keys(methods) as EngineMethod[]).filter(
      (name) => methods[name].direction === 'engine',
    );
    expect(engineMethods.length).toBeGreaterThan(40);
    expect(names.sort()).toEqual(engineMethods.sort());
  });

  it('tells the cloud when a full test gets its turn, by the run id', async () => {
    const handlers = new Map<string, (params: unknown, context: unknown) => Promise<unknown>>();
    const rpc = {
      handle: (method: string, handler: never) => {
        handlers.set(method, handler);
        return () => undefined;
      },
    } as unknown as EngineRpc;
    const events: unknown[] = [];
    const result = { outcome: 'passed', exitCode: 0, durationMs: 1, failedFiles: [], outputTail: '' };
    const executor = {
      run: async (_spec: unknown, _signal: AbortSignal, onStarted?: () => void) => {
        events.push('before');
        onStarted?.();
        return result;
      },
    };
    createEngineHandlers({
      limit: { check: async (_method: string, params: unknown) => params } as never,
      audit: { record: () => undefined } as never,
      runner: {} as never,
      transcripts: {} as never,
      planUsageFor: (() => ({})) as never,
      engine: { fullTestExecutor: executor } as never,
      github: {} as never,
      probe: {} as never,
      transfers: {} as never,
      mcpBase: 'http://127.0.0.1:4801',
      emit: (event: unknown) => void events.push(event),
      terminals: new Set(),
      exportDir: '/nonexistent',
    }).register(rpc);
    await expect(handlers.get('full_test.run')!({ spec: { runId: 'f9' } }, { id: 'r1' })).resolves.toEqual(
      result,
    );
    expect(events).toEqual(['before', { kind: 'full_test_started', runId: 'f9' }]);
  });

  it('answers a full test cancel only when the run has ended and cleaned up (PM-681)', async () => {
    const handlers = new Map<string, (params: unknown, context: unknown) => Promise<unknown>>();
    const rpc = {
      handle: (method: string, handler: never) => {
        handlers.set(method, handler);
        return () => undefined;
      },
    } as unknown as EngineRpc;
    const log: string[] = [];
    let finishCleanup: () => void = () => {};
    const executor = {
      run: (_spec: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            log.push('aborted');
            finishCleanup = () => {
              log.push('cleaned');
              resolve({ outcome: 'error', reason: 'killed', exitCode: null });
            };
          });
        }),
    };
    createEngineHandlers({
      limit: { check: async (_method: string, params: unknown) => params } as never,
      audit: { record: () => undefined } as never,
      runner: {} as never,
      transcripts: {} as never,
      planUsageFor: (() => ({})) as never,
      engine: { fullTestExecutor: executor } as never,
      github: {} as never,
      probe: {} as never,
      transfers: {} as never,
      mcpBase: 'http://127.0.0.1:4801',
      emit: () => undefined,
      terminals: new Set(),
      exportDir: '/nonexistent',
    }).register(rpc);
    const run = handlers.get('full_test.run')!({ spec: { runId: 'f8' } }, { id: 'r1' });
    const cancel = handlers.get('full_test.cancel')!({ runId: 'f8' }, { id: 'r2' }).then(() => {
      log.push('cancel answered');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['aborted']);
    finishCleanup();
    await cancel;
    await run;
    expect(log).toEqual(['aborted', 'cleaned', 'cancel answered']);
    // A run that is gone answers at once.
    await expect(handlers.get('full_test.cancel')!({ runId: 'f8' }, { id: 'r3' })).resolves.toBeNull();
  });

  it('lists exactly the cloud-direction methods as the ones the engine does not answer', () => {
    const cloudMethods = (Object.keys(methods) as EngineMethod[]).filter(
      (name) => methods[name].direction === 'cloud',
    );
    expect([...CLOUD_METHODS].sort()).toEqual(cloudMethods.sort());
  });

  describe('full test results', () => {
    it('lets multiple attachments wait for the same running test and retains its result', async () => {
      const started = deferred<void>();
      const ended = deferred<FullTestResult>();
      const { call } = fullTestHarness(() => {
        started.resolve();
        return ended.promise;
      });
      const run = call('full_test.run', { spec: fullSpec('running') });
      await started.promise;
      const answered = vi.fn();
      const attachments = Array.from({ length: 2 }, () =>
        call('full_test.attach', { runId: 'running' }).then((result) => {
          answered();
          return result;
        }),
      );
      await Promise.resolve();
      expect(answered).not.toHaveBeenCalled();
      ended.resolve(passed);
      await expect(run).resolves.toEqual(passed);
      for (const attachment of attachments)
        await expect(attachment).resolves.toEqual({ state: 'ended', result: passed });
      await expect(call('full_test.attach', { runId: 'running' })).resolves.toEqual({
        state: 'ended',
        result: passed,
      });
    });

    it('returns completed results immediately without consuming them', async () => {
      const { call } = fullTestHarness();
      await call('full_test.run', { spec: fullSpec('completed') });
      for (let i = 0; i < 2; i++)
        await expect(call('full_test.attach', { runId: 'completed' })).resolves.toEqual({
          state: 'ended',
          result: passed,
        });
      await expect(call('full_test.attach', { runId: 'missing' })).resolves.toEqual({ state: 'unknown' });
    });

    it('keeps the step report out of the run and attach answers and gives it with full_test.report (PM-876)', async () => {
      const report = { scope: 'all' as const, workers: 2, commandMs: 5, steps: [] };
      const { call } = fullTestHarness(async () => ({ ...passed, report }));
      await expect(call('full_test.run', { spec: fullSpec('measured') })).resolves.toEqual(passed);
      await expect(call('full_test.attach', { runId: 'measured' })).resolves.toEqual({
        state: 'ended',
        result: passed,
      });
      await expect(call('full_test.report', { runId: 'measured' })).resolves.toEqual({
        state: 'ended',
        report,
      });
    });

    it('keeps the run page of a GitHub Actions run in the run and attach answers (PM-900)', async () => {
      const result = { ...passed, externalUrl: 'https://github.com/acme/web/actions/runs/7' };
      const { call } = fullTestHarness(async () => result);
      await expect(call('full_test.run', { spec: githubSpec('github', 'mrg_1') })).resolves.toEqual(result);
      await expect(call('full_test.attach', { runId: 'github' })).resolves.toEqual({
        state: 'ended',
        result,
      });
    });

    it('answers full_test.report with a null report for a run that measured nothing, unknown for a missing run', async () => {
      const { call } = fullTestHarness();
      await call('full_test.run', { spec: fullSpec('plain') });
      await expect(call('full_test.report', { runId: 'plain' })).resolves.toEqual({
        state: 'ended',
        report: null,
      });
      await expect(call('full_test.report', { runId: 'missing' })).resolves.toEqual({ state: 'unknown' });
    });

    it('keeps a run across link closure and attaches through a replacement RPC connection', async () => {
      const started = deferred<void>();
      const ended = deferred<FullTestResult>();
      let signal!: AbortSignal;
      const { service } = fullTestHarness((_spec, runSignal) => {
        signal = runSignal;
        started.resolve();
        return ended.promise;
      });
      const oldRpc = createEngineRpc({ side: 'engine', state: createRpcState(), send: () => {} });
      service.register(oldRpc);
      const original = oldRpc.receive({
        t: 'req',
        id: 'original',
        method: 'full_test.run',
        params: { spec: fullSpec('reconnect') },
      });
      await started.promise;
      oldRpc.close();
      expect(signal.aborted).toBe(false);
      const sent: unknown[] = [];
      const newRpc = createEngineRpc({
        side: 'engine',
        state: createRpcState(),
        send: (frame) => sent.push(decodeFrame(frame)),
      });
      service.register(newRpc);
      const attachment = newRpc.receive({
        t: 'req',
        id: 'reattach',
        method: 'full_test.attach',
        params: { runId: 'reconnect' },
      });
      ended.resolve(passed);
      await Promise.all([original, attachment]);
      expect(sent).toEqual([
        { t: 'res', id: 'reattach', ok: true, result: { state: 'ended', result: passed } },
      ]);
      newRpc.close();
    });

    it.each([false, true])(
      'preserves executor errors for attach (synchronous throw: %s)',
      async (synchronous) => {
        const error = new Error('Executor failed');
        const { call, warn } = fullTestHarness(() => {
          if (synchronous) throw error;
          return Promise.reject(error);
        });
        await expect(call('full_test.run', { spec: fullSpec('failed') })).rejects.toBe(error);
        // The cause is logged on the engine, since the hub sees only a code (PM-915).
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: error, method: 'full_test.run' }),
          expect.any(String),
        );
        for (let i = 0; i < 2; i++)
          await expect(call('full_test.attach', { runId: 'failed' })).rejects.toBe(error);
        await call('full_test.cancel', { runId: 'failed' });
        await expect(call('full_test.attach', { runId: 'failed' })).resolves.toEqual({ state: 'unknown' });
      },
    );

    it('forgets a cancelled run only after its executor has cleaned up', async () => {
      const started = deferred<void>();
      const aborted = deferred<void>();
      const ended = deferred<FullTestResult>();
      const { call } = fullTestHarness((_spec, signal) => {
        signal.addEventListener('abort', () => aborted.resolve());
        started.resolve();
        return ended.promise;
      });
      const run = call('full_test.run', { spec: fullSpec('cancelled') });
      await started.promise;
      const attachment = call('full_test.attach', { runId: 'cancelled' });
      const answered = vi.fn();
      const cancel = call('full_test.cancel', { runId: 'cancelled' }).then(answered);
      await aborted.promise;
      expect(answered).not.toHaveBeenCalled();
      const killed: FullTestResult = { ...passed, outcome: 'error', reason: 'killed', exitCode: null };
      ended.resolve(killed);
      await Promise.all([run, cancel]);
      await expect(attachment).resolves.toEqual({ state: 'ended', result: killed });
      await expect(call('full_test.attach', { runId: 'cancelled' })).resolves.toEqual({ state: 'unknown' });
    });

    it('expires results exactly 60 minutes after completion and never expires an active run', async () => {
      let at = 0;
      const started = deferred<void>();
      const ended = deferred<FullTestResult>();
      const { call } = fullTestHarness(
        () => {
          started.resolve();
          return ended.promise;
        },
        { now: () => at },
      );
      const run = call('full_test.run', { spec: fullSpec('expiry') });
      await started.promise;
      at = 60 * 60_000;
      const attachment = call('full_test.attach', { runId: 'expiry' });
      ended.resolve(passed);
      await expect(attachment).resolves.toEqual({ state: 'ended', result: passed });
      await run;
      at += 60 * 60_000 - 1;
      await expect(call('full_test.attach', { runId: 'expiry' })).resolves.toMatchObject({ state: 'ended' });
      at++;
      await expect(call('full_test.attach', { runId: 'expiry' })).resolves.toEqual({ state: 'unknown' });
    });

    it('keeps 32 completed results and evicts by completion time, leaving active runs alone', async () => {
      let at = 0;
      const started = deferred<void>();
      const ended = deferred<FullTestResult>();
      const { call } = fullTestHarness(
        (spec) => {
          if (spec.runId !== 'slow') return Promise.resolve(passed);
          started.resolve();
          return ended.promise;
        },
        { now: () => at },
      );
      const slow = call('full_test.run', { spec: fullSpec('slow') });
      await started.promise;
      for (let i = 1; i <= 32; i++) {
        at = i;
        await call('full_test.run', { spec: fullSpec(`run-${i}`) });
      }
      for (let i = 1; i <= 32; i++)
        await expect(call('full_test.attach', { runId: `run-${i}` })).resolves.toMatchObject({
          state: 'ended',
        });
      const slowAttachment = call('full_test.attach', { runId: 'slow' });
      at++;
      ended.resolve(passed);
      await slow;
      await expect(slowAttachment).resolves.toMatchObject({ state: 'ended' });
      await expect(call('full_test.attach', { runId: 'run-1' })).resolves.toEqual({ state: 'unknown' });
      for (let i = 2; i <= 32; i++)
        await expect(call('full_test.attach', { runId: `run-${i}` })).resolves.toMatchObject({
          state: 'ended',
        });
      await expect(call('full_test.attach', { runId: 'slow' })).resolves.toMatchObject({ state: 'ended' });
    });

    it('clears completed and active records on disposal without restoring them when runs end', async () => {
      const started = deferred<void>();
      const ended = deferred<FullTestResult>();
      let signal!: AbortSignal;
      const { call, service } = fullTestHarness((spec, runSignal) => {
        if (spec.runId === 'completed') return Promise.resolve(passed);
        signal = runSignal;
        started.resolve();
        return ended.promise;
      });
      await call('full_test.run', { spec: fullSpec('completed') });
      const run = call('full_test.run', { spec: fullSpec('active') });
      await started.promise;
      service.dispose();
      expect(signal.aborted).toBe(true);
      for (const runId of ['completed', 'active'])
        await expect(call('full_test.attach', { runId })).resolves.toEqual({ state: 'unknown' });
      ended.resolve(passed);
      await run;
      await expect(call('full_test.attach', { runId: 'active' })).resolves.toEqual({ state: 'unknown' });
    });
  });

  describe('merge check checkout protection', () => {
    it.each(['merge.checkout_for_check', 'merge.release_check'] as const)(
      '%s aborts all matching runs and waits for their cleanup, including rejected runs',
      async (method) => {
        const worktreesRoot = await temporaryCheckRoot();
        const checkCwd = path.join(worktreesRoot, '_merge', 'mrg_1');
        const specs = [
          fullSpec('root', checkCwd),
          fullSpec('child', `${checkCwd}/src/../..x`),
          fullSpec('other-merge', `${worktreesRoot}/_merge/mrg_2`),
          fullSpec('prefix', `${checkCwd}-other`),
          fullSpec('outside', `${checkCwd}/../outside`),
        ];
        const runs = new Map(specs.map((spec) => [spec.runId, deferred<FullTestResult>()]));
        const signals = new Map<string, AbortSignal>();
        const bothAborted = deferred<void>();
        let aborts = 0;
        const { call, checkoutForCheck, releaseCheck, info } = fullTestHarness(
          (spec, signal) => {
            signals.set(spec.runId, signal);
            signal.addEventListener('abort', () => {
              if (++aborts === 2) bothAborted.resolve();
            });
            return runs.get(spec.runId)!.promise;
          },
          { worktreesRoot },
        );
        const allRuns = Promise.allSettled(specs.map((spec) => call('full_test.run', { spec })));
        const ref = { projectKey: 'PM', repo: 'projectman' };
        const operation = call(
          method,
          method === 'merge.checkout_for_check'
            ? { ref, mergeId: 'mrg_1', mergeCommit: 'a'.repeat(40), depsFrom: null }
            : { ref, mergeId: 'mrg_1' },
        );
        await bothAborted.promise;
        expect(signals.get('root')!.aborted).toBe(true);
        expect(signals.get('child')!.aborted).toBe(true);
        for (const runId of ['other-merge', 'prefix', 'outside'])
          expect(signals.get(runId)!.aborted).toBe(false);
        expect(checkoutForCheck).not.toHaveBeenCalled();
        expect(releaseCheck).not.toHaveBeenCalled();
        runs.get('root')!.resolve(passed);
        await call('full_test.attach', { runId: 'root' });
        expect(checkoutForCheck).not.toHaveBeenCalled();
        expect(releaseCheck).not.toHaveBeenCalled();
        runs.get('child')!.reject(new Error('Cleanup failed'));
        await operation;
        expect(method === 'merge.checkout_for_check' ? checkoutForCheck : releaseCheck).toHaveBeenCalledTimes(
          1,
        );
        expect(info.mock.calls).toEqual(
          ['root', 'child'].map((runId) => [
            { runId, mergeId: 'mrg_1' },
            'engine: stopped a full test still running in a merge check checkout',
          ]),
        );
        for (const runId of ['root', 'child'])
          await expect(call('full_test.attach', { runId })).resolves.toEqual({ state: 'unknown' });
        for (const runId of ['other-merge', 'prefix', 'outside']) runs.get(runId)!.resolve(passed);
        await allRuns;
      },
    );

    it.each([true, false])(
      'merge.release_check stops a GitHub Actions run of the merge by its mergeId (worktrees root: %s)',
      async (hasRoot) => {
        const started = deferred<void>();
        const aborted = deferred<void>();
        const ended = deferred<FullTestResult>();
        const { call, releaseCheck, info } = fullTestHarness(
          (_spec, signal) => {
            signal.addEventListener('abort', () => aborted.resolve());
            started.resolve();
            return ended.promise;
          },
          hasRoot ? {} : { worktreesRoot: null },
        );
        const other = call('full_test.run', { spec: githubSpec('other-merge', 'mrg_2') });
        const run = call('full_test.run', { spec: githubSpec('github', 'mrg_1') });
        await started.promise;
        const operation = call('merge.release_check', {
          ref: { projectKey: 'PM', repo: 'projectman' },
          mergeId: 'mrg_1',
        });
        await aborted.promise;
        expect(releaseCheck).not.toHaveBeenCalled();
        ended.resolve(passed);
        await operation;
        expect(releaseCheck).toHaveBeenCalledTimes(1);
        expect(info.mock.calls).toEqual([
          [{ runId: 'github', mergeId: 'mrg_1' }, expect.stringContaining('stopped a full test')],
        ]);
        await expect(call('full_test.attach', { runId: 'github' })).resolves.toEqual({ state: 'unknown' });
        await Promise.all([run, other]);
      },
    );

    it.each([
      ['merge.checkout_for_check', 'canonical'],
      ['merge.checkout_for_check', 'configured'],
      ['merge.release_check', 'canonical'],
      ['merge.release_check', 'configured'],
    ] as const)(
      '%s resolves a symlinked engine home before stopping a check run with a %s cwd',
      async (method, cwdForm) => {
        const directory = await temporaryCheckRoot();
        const engineHome = path.join(directory, 'engine');
        const worktreesRoot = path.join(engineHome, 'worktrees');
        const linkedHome = path.join(directory, 'linked-engine');
        await mkdir(worktreesRoot, { recursive: true });
        await symlink(engineHome, linkedHome, 'dir');
        const started = deferred<void>();
        const aborted = deferred<void>();
        const ended = deferred<FullTestResult>();
        const { call, checkoutForCheck, releaseCheck } = fullTestHarness(
          (_spec, signal) => {
            signal.addEventListener('abort', () => aborted.resolve());
            started.resolve();
            return ended.promise;
          },
          { worktreesRoot: path.join(linkedHome, 'worktrees') },
        );
        // checkoutForCheck returns a realpath, even when the engine home was configured via a link.
        const cwd = path.join(
          cwdForm === 'canonical' ? await realpath(worktreesRoot) : path.join(linkedHome, 'worktrees'),
          '_merge',
          'mrg_1',
        );
        const run = call('full_test.run', { spec: fullSpec('symlinked', cwd) });
        await started.promise;
        const ref = { projectKey: 'PM', repo: 'projectman' };
        const operation = call(
          method,
          method === 'merge.checkout_for_check'
            ? { ref, mergeId: 'mrg_1', mergeCommit: 'a'.repeat(40), depsFrom: null }
            : { ref, mergeId: 'mrg_1' },
        );
        try {
          await expect(
            Promise.race([aborted.promise.then(() => 'aborted'), operation.then(() => 'checkout changed')]),
          ).resolves.toBe('aborted');
          expect(checkoutForCheck).not.toHaveBeenCalled();
          expect(releaseCheck).not.toHaveBeenCalled();
          ended.resolve(passed);
          await operation;
          expect(
            method === 'merge.checkout_for_check' ? checkoutForCheck : releaseCheck,
          ).toHaveBeenCalledOnce();
          await expect(call('full_test.attach', { runId: 'symlinked' })).resolves.toEqual({
            state: 'unknown',
          });
        } finally {
          ended.resolve(passed);
          await Promise.all([run, operation]);
        }
      },
    );

    it('does nothing to active tests when the engine has no worktrees root', async () => {
      const started = deferred<void>();
      const ended = deferred<FullTestResult>();
      let signal!: AbortSignal;
      const { call, checkoutForCheck, releaseCheck, info } = fullTestHarness(
        (_spec, runSignal) => {
          signal = runSignal;
          started.resolve();
          return ended.promise;
        },
        { worktreesRoot: null },
      );
      const run = call('full_test.run', { spec: fullSpec('active') });
      await started.promise;
      const ref = { projectKey: 'PM', repo: 'projectman' };
      await call('merge.checkout_for_check', {
        ref,
        mergeId: 'mrg_1',
        mergeCommit: 'a'.repeat(40),
        depsFrom: null,
      });
      await call('merge.release_check', { ref, mergeId: 'mrg_1' });
      expect(checkoutForCheck).toHaveBeenCalledOnce();
      expect(releaseCheck).toHaveBeenCalledOnce();
      expect(signal.aborted).toBe(false);
      expect(info).not.toHaveBeenCalled();
      ended.resolve(passed);
      await run;
    });
  });

  it('reports only heavy runs belonging to this runner and validates the reply', async () => {
    const handlers = new Map<string, (params: unknown, context: unknown) => Promise<unknown>>();
    const rpc = {
      handle: (name: string, handler: never) => {
        handlers.set(name, handler);
        return () => undefined;
      },
    } as unknown as EngineRpc;
    createEngineHandlers({
      limit: { check: async (_method: string, params: unknown) => params } as never,
      audit: { record: () => undefined } as never,
      runner: { list: () => [{ sessionId: 'own' }] } as never,
      transcripts: {} as never,
      planUsageFor: (() => ({})) as never,
      engine: { heavyRunSessions: async () => ['own', 'other'] } as never,
      github: {} as never,
      probe: {} as never,
      transfers: {} as never,
      mcpBase: 'http://127.0.0.1:4801',
      emit: () => undefined,
      terminals: new Set(),
      exportDir: '/nonexistent',
    }).register(rpc);
    const result = await handlers.get('host.heavy_run_sessions')!({}, { id: 'heavy' });
    expect(result).toEqual(['own']);
    expect(methods['host.heavy_run_sessions'].result.parse(result)).toEqual(['own']);
  });
});
