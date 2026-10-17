import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FullTestExecutor, FullTestResult, BranchMerger, MergeBaseState } from '../../contracts';
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
  const row = (key: string) => h.repos.taskMerges.open('AR', key);
  const settled = () => vi.waitFor(() => expect(h.domain.merges.busy('AR', 'web')).toBe(false));
  async function setup(count = 2, remote = true) {
    merger = fakeMerger(remote);
    executor = {
      available: vi.fn(async () => ({ ok: true as const })),
      run: vi.fn(async (_spec, _signal, started) => {
        started?.();
        return passed;
      }),
    };
    h = await createDomainHarness({
      merger,
      fullTestExecutor: executor,
      adjust(config) {
        for (const member of config.team.members)
          if (member.kind === 'ai' && member.handle.startsWith('dev-')) member.capacity = 5;
        config.team.limits.maxConcurrentAi = 20;
        config.team.merger = { kind: 'developer' };
        config.project.repos[0]!.requireMerge = true;
        config.project.repos[0]!.reviewTest = reviewTest;
        config.pipeline.stages = config.pipeline.stages.filter((s) => s.id !== 'merge' && s.id !== 'release');
        config.pipeline.stages.find((s) => s.id === 'done')!.gate = {
          conditions: [{ type: 'has_label', label: 'code-review-ok' }],
        };
      },
    });
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
  });

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

  it.each([
    'timeout',
    'engine_offline',
    'sandbox_unavailable',
    'heavy_lock_unavailable',
    'spawn_failed',
    'killed',
  ] as const)('blocks %s without splitting or blaming members', async (reason) => {
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
  });

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
