import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMergeId } from '@projectman/shared';
import type {
  FullTestExecutor,
  FullTestResult,
  BranchMerger,
  EngineDirectory,
  MergeBaseState,
} from '../../contracts';
import { EngineLinkLostError } from '../../contracts';
import { LocalEngineDirectory } from '../../runtime/sessions';
import { createCloudRemote } from '../../engine-link/remote';
import type { CloudRemote } from '../../engine-link/remote';
import { createFakeCloud } from '../../engine-link/remote/test-support';
import { aiActor } from '../../kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR } from '../../../test/helpers/domain-harness';
import type { DomainHarness } from '../../../test/helpers/domain-harness';
import { pullRequest } from '../../../test/helpers/fakes';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const passed: FullTestResult = {
  outcome: 'passed',
  exitCode: 0,
  durationMs: 1,
  failedFiles: [],
  outputTail: '',
};
const reviewTest = { command: 'npm run merge-test', maxWorkers: 2, timeoutMinutes: 10 };

function fakeMerger(remote = true) {
  const parents = new Map<string, string[]>();
  const ancestor = (a: string, c: string, seen = new Set<string>()): boolean => {
    if (a === c) return true;
    if (seen.has(c)) return false;
    seen.add(c);
    return (parents.get(c) ?? []).some((p) => ancestor(a, p, seen));
  };
  let serial = 100;
  const base: MergeBaseState = {
    local: sha(0),
    remote: remote ? { name: 'origin', commit: sha(0) } : null,
    relation: 'same',
    contains: { local: false, remote: remote ? false : null },
    checkout: null,
  };
  return {
    base,
    parents,
    prepare: vi.fn<BranchMerger['prepare']>(async () => structuredClone(base)),
    isAncestor: vi.fn<BranchMerger['isAncestor']>(async (_ref, input) =>
      ancestor(input.ancestor, input.commit),
    ),
    build: vi.fn<BranchMerger['build']>(async (_ref, input) => {
      const mergeCommit = sha(serial++);
      parents.set(mergeCommit, [input.onto, input.commit]);
      return { ok: true, mergeCommit, changed: ['early.ts', 'last.ts'] };
    }),
    checkoutConflicts: vi.fn<BranchMerger['checkoutConflicts']>(async () => []),
    checkoutForCheck: vi.fn<BranchMerger['checkoutForCheck']>(async () => ({
      path: '/fake/check',
      gitDir: '/fake/git',
    })),
    releaseCheck: vi.fn<BranchMerger['releaseCheck']>(async () => {}),
    push: vi.fn<BranchMerger['push']>(async (_ref, input) => {
      base.remote = { name: 'origin', commit: input.mergeCommit };
      return { ok: true };
    }),
    commitRegenerated: vi.fn(),
    remoteTags: vi.fn(),
    pushTag: vi.fn(),
    advance: vi.fn<BranchMerger['advance']>(async (_ref, input) => {
      base.local = input.to;
      return { ok: true };
    }),
    readFile: vi.fn(),
    commitFiles: vi.fn(),
    listPaths: vi.fn(),
    changedPaths: vi.fn(),
  };
}

describe('merge train execution', () => {
  let h: DomainHarness;
  let merger: ReturnType<typeof fakeMerger>;
  let executor: FullTestExecutor;
  let peerBusy: boolean;
  let engines: EngineDirectory;
  let remoteCheck: CloudRemote | undefined;
  const row = (key: string) => h.repos.taskMerges.open('AR', key);
  const settled = () => vi.waitFor(() => expect(h.domain.merges.busy('AR', 'web')).toBe(false));
  async function setup(count = 2, remote = true, filesCommand?: string, github?: string) {
    merger = fakeMerger(remote);
    executor = {
      available: vi.fn(async () => ({ ok: true as const })),
      run: vi.fn(async (_spec, _signal, started) => {
        started?.();
        return passed;
      }),
    };
    const getEngine = vi.spyOn(LocalEngineDirectory.prototype, 'get');
    h = await createDomainHarness({
      merger,
      fullTestExecutor: executor,
      adjust(config) {
        for (const member of config.team.members)
          if (member.kind === 'ai' && member.handle.startsWith('dev-')) member.capacity = 5;
        config.team.limits.maxConcurrentAi = 20;
        config.team.merger = { kind: 'developer' };
        config.project.repos[0]!.requireMerge = true;
        config.project.repos[0]!.reviewTest = filesCommand ? { ...reviewTest, filesCommand } : reviewTest;
        if (github) {
          const repo = config.project.repos[0]!;
          repo.reviewTest = { ...repo.reviewTest!, runner: 'github_actions' };
          repo.github = github;
        }
        config.pipeline.stages = config.pipeline.stages.filter((s) => s.id !== 'merge' && s.id !== 'release');
        config.pipeline.stages.find((s) => s.id === 'done')!.gate = {
          conditions: [{ type: 'has_label', label: 'code-review-ok' }],
        };
      },
    });
    engines = getEngine.mock.contexts[0] as EngineDirectory;
    getEngine.mockRestore();
    vi.spyOn(h.domain.autoAdvance, 'check').mockResolvedValue(undefined);
    peerBusy = true;
    h.domain.merges.registerSlotPeer({ busy: () => peerBusy, pump: () => {} });
    for (let i = 1; i <= count; i++) {
      const key = `AR-${i}`;
      const assignee = i % 2 ? 'dev-1' : 'dev-2';
      await h.domain.tasks.create('AR', { title: `Card ${i}`, repo: 'web' }, OWNER_ACTOR);
      await h.domain.taskStarts.start('AR', key, { assignee, actor: OWNER_ACTOR, author: OWNER });
      const tree = h.worktrees.existing.get(`AR/${key}/web`)!;
      h.repos.taskHandovers.save({
        projectKey: 'AR',
        taskKey: key,
        commit: sha(i),
        branch: tree.branch,
        stageId: 'code_review',
        at: new Date().toISOString(),
      });
      h.repos.tasks.update(h.domain.tasks.get('AR', key).id, {
        stageId: 'code_review',
        labels: ['code-review-ok'],
      });
      await h.domain.merges.start('AR', key, aiActor(assignee));
    }
  }
  const pump = () => {
    peerBusy = false;
    h.domain.merges.pump();
  };
  afterEach(async () => {
    if (h) await h.cleanup();
    remoteCheck?.close();
    remoteCheck = undefined;
  });

  it.each(['run', 'attach'] as const)(
    'blocks a train handler error during %s without retrying or splitting',
    async (phase) => {
      await setup();
      const cloud = createFakeCloud();
      remoteCheck = createCloudRemote({
        links: cloud.links,
        registry: cloud.registry,
        recordedEngine: () => null,
        recordedProject: () => null,
        spoolDir: `${h.dir}/refused-train-spool`,
        logger: h.log.logger,
      });
      const refusal = () => {
        throw Object.assign(new Error('fixture failure'), { code: 'internal' });
      };
      const engine = cloud.connect('eng_a' as never);
      engine.answer('full_test.run', phase === 'run' ? refusal : () => new Promise(() => {}));
      const remoteExecutor = remoteCheck.directory.host(engine.id)!.fullTestExecutor!;
      vi.mocked(executor.run).mockImplementation((...args) => remoteExecutor.run(...args));
      engines.awaitConnected = vi.fn(async () => 'connected' as const);
      pump();
      if (phase === 'attach') {
        await vi.waitFor(() =>
          expect(engine.requests.some((request) => request.method === 'full_test.run')).toBe(true),
        );
        engine.disconnect();
        await vi.waitFor(() => expect(row('AR-1')?.step).toBe('engine_waiting'));
        cloud.connect(engine.id, {
          prepare(next) {
            next.answer('full_test.attach', refusal);
          },
        });
      }
      await vi.waitFor(() => expect(row('AR-1')?.state).toBe('blocked'));
      await settled();
      for (const key of ['AR-1', 'AR-2']) {
        expect(row(key)?.block?.reason).toBe('check_error');
        expect(row(key)?.diagnostic).toBeUndefined();
      }
      expect(executor.run).toHaveBeenCalledTimes(1);
      expect(merger.build).toHaveBeenCalledTimes(3);
      expect(merger.push).not.toHaveBeenCalled();
      expect(engines.awaitConnected).not.toHaveBeenCalled();
    },
  );

  it.each([2, 8])(
    'checks, pushes and advances %i members once, preserving each actor and every source',
    async (count) => {
      await setup(count);
      pump();
      await vi.waitFor(() => expect(h.domain.tasks.get('AR', `AR-${count}`).merged).toBeDefined());
      await settled();
      expect(executor.run).toHaveBeenCalledTimes(1);
      expect(executor.run).toHaveBeenCalledWith(
        expect.objectContaining({ command: reviewTest.command, requireHeavyLock: true }),
        expect.anything(),
        expect.any(Function),
        expect.objectContaining({ linkWaitMs: 900_000, onLinkWait: expect.any(Function) }),
      );
      expect(merger.push).toHaveBeenCalledTimes(1);
      expect(merger.advance).toHaveBeenCalledTimes(1);
      expect(merger.checkoutForCheck).toHaveBeenCalledTimes(1);
      expect(merger.releaseCheck).toHaveBeenCalledTimes(1);
      const candidate = merger.base.local;
      expect(merger.parents.get(candidate)?.[0]).toBe(sha(0));
      const runIds = new Set<string>();
      for (let i = 1; i <= count; i++) {
        const key = `AR-${i}`;
        const task = h.domain.tasks.get('AR', key);
        expect(task.merged?.mergeCommit).toBe(candidate);
        runIds.add(task.merged!.check!.runId!);
        expect(
          await merger.isAncestor({ projectKey: 'AR', repo: 'web' }, { ancestor: sha(i), commit: candidate }),
        ).toBe(true);
        const events = h.domain.timeline.list('AR', { taskKey: key }).filter((e) => e.type === 'task_merged');
        expect(events).toHaveLength(1);
        expect(events[0]?.actor).toEqual(aiActor(i % 2 ? 'dev-1' : 'dev-2'));
      }
      expect(runIds.size).toBe(1);
      const firstMerge = h.repos.taskMerges.latestMerged('AR', 'AR-1')!;
      expect(h.repos.mergeTrains.get(firstMerge.trainId!)?.landed).toBe('remote');
      expect(h.repos.mergeTrains.listRunning()).toEqual([]);
    },
  );

  it('prepares missing candidate dependencies before checking and merging a train', async () => {
    await setup();
    merger.checkoutForCheck.mockImplementation(async (_ref, input) => {
      if (!input.allowDependencyInstall) throw new Error('No installed checkout matches the merged lockfile');
      return { path: '/fake/check', gitDir: '/fake/git', dependencyInstallRequired: true };
    });
    vi.mocked(executor.run).mockImplementation(async (spec, _signal, started) => {
      const [ref, input] = merger.checkoutForCheck.mock.calls.at(-1)!;
      expect(spec).toMatchObject({
        cwd: '/fake/check',
        requireHeavyLock: true,
        npmCi: { ref, mergeId: input.mergeId },
      });
      started?.();
      return passed;
    });
    pump();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
    await settled();
    expect(h.domain.tasks.get('AR', 'AR-1').merged).toBeDefined();
    expect(executor.run).toHaveBeenCalledTimes(1);
    expect(merger.releaseCheck).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'keeps only member rows waiting during a disconnected group check (started: %s)',
    async (started) => {
      await setup();
      let reconnect!: () => void;
      let restored: string | undefined;
      vi.mocked(executor.run).mockImplementationOnce(async (_spec, _signal, onStarted, options) => {
        if (started) onStarted?.();
        options!.onLinkWait!(true);
        await new Promise<void>((resolve) => {
          reconnect = resolve;
        });
        // The engine can replay a start event before attach returns.
        if (!started) onStarted?.();
        expect(row('AR-1')?.step).toBe('engine_waiting');
        options!.onLinkWait!(false);
        restored = row('AR-1')?.step;
        return passed;
      });
      const save = h.repos.mergeTrains.save;
      const steps: string[] = [];
      vi.spyOn(h.repos.mergeTrains, 'save').mockImplementation((train) => {
        steps.push(train.step);
        return save(train);
      });
      pump();
      await vi.waitFor(() => expect(row('AR-1')?.step).toBe('engine_waiting'));
      expect(row('AR-2')?.step).toBe('engine_waiting');
      expect(h.repos.mergeTrains.listRunning()[0]?.step).toBe(started ? 'checking' : 'check_waiting');
      expect(h.domain.merges.busy('AR', 'web')).toBe(true);
      reconnect();
      await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
      await settled();
      expect(restored).toBe('checking');
      expect(steps).not.toContain('engine_waiting');
      expect(executor.run).toHaveBeenCalledTimes(1);
      expect(merger.push).toHaveBeenCalledTimes(1);
    },
  );

  it('restarts a train after a lost check and blocks the sixth loss without splitting', async () => {
    await setup();
    vi.mocked(executor.run).mockResolvedValue({ ...passed, outcome: 'error', reason: 'engine_offline' });
    engines.awaitConnected = vi.fn(async () => 'connected' as const);
    pump();
    await vi.waitFor(() => expect(row('AR-1')?.state).toBe('blocked'));
    await settled();
    for (const key of ['AR-1', 'AR-2']) {
      expect(row(key)?.block?.reason).toBe('engine_offline');
      expect(row(key)?.diagnostic).toBeUndefined();
    }
    expect(executor.run).toHaveBeenCalledTimes(6);
    expect(engines.awaitConnected).toHaveBeenCalledTimes(5);
    expect(engines.awaitConnected).toHaveBeenCalledWith(expect.anything(), 0, expect.any(AbortSignal));
    expect(merger.push).not.toHaveBeenCalled();
  });

  it('restarts a train after a merger call loses its link', async () => {
    await setup();
    merger.build.mockRejectedValueOnce(new EngineLinkLostError('disconnected'));
    let reconnect!: (back: 'connected') => void;
    engines.awaitConnected = vi.fn(
      () =>
        new Promise<'connected'>((resolve) => {
          reconnect = resolve;
        }),
    );
    pump();
    await vi.waitFor(() => expect(row('AR-1')?.step).toBe('engine_waiting'));
    expect(row('AR-2')?.step).toBe('engine_waiting');
    expect(h.repos.mergeTrains.listRunning()[0]?.step).toBe('merging');
    reconnect('connected');
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
    await settled();
    expect(executor.run).toHaveBeenCalledTimes(1);
    expect(merger.push).toHaveBeenCalledTimes(1);
  });

  it('continues individually when the train reservation loses its link', async () => {
    await setup();
    merger.prepare.mockRejectedValueOnce(new EngineLinkLostError('disconnected'));
    pump();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
    await settled();
    expect(h.domain.tasks.get('AR', 'AR-1').merged).toBeDefined();
    expect(merger.push).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('requeues a disconnected train on shutdown (push started: %s)', async (pushing) => {
    await setup();
    merger[pushing ? 'push' : 'build'].mockRejectedValueOnce(new EngineLinkLostError('disconnected'));
    engines.awaitConnected = (_id, _waitMs, signal) =>
      new Promise((resolve) => signal!.addEventListener('abort', () => resolve('aborted'), { once: true }));
    pump();
    await vi.waitFor(() => expect(row('AR-1')?.step).toBe('engine_waiting'));
    await h.domain.merges.stop();
    expect(row('AR-1')?.state).toBe(pushing ? 'running' : 'queued');
    expect(row('AR-2')?.state).toBe(pushing ? 'running' : 'queued');
    engines.awaitConnected = vi.fn(async () => 'connected' as const);
    await h.domain.merges.init();
    pump();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
    await settled();
  });

  it('hands every member commit over before it prepares or builds the train (PM-739)', async () => {
    await setup(3);
    const handOver = vi.spyOn(h.domain.sessions, 'prepareMergeSource');
    merger.prepare.mockClear();
    pump();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-3').merged).toBeDefined());
    await settled();
    const handed = new Set(handOver.mock.calls.map(([, , commit]) => commit));
    expect(handed).toEqual(new Set([sha(1), sha(2), sha(3)]));
    // Nothing was prepared or built before the first hand-over, and no build before all were handed over.
    const firstPrepare = Math.min(...merger.prepare.mock.invocationCallOrder);
    expect(Math.min(...handOver.mock.invocationCallOrder)).toBeLessThan(firstPrepare);
    const firstBuild = Math.min(...merger.build.mock.invocationCallOrder);
    const lastHandOver = (commit: string) =>
      Math.min(
        ...handOver.mock.calls.flatMap(([, , c], i) =>
          c === commit ? [handOver.mock.invocationCallOrder[i]!] : [],
        ),
      );
    for (const i of [1, 2, 3]) expect(lastHandOver(sha(i))).toBeLessThan(firstBuild);
  });

  it('leaves a candidate whose commit cannot be handed over out of the train and blocks it on its own (PM-739)', async () => {
    await setup();
    vi.spyOn(h.domain.sessions, 'prepareMergeSource').mockImplementation(async (_config, _task, commit) => {
      if (commit === sha(2)) throw new Error('The commit is not known in this repository');
    });
    pump();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-1').merged).toBeDefined());
    await settled();
    expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeUndefined();
    expect(row('AR-2')?.block?.reason).toBe('merge_error');
    for (const [, input] of merger.build.mock.calls) expect(input.commit).not.toBe(sha(2));
    for (const [, input] of merger.prepare.mock.calls) expect(input.commit).not.toBe(sha(2));
  });

  it.each([2, 3])('retries all %i conflicting train sources individually on current main', async (count) => {
    await setup(count);
    const priority = '2026-10-14T18:00:00.000Z';
    h.repos.taskMerges.save({ ...row('AR-1')!, prioritizedAt: priority });
    const before = Array.from({ length: count }, (_, i) => row(`AR-${i + 1}`)!);
    const build = merger.build.getMockImplementation()!;
    merger.build.mockImplementation(async (ref, input) => {
      if (input.commit === sha(2) && input.onto !== merger.base.local) {
        peerBusy = true;
        return { ok: false, conflict: ['shared.ts'] };
      }
      return build(ref, input);
    });
    pump();
    await vi.waitFor(() => expect(row('AR-1')?.diagnostic).toBeDefined());
    await settled();
    const parentTrainId = row('AR-1')!.diagnostic!.parentTrainId;
    expect(h.repos.mergeTrains.get(parentTrainId)).toMatchObject({ state: 'failed', landed: 'nowhere' });
    expect(h.repos.mergeTrains.listRunning()).toEqual([]);
    for (const previous of before) {
      const queued = row(previous.taskKey)!;
      expect(queued).toMatchObject({
        id: previous.id,
        state: 'queued',
        step: 'queued',
        commit: previous.commit,
        branch: previous.branch,
        createdAt: previous.createdAt,
        diagnostic: { parentTrainId, maxCards: 1 },
      });
      expect(queued.prioritizedAt).toBe(previous.prioritizedAt);
      expect(queued.trainId).toBeUndefined();
      expect(queued.mergeCommit).toBeUndefined();
      expect(queued.check).toBeUndefined();
      expect(queued.block).toBeUndefined();
      expect(queued.failure).toBeUndefined();
    }
    expect(executor.run).not.toHaveBeenCalled();
    expect(merger.push).not.toHaveBeenCalled();
    expect(merger.advance).not.toHaveBeenCalled();
    expect(merger.releaseCheck).toHaveBeenCalledExactlyOnceWith(
      { projectKey: 'AR', repo: 'web' },
      { mergeId: parentTrainId },
    );
    await h.domain.merges.stop();
    await h.domain.merges.init();
    pump();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', `AR-${count}`).merged).toBeDefined());
    await settled();
    expect(executor.run).toHaveBeenCalledTimes(count);
    for (const [spec] of vi.mocked(executor.run).mock.calls)
      expect(spec).toMatchObject({ command: reviewTest.command, requireHeavyLock: true });
    expect(merger.push).toHaveBeenCalledTimes(count);
    expect(merger.advance).toHaveBeenCalledTimes(count);
    const runIds = new Set<string>();
    let onto = sha(0);
    for (const previous of before) {
      const merged = h.repos.taskMerges.latestMerged('AR', previous.taskKey)!;
      expect(merged.id).toBe(previous.id);
      expect(merged.trainId).toBeUndefined();
      expect(merged.diagnostic).toBeUndefined();
      expect(merged.check).toMatchObject({ status: 'passed', command: reviewTest.command });
      expect(merged.check?.reused).not.toBe(true);
      runIds.add(merged.check!.runId!);
      expect(merger.parents.get(merged.mergeCommit!)).toEqual([onto, previous.commit]);
      onto = merged.mergeCommit!;
      expect(
        h.domain.timeline
          .list('AR', { taskKey: previous.taskKey })
          .filter((e) => e.type === 'task_merge_blocked'),
      ).toHaveLength(0);
    }
    expect(runIds.size).toBe(count);
  });

  describe('recorded merge checks (PM-876)', () => {
    const report = {
      scope: 'all' as const,
      workers: 2,
      commandMs: 90,
      steps: [
        {
          index: 0,
          kind: 'typecheck' as const,
          workspace: 'packages/shared',
          result: 'cached' as const,
          durationMs: null,
        },
        {
          index: 1,
          kind: 'test' as const,
          workspace: 'apps/server',
          result: 'passed' as const,
          durationMs: 80,
        },
      ],
    };
    const trains = () => h.repos.mergeCheckRuns.list({ projectKey: 'AR', kinds: ['train'], limit: 10 }).runs;

    it('records the group check with its members, the worker count passed and the engine report', async () => {
      await setup(2);
      vi.mocked(executor.run).mockImplementation(async (_spec, _signal, started) => {
        started?.();
        return { ...passed, durationMs: 123, report };
      });
      pump();
      await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
      await settled();
      expect(trains()).toEqual([
        expect.objectContaining({
          projectKey: 'AR',
          kind: 'train',
          taskKeys: ['AR-1', 'AR-2'],
          maxWorkers: reviewTest.maxWorkers,
          status: 'passed',
          durationMs: 123,
          startedAt: expect.any(String),
          finishedAt: expect.any(String),
          report,
        }),
      ]);
    });

    it('records a failed group check with the report of its steps', async () => {
      await setup(2);
      vi.mocked(executor.run).mockResolvedValueOnce({
        ...passed,
        outcome: 'failed',
        exitCode: 1,
        durationMs: 77,
        report,
      });
      pump();
      await settled();
      // Newest first: the oldest run is the failed one, whatever the isolation ran after it.
      expect(trains().at(-1)).toMatchObject({ status: 'failed', durationMs: 77, report });
    });

    it('records a run that throws as an error without a time or report', async () => {
      await setup(2);
      vi.mocked(executor.run).mockRejectedValue(new Error('engine exploded'));
      pump();
      await settled();
      expect(trains()[0]).toMatchObject({ status: 'error', durationMs: null, report: null });
    });
  });

  it('notes the flaky test files of a passed group check on every member, and merges them', async () => {
    await setup(3);
    vi.mocked(executor.run).mockResolvedValue({
      ...passed,
      outputTail: 'merge-test flaky: apps/server/test/a.test.ts\n',
    });
    pump();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-3').merged).toBeDefined());
    await settled();
    expect(executor.run).toHaveBeenCalledTimes(1);
    for (const key of ['AR-1', 'AR-2', 'AR-3']) {
      const notes = h.domain.timeline
        .list('AR', { taskKey: key })
        .filter((e) => e.type === 'task_note' && String(e.data.text).includes('flaky'));
      expect(notes, key).toHaveLength(1);
      expect(notes[0]!.data.text).toMatch(
        /^Merge check \S+ passed after rerunning these test files once \(flaky\): apps\/server\/test\/a\.test\.ts$/,
      );
    }
  });

  it('reports a persistent source conflict through the individual conflict path', async () => {
    await setup();
    const build = merger.build.getMockImplementation()!;
    merger.build.mockImplementation(async (ref, input) =>
      input.commit === sha(2) ? { ok: false, conflict: ['shared.ts'] } : build(ref, input),
    );
    pump();
    await vi.waitFor(() => expect(row('AR-2')?.failure?.reason).toBe('conflict'));
    await settled();
    const first = h.domain.tasks.get('AR', 'AR-1').merged!;
    expect(first).toBeDefined();
    expect(row('AR-2')).toMatchObject({
      state: 'failed',
      failure: { reason: 'conflict', base: first.mergeCommit, files: ['shared.ts'] },
      diagnostic: { maxCards: 1 },
    });
    expect(row('AR-2')?.trainId).toBeUndefined();
    expect(row('AR-2')?.block).toBeUndefined();
    expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeUndefined();
    expect(merger.build.mock.calls.filter(([, input]) => input.commit === sha(2))).toHaveLength(2);
    expect(executor.run).toHaveBeenCalledTimes(1);
    expect(merger.push).toHaveBeenCalledTimes(1);
    expect(h.repos.mergeTrains.listRunning()).toEqual([]);
  });

  it('keeps the code review gate on individual retries after a train source conflict', async () => {
    await setup();
    const build = merger.build.getMockImplementation()!;
    merger.build.mockImplementation(async (ref, input) =>
      input.commit === sha(2) && input.onto !== merger.base.local
        ? { ok: false, conflict: ['shared.ts'] }
        : build(ref, input),
    );
    vi.mocked(executor.run).mockImplementationOnce(async () => {
      h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-2').id, { labels: [] });
      return passed;
    });
    pump();
    await vi.waitFor(() => expect(row('AR-2')?.block?.reason).toBe('gate_changed'));
    await settled();
    expect(h.domain.tasks.get('AR', 'AR-1').merged).toBeDefined();
    expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeUndefined();
    expect(merger.push).toHaveBeenCalledTimes(1);
    expect(merger.advance).toHaveBeenCalledTimes(1);
  });

  it.each(['timeout', 'sandbox_unavailable', 'heavy_lock_unavailable', 'spawn_failed', 'killed'] as const)(
    'blocks %s without splitting or blaming members',
    async (reason) => {
      await setup();
      vi.mocked(executor.run).mockResolvedValue({
        ...passed,
        outcome: 'error',
        exitCode: 1,
        reason,
      });
      pump();
      await vi.waitFor(() => expect(row('AR-1')?.state).toBe('blocked'));
      await settled();
      expect(merger.push).not.toHaveBeenCalled();
      expect(merger.advance).not.toHaveBeenCalled();
      expect(row('AR-1')?.check?.runId).toBe(row('AR-2')?.check?.runId);
      expect(h.repos.mergeTrains.listRunning()).toEqual([]);
      expect(row('AR-1')?.block?.message).toContain(reason);
      expect(row('AR-1')?.diagnostic).toBeUndefined();
      expect(executor.run).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [2, [1]],
    [3, [2]],
    [3, [3]],
    [8, [1]],
    [8, [4]],
    [8, [8]],
    [8, [2, 5, 8]],
    [8, [1, 2, 3, 4, 5, 6, 7, 8]],
  ] as const)('isolates failing sources for %i cards with failures %j', async (count, bad) => {
    await setup(count);
    let active = 0;
    let maximum = 0;
    vi.mocked(executor.run).mockImplementation(async (_spec, _signal, started) => {
      maximum = Math.max(maximum, ++active);
      started?.();
      const candidate = [...merger.parents.keys()].at(-1)!;
      const failing = [];
      for (const i of bad) {
        if (
          await merger.isAncestor({ projectKey: 'AR', repo: 'web' }, { ancestor: sha(i), commit: candidate })
        )
          failing.push(i);
      }
      active--;
      return failing.length
        ? {
            ...passed,
            outcome: 'failed',
            exitCode: 1,
            failedFiles: ['broken.test.ts'],
            outputTail: 'Broken source',
          }
        : passed;
    });
    pump();
    await vi.waitFor(
      () => {
        for (let i = 1; i <= count; i++) {
          if ((bad as readonly number[]).includes(i))
            expect(row(`AR-${i}`)?.failure?.reason).toBe('check_failed');
          else expect(h.domain.tasks.get('AR', `AR-${i}`).merged).toBeDefined();
        }
      },
      { timeout: 10_000 },
    );
    await settled();
    expect(maximum).toBe(1);
    expect(vi.mocked(executor.run).mock.calls.length).toBeLessThanOrEqual(2 * count - 1);
    expect(new Set(vi.mocked(executor.run).mock.calls.map(([spec]) => spec.runId)).size).toBe(
      vi.mocked(executor.run).mock.calls.length,
    );
    for (let i = 1; i <= count; i++) {
      if ((bad as readonly number[]).includes(i)) {
        expect(row(`AR-${i}`)?.trainId).toBeUndefined();
        expect(row(`AR-${i}`)?.diagnostic?.maxCards).toBeLessThanOrEqual(Math.ceil(count / 2));
        expect(row(`AR-${i}`)?.failure?.outputTail).toContain('Broken source');
      } else expect(h.repos.taskMerges.latestMerged('AR', `AR-${i}`)?.diagnostic).toBeUndefined();
    }
    const manifests = h.repos.db.prepare('SELECT id FROM merge_trains').all() as { id: string }[];
    for (const { id } of manifests) {
      const train = h.repos.mergeTrains.get(id)!;
      if (train.parentTrainId)
        expect(train.members.length).toBeLessThan(
          h.repos.mergeTrains.get(train.parentTrainId)!.members.length,
        );
    }
  });

  it('tests the second half on the landed prefix to detect cross-card failures', async () => {
    await setup();
    vi.mocked(executor.run).mockImplementation(async () => {
      const candidate = [...merger.parents.keys()].at(-1)!;
      const contains = await Promise.all(
        [1, 2].map((i) =>
          merger.isAncestor({ projectKey: 'AR', repo: 'web' }, { ancestor: sha(i), commit: candidate }),
        ),
      );
      return contains.every(Boolean) ? { ...passed, outcome: 'failed', exitCode: 1 } : passed;
    });
    pump();
    await vi.waitFor(() => expect(row('AR-2')?.failure?.reason).toBe('check_failed'));
    await settled();
    expect(h.domain.tasks.get('AR', 'AR-1').merged).toBeDefined();
    expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeUndefined();
    expect(executor.run).toHaveBeenCalledTimes(3);
    expect(merger.push).toHaveBeenCalledTimes(1);
  });

  describe('blaming a member by its lone run of the failed files (PM-844)', () => {
    const filesCommand = 'npm run merge-test -- --files';
    const groupFailed = (failedFiles: string[]): FullTestResult => ({
      ...passed,
      outcome: 'failed',
      exitCode: 1,
      failedFiles,
      outputTail: 'Group failure',
    });
    /** The group check fails; each lone run answers by the member (1-based card number) its candidate holds. */
    function script(group: FullTestResult, lone: (card: number) => FullTestResult) {
      let groups = 0;
      vi.mocked(executor.run).mockImplementation(async (spec, _signal, started) => {
        started?.();
        if (spec.command === reviewTest.command) {
          if (groups++ > 0) return passed;
          peerBusy = true;
          return group;
        }
        const mergeCommit = merger.checkoutForCheck.mock.calls.at(-1)![1].mergeCommit;
        const card = Number.parseInt(merger.parents.get(mergeCommit)![1]!, 16);
        return lone(card);
      });
    }
    const queuedKeys = () => h.repos.taskMerges.list('queued').map((r) => r.taskKey);
    const loneCalls = () =>
      vi.mocked(executor.run).mock.calls.filter(([spec]) => spec.command !== reviewTest.command);

    it('fails only the member that fails the files alone and requeues the others without a limit', async () => {
      await setup(3, true, filesCommand);
      merger.checkoutForCheck.mockResolvedValue({
        path: '/fake/check',
        gitDir: '/fake/git',
        dependencyInstallRequired: true,
      });
      const files = ['a.test.ts', "b'c.test.ts"];
      script(groupFailed(files), (card) =>
        card === 2 ? { ...groupFailed([...files, 'extra.test.ts']), outputTail: 'Broken alone' } : passed,
      );
      const order = queuedKeys();
      pump();
      await vi.waitFor(() => expect(row('AR-2')?.state).toBe('failed'));
      await settled();
      expect(order).toEqual(['AR-1', 'AR-2', 'AR-3']);
      const command = `${filesCommand} 'a.test.ts' 'b'\\''c.test.ts'`;
      expect(loneCalls().map(([spec]) => spec.command)).toEqual([command, command, command]);
      const checkoutIds = merger.checkoutForCheck.mock.calls.map(([, input]) => input.mergeId);
      expect(checkoutIds.every(isMergeId)).toBe(true);
      expect(new Set(checkoutIds).size).toBe(checkoutIds.length);
      for (const [index, [spec]] of loneCalls().entries()) {
        const [ref, input] = merger.checkoutForCheck.mock.calls[index + 1]!;
        expect(merger.releaseCheck).toHaveBeenCalledWith(ref, { mergeId: input.mergeId });
        expect(input.allowDependencyInstall).toBe(true);
        expect(spec).toMatchObject({
          maxWorkers: 2,
          timeoutMs: 600_000,
          requireHeavyLock: true,
          npmCi: { ref, mergeId: input.mergeId },
        });
      }
      const failed = row('AR-2')!;
      expect(failed.failure).toMatchObject({
        reason: 'check_failed',
        base: sha(0),
        command,
        files,
        outputTail: 'Broken alone',
      });
      expect(failed.failure?.runId).toBe(loneCalls()[1]![0].runId);
      const events = h.domain.timeline
        .list('AR', { taskKey: 'AR-2' })
        .filter((e) => e.type === 'task_merge_failed');
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toMatchObject({ runId: failed.failure!.runId, files, mergeId: failed.id });
      expect(queuedKeys()).toEqual(['AR-1', 'AR-3']);
      for (const key of ['AR-1', 'AR-3']) {
        const requeued = row(key)!;
        expect(requeued).toMatchObject({ state: 'queued', step: 'queued' });
        expect(requeued.diagnostic).toBeUndefined();
        expect(requeued.trainId).toBeUndefined();
        expect(
          h.domain.timeline
            .list('AR', { taskKey: key })
            .some((e) => e.type === 'task_note' && String(e.data.text).includes('passed them alone')),
        ).toBe(true);
      }
      expect(h.repos.db.prepare("SELECT id FROM merge_trains WHERE state = 'failed'").all()).toHaveLength(1);
      expect(merger.releaseCheck).toHaveBeenCalledTimes(1 + 3 + 1);
      // The requeued cards merge in a later train on their own.
      pump();
      await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-3').merged).toBeDefined());
      await settled();
      expect(h.domain.tasks.get('AR', 'AR-1').merged).toBeDefined();
      expect(row('AR-2')?.state).toBe('failed');
    });

    it('blames every member that fails alone', async () => {
      await setup(3, true, filesCommand);
      script(groupFailed(['a.test.ts']), (card) => (card === 3 ? passed : groupFailed(['a.test.ts'])));
      pump();
      await vi.waitFor(() => expect(row('AR-2')?.state).toBe('failed'));
      await settled();
      expect(row('AR-1')?.state).toBe('failed');
      expect(row('AR-3')?.state).toBe('queued');
      expect(row('AR-3')?.diagnostic).toBeUndefined();
    });

    it.each([
      ['passes', () => passed],
      ['fails with no failed file', () => groupFailed([])],
      ['fails other files only', () => groupFailed(['other.test.ts'])],
      ['cannot run', (): FullTestResult => ({ ...passed, outcome: 'error', reason: 'timeout' })],
    ] as const)('halves the group when no member alone blames itself (%s)', async (_name, lone) => {
      await setup(3, true, filesCommand);
      script(groupFailed(['a.test.ts']), lone);
      pump();
      await vi.waitFor(() => expect(row('AR-1')?.diagnostic).toBeDefined());
      await settled();
      expect(loneCalls()).toHaveLength(3);
      for (const key of ['AR-1', 'AR-2', 'AR-3']) {
        expect(row(key)).toMatchObject({ state: 'queued', diagnostic: { maxCards: 2 } });
        expect(row(key)?.failure).toBeUndefined();
      }
    });

    it('treats a member whose lone run throws as unknown', async () => {
      await setup(3, true, filesCommand);
      script(groupFailed(['a.test.ts']), (card) => (card === 1 ? groupFailed(['a.test.ts']) : passed));
      merger.checkoutForCheck.mockImplementation(async (_ref, input) => {
        if (merger.parents.get(input.mergeCommit)?.[1] === sha(3)) throw new Error('No space left');
        return { path: '/fake/check', gitDir: '/fake/git' };
      });
      pump();
      await vi.waitFor(() => expect(row('AR-1')?.state).toBe('failed'));
      await settled();
      expect(queuedKeys()).toEqual(['AR-2', 'AR-3']);
      expect(row('AR-3')?.diagnostic).toBeUndefined();
      expect(
        h.domain.timeline
          .list('AR', { taskKey: 'AR-3' })
          .some((e) => e.type === 'task_note' && String(e.data.text).includes('could not be told apart')),
      ).toBe(true);
    });

    it('treats a member whose lone merge build throws as unknown', async () => {
      await setup(3, true, filesCommand);
      script(groupFailed(['a.test.ts']), (card) => (card === 1 ? groupFailed(['a.test.ts']) : passed));
      const build = merger.build.getMockImplementation()!;
      let builds = 0;
      merger.build.mockImplementation(async (ref, input) => {
        if (String(input.message).startsWith('Diagnose AR-3')) throw new Error('fatal: bad object');
        builds += 1;
        return build(ref, input);
      });
      pump();
      await vi.waitFor(() => expect(row('AR-1')?.state).toBe('failed'));
      await settled();
      expect(builds).toBeGreaterThan(0);
      expect(queuedKeys()).toEqual(['AR-2', 'AR-3']);
      expect(row('AR-3')?.state).toBe('queued');
    });

    it('halves the group without a filesCommand', async () => {
      await setup(3);
      script(groupFailed(['a.test.ts']), () => groupFailed(['a.test.ts']));
      pump();
      await vi.waitFor(() => expect(row('AR-1')?.diagnostic).toBeDefined());
      await settled();
      expect(executor.run).toHaveBeenCalledTimes(1);
      expect(row('AR-1')?.diagnostic?.maxCards).toBe(2);
    });

    it('halves the group when the group check names no failed file', async () => {
      await setup(3, true, filesCommand);
      script(groupFailed([]), () => groupFailed(['a.test.ts']));
      pump();
      await vi.waitFor(() => expect(row('AR-1')?.diagnostic).toBeDefined());
      await settled();
      expect(executor.run).toHaveBeenCalledTimes(1);
      expect(row('AR-1')?.diagnostic?.maxCards).toBe(2);
    });

    it('invalidates the train when it is stopped during the lone runs', async () => {
      await setup(3, true, filesCommand);
      script(groupFailed(['a.test.ts']), () => passed);
      vi.mocked(executor.run).mockImplementationOnce(async () => {
        peerBusy = true;
        return groupFailed(['a.test.ts']);
      });
      vi.mocked(executor.run).mockImplementationOnce(async (_spec, signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return groupFailed(['a.test.ts']);
      });
      pump();
      await vi.waitFor(() => expect(executor.run).toHaveBeenCalledTimes(2));
      await h.domain.merges.stop();
      expect(executor.run).toHaveBeenCalledTimes(2);
      expect(h.repos.mergeTrains.listRunning()).toEqual([]);
      for (const key of ['AR-1', 'AR-2', 'AR-3']) {
        expect(row(key)).toMatchObject({ state: 'queued', step: 'queued' });
        expect(row(key)?.diagnostic).toBeUndefined();
        expect(row(key)?.failure).toBeUndefined();
      }
      expect(h.repos.db.prepare("SELECT id FROM merge_trains WHERE state = 'failed'").all()).toEqual([]);
    });
  });

  describe('GitHub Actions runner (PM-900)', () => {
    const filesCommand = 'npm run merge-test -- --files';
    const runs = () => h.repos.mergeCheckRuns.list({ projectKey: 'AR', limit: 10 }).runs;
    const githubSpecs = () => vi.mocked(executor.run).mock.calls.map(([spec]) => spec);

    it('checks the group by the descriptor with no checkout, heavy-run lock or installation', async () => {
      await setup(2, true, undefined, 'acme/web');
      vi.mocked(executor.available).mockClear();
      vi.mocked(executor.run).mockImplementation(async (_spec, _signal, started) => {
        started?.();
        return { ...passed, externalUrl: 'https://github.com/acme/web/actions/runs/9' };
      });
      pump();
      await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
      await settled();
      const [spec, ...more] = githubSpecs();
      expect(more).toEqual([]);
      expect(spec).toEqual({
        runId: expect.stringMatching(/^mergecheck_/),
        cwd: 'github-actions:acme/web',
        command: reviewTest.command,
        maxWorkers: reviewTest.maxWorkers,
        timeoutMs: reviewTest.timeoutMinutes * 60_000,
        sandbox: { denyRead: [], allowRead: [] },
        githubActions: {
          ref: { projectKey: 'AR', repo: 'web' },
          mergeId: expect.any(String),
          repo: 'acme/web',
          base: 'main',
          commit: merger.base.local,
          workflow: 'merge-check.yml',
        },
      });
      const { mergeId } = spec!.githubActions!;
      expect(isMergeId(mergeId)).toBe(true);
      expect(merger.checkoutForCheck).not.toHaveBeenCalled();
      expect(executor.available).not.toHaveBeenCalled();
      expect(merger.releaseCheck).toHaveBeenCalledWith(spec!.githubActions!.ref, { mergeId });
      expect(runs()).toEqual([
        expect.objectContaining({
          kind: 'train',
          runner: 'github_actions',
          url: 'https://github.com/acme/web/actions/runs/9',
        }),
      ]);
    });

    it('runs each lone diagnosis by a descriptor naming the failed files', async () => {
      await setup(3, true, filesCommand, 'acme/web');
      const files = ['a.test.ts', "b'c.test.ts"];
      const failing = { ...passed, outcome: 'failed' as const, exitCode: 1, failedFiles: files };
      let groups = 0;
      vi.mocked(executor.run).mockImplementation(async (spec, _signal, started) => {
        started?.();
        if (spec.command === reviewTest.command) {
          if (groups++ > 0) return passed;
          peerBusy = true;
          return failing;
        }
        const card = Number.parseInt(merger.parents.get(spec.githubActions!.commit)![1]!, 16);
        return card === 2 ? failing : passed;
      });
      pump();
      await vi.waitFor(() => expect(row('AR-2')?.state).toBe('failed'));
      await settled();
      const lone = githubSpecs().filter((spec) => spec.command !== reviewTest.command);
      expect(lone).toHaveLength(3);
      for (const spec of lone) {
        expect(spec).toMatchObject({
          command: `${filesCommand} 'a.test.ts' 'b'\\''c.test.ts'`,
          cwd: 'github-actions:acme/web',
          githubActions: { repo: 'acme/web', files },
        });
        expect(spec).not.toHaveProperty('requireHeavyLock');
        expect(spec).not.toHaveProperty('npmCi');
        expect(isMergeId(spec.githubActions!.mergeId)).toBe(true);
      }
      expect(new Set(lone.map((spec) => spec.githubActions!.mergeId)).size).toBe(3);
      expect(merger.checkoutForCheck).not.toHaveBeenCalled();
      expect(runs().filter((run) => run.kind === 'diagnose')).toHaveLength(3);
      expect(runs().every((run) => run.runner === 'github_actions')).toBe(true);
    });

    it('blocks the group as check_unavailable when the configuration no longer names the github owner/name', async () => {
      await setup(2, true, undefined, 'acme/web');
      // The invariant refuses such a configuration, so the loss is simulated at the read.
      const read = h.domain.projects.config.bind(h.domain.projects);
      vi.spyOn(h.domain.projects, 'config').mockImplementation(async (key) => {
        const config = structuredClone(await read(key));
        delete config.project.repos[0]!.github;
        return config;
      });
      pump();
      await vi.waitFor(() => expect(row('AR-1')?.state).toBe('blocked'));
      await settled();
      expect(row('AR-1')?.block?.reason).toBe('check_unavailable');
      expect(row('AR-1')?.block?.message).toContain('github');
      expect(executor.run).not.toHaveBeenCalled();
    });
  });

  it('restores priority, yields to documents, and keeps diagnostic limits across restart and explicit retry', async () => {
    await setup(3);
    const before = row('AR-1')!;
    const priority = '2026-10-14T18:00:00.000Z';
    h.repos.taskMerges.save({ ...before, prioritizedAt: priority });
    vi.mocked(executor.run).mockImplementationOnce(async () => {
      peerBusy = true;
      return { ...passed, outcome: 'failed', exitCode: 1, outputTail: 'Group failure' };
    });
    pump();
    await vi.waitFor(() => expect(row('AR-1')?.diagnostic).toBeDefined());
    await settled();
    const split = row('AR-1')!;
    expect(split).toMatchObject({
      state: 'queued',
      step: 'queued',
      createdAt: before.createdAt,
      prioritizedAt: priority,
      diagnostic: { maxCards: 2 },
    });
    expect(split.check).toBeUndefined();
    expect(split.mergeCommit).toBeUndefined();
    expect(h.repos.mergeTrains.get(split.diagnostic!.parentTrainId)?.state).toBe('failed');
    expect(
      h.domain.timeline
        .list('AR', { taskKey: 'AR-1' })
        .some((e) => e.type === 'task_note' && String(e.data.text).includes('Group failure')),
    ).toBe(true);
    await h.domain.merges.stop();
    await h.domain.merges.init();
    expect(row('AR-1')).toEqual(split);
    await h.domain.merges.prioritize('AR', 'AR-3', OWNER_ACTOR, 'Check priority between diagnostic attempts');
    vi.mocked(executor.run).mockResolvedValueOnce({
      ...passed,
      outcome: 'error',
      reason: 'heavy_lock_unavailable',
    });
    pump();
    await vi.waitFor(() => expect(row('AR-3')?.state).toBe('blocked'));
    await settled();
    peerBusy = true;
    const diagnostic = row('AR-3')!.diagnostic;
    await h.domain.merges.start('AR', 'AR-3', aiActor('dev-1'));
    expect(row('AR-3')?.diagnostic).toEqual(diagnostic);
    pump();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-3').merged).toBeDefined());
    await settled();
    expect(h.repos.taskMerges.latestMerged('AR', 'AR-3')?.diagnostic).toBeUndefined();
  });

  it.each([false, true])(
    'does not lose or duplicate the atomic split after restart (interrupt=%s)',
    async (interrupt) => {
      await setup(3);
      const save = h.repos.taskMerges.save.bind(h.repos.taskMerges);
      let injected = false;
      vi.spyOn(h.repos.taskMerges, 'save').mockImplementation((r) => {
        if (interrupt && !injected && r.taskKey === 'AR-2' && r.diagnostic) {
          injected = true;
          peerBusy = true;
          throw new Error('Interrupted split transaction');
        }
        save(r);
      });
      vi.mocked(executor.run).mockImplementationOnce(async () => {
        peerBusy = true;
        return { ...passed, outcome: 'failed', exitCode: 1 };
      });
      pump();
      await vi.waitFor(() => expect(executor.run).toHaveBeenCalledTimes(1));
      await settled();
      if (interrupt) {
        expect(h.repos.mergeTrains.listRunning()).toHaveLength(1);
        expect(row('AR-1')?.diagnostic).toBeUndefined();
        expect(row('AR-1')?.state).toBe('running');
      }
      await h.domain.merges.stop();
      await h.domain.merges.init();
      pump();
      await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-3').merged).toBeDefined());
      await settled();
      const failed = h.repos.db.prepare("SELECT id FROM merge_trains WHERE state = 'failed'").all();
      expect(failed).toHaveLength(1);
      expect(executor.run).toHaveBeenCalledTimes(3);
      for (const key of ['AR-1', 'AR-2', 'AR-3']) {
        expect(
          h.domain.timeline
            .list('AR', { taskKey: key })
            .filter((e) => e.type === 'task_note' && String(e.data.text).includes('failed its group check')),
        ).toHaveLength(1);
      }
    },
  );

  it('waits behind a failed prerequisite while unrelated cards merge', async () => {
    await setup(3);
    h.domain.tasks.addLink('AR', 'AR-2', { kind: 'prerequisite', ref: 'AR-1' }, OWNER_ACTOR);
    h.repos.taskMerges.save({
      ...row('AR-1')!,
      state: 'failed',
      failure: { reason: 'check_failed', base: sha(0), at: new Date().toISOString() },
    });
    pump();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-3').merged).toBeDefined());
    await settled();
    expect(row('AR-2')).toMatchObject({ state: 'queued', step: 'queued' });
    expect(row('AR-2')?.failure).toBeUndefined();
    expect(executor.run).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('rechecks prerequisites before publication (singleton=%s)', async (singleton) => {
    await setup(3);
    if (singleton) {
      for (let i = 1; i <= 3; i++)
        h.repos.taskMerges.save({
          ...row(`AR-${i}`)!,
          diagnostic: { parentTrainId: 'mrg_parent00', maxCards: 1 },
        });
    }
    vi.mocked(executor.run).mockImplementationOnce(async () => {
      h.domain.tasks.addLink('AR', 'AR-1', { kind: 'prerequisite', ref: 'AR-2' }, OWNER_ACTOR);
      return passed;
    });
    pump();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-3').merged).toBeDefined());
    await settled();
    expect(row('AR-1')?.state).toBe('queued');
    expect(row('AR-1')?.failure).toBeUndefined();
    expect(row('AR-1')?.check).toBeUndefined();
    expect(h.domain.tasks.get('AR', 'AR-1').merged).toBeUndefined();
    expect(executor.run).toHaveBeenCalledTimes(singleton ? 3 : 2);
    for (const [, input] of merger.push.mock.calls)
      expect(
        await merger.isAncestor(
          { projectKey: 'AR', repo: 'web' },
          { ancestor: sha(1), commit: input.mergeCommit },
        ),
      ).toBe(false);
  });

  it.each(['source', 'gate', 'config', 'merger'] as const)(
    'discards a candidate after a %s change and restores the priority snapshot',
    async (change) => {
      await setup();
      const priority = '2026-10-14T18:00:00.000Z';
      const diagnostic = { parentTrainId: 'mrg_parent00', maxCards: 2 };
      for (const key of ['AR-1', 'AR-2']) h.repos.taskMerges.save({ ...row(key)!, diagnostic });
      h.repos.taskMerges.save({ ...row('AR-1')!, prioritizedAt: priority });
      vi.mocked(executor.run).mockImplementation(async () => {
        peerBusy = true;
        if (change === 'source')
          h.repos.taskHandovers.save({
            projectKey: 'AR',
            taskKey: 'AR-2',
            commit: sha(99),
            branch: row('AR-2')!.branch!,
            stageId: 'code_review',
            at: new Date().toISOString(),
          });
        if (change === 'gate') h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-2').id, { labels: [] });
        if (change === 'config' || change === 'merger')
          await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (c) => {
            if (change === 'config') c.project.repos[0]!.reviewTest = { ...reviewTest, maxWorkers: 1 };
            else c.team.merger = { kind: 'member', handle: 'owner' };
            return 'Change merge checkpoint configuration';
          });
        return passed;
      });
      pump();
      await settled();
      expect(merger.push).not.toHaveBeenCalled();
      expect(merger.advance).not.toHaveBeenCalled();
      expect(h.repos.mergeTrains.listRunning()).toEqual([]);
      if (change === 'source' || change === 'gate')
        expect(row('AR-1')).toMatchObject({ state: 'queued', prioritizedAt: priority, diagnostic });
    },
  );

  it('cancels a non-leading member, waits for the worker and keeps the shared checkout until it stops', async () => {
    await setup();
    let finish!: () => void;
    vi.mocked(executor.run).mockImplementation(async (_spec, signal) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
        signal.addEventListener(
          'abort',
          () => {
            peerBusy = true;
          },
          { once: true },
        );
      });
      return passed;
    });
    pump();
    await vi.waitFor(() => expect(executor.run).toHaveBeenCalled());
    h.domain.merges.cancel('AR', 'AR-2');
    expect(h.domain.merges.busy('AR', 'web')).toBe(true);
    expect(merger.releaseCheck).not.toHaveBeenCalled();
    finish();
    await settled();
    expect(h.repos.taskMerges.latestMerged('AR', 'AR-2')).toBeNull();
    expect(row('AR-1')?.state).toBe('queued');
    expect(merger.push).not.toHaveBeenCalled();
    expect(merger.releaseCheck).toHaveBeenCalledTimes(1);
  });

  it('rechecks linked PR metadata after the common check', async () => {
    await setup();
    h.domain.tasks.addLink('AR', 'AR-2', { kind: 'pull_request', repo: 'acme/web', ref: '7' }, OWNER_ACTOR);
    h.github.prs.set('acme/web#7', pullRequest({ baseRef: 'main', headSha: sha(2) }));
    vi.mocked(executor.run).mockImplementation(async () => {
      peerBusy = true;
      h.github.prs.set('acme/web#7', pullRequest({ baseRef: 'main', headSha: sha(99) }));
      return passed;
    });
    pump();
    await vi.waitFor(() => expect(executor.run).toHaveBeenCalled());
    await settled();
    expect(merger.push).not.toHaveBeenCalled();
    expect(h.repos.mergeTrains.listRunning()).toEqual([]);
    expect(row('AR-1')?.state).toBe('queued');
  });

  it('rebuilds and rechecks once after non-fast-forward, then blocks remote_moved', async () => {
    await setup();
    merger.push.mockResolvedValue({ ok: false, reason: 'non_fast_forward', message: 'Moved' });
    pump();
    await vi.waitFor(() => expect(row('AR-1')?.block?.reason).toBe('remote_moved'));
    await settled();
    expect(executor.run).toHaveBeenCalledTimes(2);
    expect(merger.advance).not.toHaveBeenCalled();
    const specs = vi.mocked(executor.run).mock.calls.map((args) => args[0].runId);
    expect(new Set(specs).size).toBe(2);
  });

  it.each(['cancel', 'retry', 'both', 'offline'] as const)(
    'keeps current requests unchanged when an unpublished blocked train recovers after %s',
    async (change) => {
      await setup();
      const leaderId = row('AR-1')!.id;
      const followerId = row('AR-2')!.id;
      const push = merger.push.getMockImplementation()!;
      merger.push.mockResolvedValue({ ok: false, reason: 'non_fast_forward', message: 'Moved' });
      pump();
      await vi.waitFor(() => expect(row('AR-1')?.block?.reason).toBe('remote_moved'));
      await settled();
      peerBusy = true;
      if (change !== 'retry') h.domain.merges.cancel('AR', 'AR-1');
      if (change !== 'cancel') await h.domain.merges.start('AR', 'AR-2', aiActor('dev-2'));
      const before = [h.repos.taskMerges.get(leaderId), h.repos.taskMerges.get(followerId)];
      const manifest = h.repos.mergeTrains.get(before[0]!.trainId!);
      await h.domain.merges.stop();
      if (change === 'offline') merger.prepare.mockRejectedValueOnce(new Error('Engine offline'));
      await h.domain.merges.init();
      expect([h.repos.taskMerges.get(leaderId), h.repos.taskMerges.get(followerId)]).toEqual(before);
      expect(h.repos.mergeTrains.get(manifest!.id)).toEqual(manifest);
      merger.push.mockImplementation(push);
      pump();
      if (change !== 'cancel') {
        await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
        expect(h.repos.taskMerges.latestMerged('AR', 'AR-2')?.trainId).toBeUndefined();
      }
      await settled();
      expect(h.domain.tasks.get('AR', 'AR-1').merged).toBeUndefined();
      if (change !== 'retry') expect(h.repos.taskMerges.get(leaderId)?.state).toBe('cancelled');
      expect(executor.run).toHaveBeenCalledTimes(change === 'cancel' ? 2 : 3);
    },
  );

  it('stops before publication, releases the checkout and starts a new shared check on resume', async () => {
    await setup();
    vi.mocked(executor.run).mockImplementationOnce(async (_spec, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return passed;
    });
    pump();
    await vi.waitFor(() => expect(executor.run).toHaveBeenCalled());
    await h.domain.merges.stop();
    expect(merger.push).not.toHaveBeenCalled();
    expect(row('AR-1')?.state).toBe('queued');
    expect(row('AR-2')?.state).toBe('queued');
    expect(h.repos.mergeTrains.listRunning()).toEqual([]);
    await h.domain.merges.init();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
    await settled();
    expect(executor.run).toHaveBeenCalledTimes(2);
    expect(merger.push).toHaveBeenCalledTimes(1);
  });

  it('does not interrupt publication when a non-leading member is cancelled or the server stops', async () => {
    await setup();
    let releasePush!: () => void;
    const push = merger.push.getMockImplementation()!;
    merger.push.mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => {
        releasePush = resolve;
      });
      return push(...args);
    });
    pump();
    await vi.waitFor(() => expect(merger.push).toHaveBeenCalled());
    h.domain.merges.cancel('AR', 'AR-2');
    let stopped = false;
    const stopping = h.domain.merges.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releasePush();
    await stopping;
    for (const key of ['AR-1', 'AR-2']) expect(h.domain.tasks.get('AR', key).merged).toBeDefined();
    expect(merger.advance).toHaveBeenCalledTimes(1);
  });

  it('recovers a persisted running manifest before its members, respecting the repository peer', async () => {
    await setup();
    peerBusy = true;
    const rows = [row('AR-1')!, row('AR-2')!];
    const trainId = 'mrg_recovery0001';
    const candidate = sha(90);
    h.repos.mergeTrains.save({
      id: trainId,
      projectKey: 'AR',
      repo: 'web',
      base: 'main',
      engineId: 'local',
      reviewTest,
      state: 'running',
      step: 'merging',
      landed: 'nowhere',
      members: rows.map((r) => ({
        mergeId: r.id,
        taskKey: r.taskKey,
        commit: r.commit!,
        branch: r.branch!,
        startedBy: r.startedBy!,
        startedAt: r.startedAt!,
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const train = h.repos.mergeTrains.get(trainId)!;
    h.repos.mergeTrains.save({
      ...train,
      step: 'pushing',
      candidate,
      onto: sha(0),
      localFrom: sha(0),
      check: { command: reviewTest.command, status: 'passed', runId: 'original-check' },
    });
    for (const r of rows)
      h.repos.taskMerges.save({
        ...r,
        trainId,
        state: 'running',
        step: 'pushing',
        mergeCommit: candidate,
        check: { command: reviewTest.command, status: 'passed', runId: 'original-check' },
      });
    merger.base.remote!.commit = candidate;
    await h.domain.merges.init();
    expect(merger.prepare).not.toHaveBeenCalled();
    expect(h.domain.tasks.get('AR', 'AR-1').merged).toBeUndefined();
    pump();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
    await settled();
    expect(executor.run).not.toHaveBeenCalled();
    expect(merger.push).not.toHaveBeenCalled();
    expect(merger.advance).toHaveBeenCalledTimes(1);
    expect(h.domain.tasks.get('AR', 'AR-2').merged?.check?.runId).toBe('original-check');
  });

  it('recovers local-only publication after a DB transaction failure without another check or advance', async () => {
    await setup(2, false);
    const save = h.repos.mergeTrains.save.bind(h.repos.mergeTrains);
    let injected = false;
    vi.spyOn(h.repos.mergeTrains, 'save').mockImplementation((record) => {
      if (record.state === 'merged' && !injected) {
        injected = true;
        throw new Error('Interrupted final transaction');
      }
      save(record);
    });
    pump();
    await vi.waitFor(() => expect(row('AR-1')?.state).toBe('blocked'));
    await settled();
    await h.domain.merges.stop();
    await h.domain.merges.init();
    await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
    await settled();
    expect(merger.push).not.toHaveBeenCalled();
    expect(merger.advance).toHaveBeenCalledTimes(1);
    expect(executor.run).toHaveBeenCalledTimes(1);
    const merged = h.repos.taskMerges.latestMerged('AR', 'AR-1')!;
    expect(h.repos.mergeTrains.get(merged.trainId!)?.landed).toBe('local');
  });

  it.each(['advance', 'transaction'] as const)(
    'recovers after publication before %s without repeating check, push or events',
    async (fault) => {
      await setup();
      if (fault === 'advance') merger.advance.mockRejectedValueOnce(new Error('Interrupted before advance'));
      else {
        const append = h.domain.timeline.append.bind(h.domain.timeline);
        let injected = false;
        vi.spyOn(h.domain.timeline, 'append').mockImplementation((input) => {
          if (!injected && input.type === 'task_merged' && input.taskKey === 'AR-2') {
            injected = true;
            throw new Error('Interrupted transaction');
          }
          return append(input);
        });
      }
      pump();
      await vi.waitFor(() => expect(row('AR-1')?.state).toBe('blocked'));
      await settled();
      expect(
        h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.type === 'task_merged'),
      ).toHaveLength(0);
      await h.domain.merges.stop();
      await h.domain.merges.init();
      await vi.waitFor(() => expect(h.domain.tasks.get('AR', 'AR-2').merged).toBeDefined());
      await settled();
      expect(executor.run).toHaveBeenCalledTimes(1);
      expect(merger.push).toHaveBeenCalledTimes(1);
      const merged = h.repos.taskMerges.latestMerged('AR', 'AR-1')!;
      expect(h.repos.mergeTrains.get(merged.trainId!)?.landed).toBe('remote');
      for (const key of ['AR-1', 'AR-2']) {
        expect(h.domain.tasks.get('AR', key).merged).toBeDefined();
        expect(
          h.domain.timeline.list('AR', { taskKey: key }).filter((e) => e.type === 'task_merged'),
        ).toHaveLength(1);
      }
    },
  );
});
