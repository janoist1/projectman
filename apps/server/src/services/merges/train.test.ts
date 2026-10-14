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
  const ancestor = (a: string, c: string): boolean =>
    a === c || (parents.get(c) ?? []).some((p) => ancestor(a, p));
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

  it.each(['failed', 'error'] as const)(
    'does not publish a %s check or blame every member',
    async (outcome) => {
      await setup();
      vi.mocked(executor.run).mockResolvedValue({
        ...passed,
        outcome,
        exitCode: 1,
        reason: outcome === 'error' ? 'heavy_lock_unavailable' : undefined,
      });
      pump();
      await vi.waitFor(() => expect(row('AR-1')?.state).toBe(outcome === 'failed' ? 'failed' : 'blocked'));
      await settled();
      expect(merger.push).not.toHaveBeenCalled();
      expect(merger.advance).not.toHaveBeenCalled();
      expect(row('AR-1')?.check?.runId).toBe(row('AR-2')?.check?.runId);
      expect(h.repos.mergeTrains.listRunning()).toEqual([]);
      if (outcome === 'failed')
        expect(
          h.repos.messages
            .list('AR', { taskKey: 'AR-2' })
            .some((m) => m.body.includes('individual cause has not yet been identified')),
        ).toBe(true);
      else expect(row('AR-1')?.block?.message).toContain('heavy_lock_unavailable');
    },
  );

  it.each(['source', 'gate', 'config', 'merger'] as const)(
    'discards a candidate after a %s change and restores the priority snapshot',
    async (change) => {
      await setup();
      const priority = '2026-10-14T18:00:00.000Z';
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
        expect(row('AR-1')).toMatchObject({ state: 'queued', prioritizedAt: priority });
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
