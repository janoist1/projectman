import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import type { BranchMerger, FullTestExecutor, FullTestResult, MergeBaseState } from '../src/contracts';
import { withVisibleCardLinks, clientCanSeeTimelineEvent } from '../src/domain/visibility';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { pullRequest } from './helpers/fakes';
import { aiActor } from '../src/domain';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeMerger(remote = true) {
  const base: MergeBaseState = {
    local: 'base',
    remote: remote ? { name: 'origin', commit: 'base' } : null,
    relation: 'same',
    contains: { local: false, remote: remote ? false : null },
    checkout: null,
  };
  return {
    base,
    prepare: vi.fn<BranchMerger['prepare']>(async () => structuredClone(base)),
    isAncestor: vi.fn<BranchMerger['isAncestor']>(async () => false),
    build: vi.fn<BranchMerger['build']>(async (_ref, input) => ({
      ok: true,
      mergeCommit: `merged-${input.commit}`,
      changed: ['a.ts'],
    })),
    checkoutConflicts: vi.fn<BranchMerger['checkoutConflicts']>(async () => []),
    checkoutForCheck: vi.fn<BranchMerger['checkoutForCheck']>(async () => ({
      path: '/fake/check',
      gitDir: '/fake/git',
    })),
    releaseCheck: vi.fn<BranchMerger['releaseCheck']>(async () => {}),
    push: vi.fn<BranchMerger['push']>(async () => ({ ok: true })),
    advance: vi.fn<BranchMerger['advance']>(async () => ({ ok: true })),
  };
}
const passed: FullTestResult = {
  outcome: 'passed',
  exitCode: 0,
  durationMs: 1,
  failedFiles: [],
  outputTail: '',
};
const reviewTest = { command: 'npm test', maxWorkers: 2, timeoutMinutes: 10 };
function fakeExecutor(result: FullTestResult = passed): FullTestExecutor {
  return { available: vi.fn(async () => ({ ok: true as const })), run: vi.fn(async () => result) };
}

describe('member initiated merge', () => {
  let h: DomainHarness | undefined;
  let merger: ReturnType<typeof fakeMerger>;
  const task = (key = 'AR-1') => h!.domain.tasks.get('AR', key);
  const row = (key = 'AR-1') => h!.repos.taskMerges.open('AR', key);
  const events = (type: string) =>
    h!.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((event) => event.type === type);
  async function setup(
    opts: {
      remote?: boolean;
      executor?: FullTestExecutor;
      adjust?: (config: ProjectConfig) => void;
      persistent?: boolean;
      unavailable?: boolean;
    } = {},
  ) {
    merger = fakeMerger(opts.remote);
    h = await createDomainHarness({
      merger: opts.unavailable ? null : merger,
      fullTestExecutor: opts.executor,
      persistent: opts.persistent,
      adjust(config) {
        config.project.repos[0]!.requireMerge = true;
        config.team.merger = { kind: 'member', handle: 'dev-1' };
        config.pipeline.stages = config.pipeline.stages.filter(
          (stage) => stage.id !== 'merge' && stage.id !== 'release',
        );
        config.pipeline.stages.find((stage) => stage.id === 'done')!.gate = {
          conditions: [{ type: 'has_label', label: 'code-review-ok' }],
        };
        opts.adjust?.(config);
      },
    });
    vi.spyOn(h.domain.autoAdvance, 'check').mockResolvedValue(undefined);
    await card('AR-1', 'web', 'dev-1');
  }
  async function card(key: string, repo: string, assignee: string, parentKey?: string) {
    await h!.domain.tasks.create('AR', { title: `Card ${key}`, repo, parentKey }, OWNER_ACTOR);
    await h!.domain.taskStarts.start('AR', key, { assignee, actor: OWNER_ACTOR, author: OWNER });
    const tree = h!.worktrees.existing.get(`AR/${key}/${repo}`)!;
    h!.worktrees.heads.set(tree.path, {
      path: tree.path,
      branch: tree.branch,
      commit: `approved-${key}`,
      dirty: false,
      changes: 0,
      committedAt: null,
    });
    h!.repos.taskHandovers.save({
      projectKey: 'AR',
      taskKey: key,
      commit: `approved-${key}`,
      branch: tree.branch,
      stageId: 'code_review',
      at: new Date().toISOString(),
    });
    h!.repos.tasks.update(task(key).id, { stageId: 'code_review', labels: ['code-review-ok'] });
  }
  const move = (key = 'AR-1') => h!.domain.tasks.moveToStage('AR', key, 'done', OWNER_ACTOR);
  const start = (key = 'AR-1', actor = aiActor('dev-1')) => h!.domain.merges.start('AR', key, actor);
  const merged = async (key = 'AR-1') => vi.waitFor(() => expect(task(key).merged?.via).toBe('tool'));
  const blocked = async (reason: string) => vi.waitFor(() => expect(row()?.block?.reason).toBe(reason));
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });

  it('requests an AI merger without starting git, on the card with merge provenance', async () => {
    await setup();
    await h!.domain.merges.reconcile('AR', 'AR-1');
    expect(row()).toMatchObject({ state: 'requested', merger: 'dev-1' });
    expect(events('task_merge_requested')).toHaveLength(1);
    expect(merger.build).not.toHaveBeenCalled();
    const msg = h!.repos.messages
      .list('AR', { taskKey: 'AR-1' })
      .find((m) => m.body.includes('Call merge_task'));
    expect(msg).toMatchObject({ kind: 'action', from: 'system', origin: { kind: 'note' } });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    expect(events('task_merge_requested')).toHaveLength(1);
  });

  it('cancels a request when the gate ceases to hold', async () => {
    await setup();
    await h!.domain.merges.reconcile('AR', 'AR-1');
    const id = row()!.id;
    h!.repos.tasks.update(task().id, { labels: [] });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    expect(row()).toBeNull();
    expect(h!.repos.taskMerges.get(id)?.state).toBe('cancelled');
    expect(merger.build).not.toHaveBeenCalled();
  });

  it.each(['developer', 'member'] as const)('resolves %s merger', async (kind) => {
    await setup({
      adjust: (c) => {
        c.team.merger = kind === 'developer' ? { kind } : { kind, handle: 'owner' };
      },
    });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    expect(row()?.merger).toBe(kind === 'developer' ? 'dev-1' : 'owner');
  });

  it('requires the named merger even for an owner and refuses an unready card', async () => {
    await setup();
    await expect(start('AR-1', OWNER_ACTOR)).rejects.toMatchObject({ code: 'merge_not_merger', status: 403 });
    h!.repos.tasks.update(task().id, { labels: [] });
    await expect(start()).rejects.toMatchObject({ code: 'merge_not_ready', details: { reason: 'gate' } });
    expect(merger.build).not.toHaveBeenCalled();
  });

  it('starts a human merge from the inbox and resolves its request', async () => {
    await setup({
      adjust: (c) => {
        c.team.merger = { kind: 'member', handle: 'owner' };
      },
    });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    const item = h!.domain.inbox.list('AR', { kind: 'merge_request', state: 'open' })[0]!;
    const gate = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build.mockReturnValueOnce(gate.promise);
    const resolved = await h!.domain.inbox.resolve(
      'AR',
      item.id,
      { optionId: 'merge' },
      { handle: 'owner', access: 'owner' },
    );
    expect(resolved).toMatchObject({ state: 'resolved', resolution: { optionId: 'merge', by: 'owner' } });
    gate.resolve({ ok: true, mergeCommit: 'human', changed: [] });
    await merged();
    expect(task().merged?.by).toBe('owner');
  });

  it.each([true, false])('lands with remote=%s without moving the card', async (remote) => {
    await setup({ remote });
    const gate = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build.mockReturnValueOnce(gate.promise);
    const requested = await start();
    expect(requested.merge?.state).toMatch(/queued|running/);
    await vi.waitFor(() => expect(merger.build).toHaveBeenCalled());
    await start();
    expect(merger.build).toHaveBeenCalledTimes(1);
    expect(task().stageId).toBe('code_review');
    gate.resolve({ ok: true, mergeCommit: 'landed', changed: ['a.ts'] });
    await merged();
    expect(task().stageId).toBe('code_review');
    expect(merger.push).toHaveBeenCalledTimes(remote ? 1 : 0);
    expect(task().merged).toMatchObject({ mergeCommit: 'landed', commit: 'approved-AR-1', by: 'dev-1' });
    expect(events('task_merged')).toHaveLength(1);
    expect(merger.releaseCheck).toHaveBeenCalled();
    await move();
    expect(task().status).toBe('done');
  });

  it('records a tool success when there is nothing left to merge', async () => {
    await setup();
    merger.base.contains = { local: true, remote: true };
    await start();
    await merged();
    expect(merger.build).not.toHaveBeenCalled();
    expect(task().stageId).toBe('code_review');
  });

  it('lets AutoAdvance continue an idle card after success', async () => {
    await setup();
    vi.mocked(h!.domain.autoAdvance.check).mockRestore();
    for (const session of h!.domain.sessions.list('AR')) await h!.domain.sessions.stop('AR', session.id);
    await start();
    await merged();
    await vi.waitFor(() => expect(task().status).toBe('done'));
  });

  it('keeps conflicts on the card and can rebuild after failure', async () => {
    await setup();
    merger.build.mockResolvedValueOnce({ ok: false, conflict: ['a.ts', 'b.ts'] });
    await start();
    await vi.waitFor(() => expect(row()?.state).toBe('failed'));
    expect(row()?.failure).toMatchObject({ reason: 'conflict', base: 'base', files: ['a.ts', 'b.ts'] });
    expect(events('task_merge_failed')).toHaveLength(1);
    expect(task().stageId).toBe('code_review');
    expect(merger.push).not.toHaveBeenCalled();
    expect(merger.advance).not.toHaveBeenCalled();
    await start();
    await merged();
    expect(merger.build).toHaveBeenCalledTimes(2);
  });

  it.each(['passed', 'failed', 'error'] as const)(
    'handles check %s and releases checkout',
    async (outcome) => {
      const output = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(200)}`).join('\n');
      await setup({
        executor: fakeExecutor({ ...passed, outcome, outputTail: output }),
        adjust: (c) => {
          c.project.repos[0]!.reviewTest = reviewTest;
        },
      });
      await start();
      if (outcome === 'passed') await merged();
      else if (outcome === 'error') await blocked('check_error');
      else {
        await vi.waitFor(() => expect(row()?.state).toBe('failed'));
        expect(row()?.failure?.outputTail?.length).toBeLessThanOrEqual(8000);
        expect(row()?.failure?.outputTail?.split('\n').length).toBeLessThanOrEqual(40);
        expect(task().stageId).toBe('code_review');
        expect(merger.push).not.toHaveBeenCalled();
      }
      expect(merger.releaseCheck).toHaveBeenCalled();
    },
  );

  it.each(['local_ahead', 'diverged'] as const)('blocks base %s', async (relation) => {
    await setup();
    merger.base.relation = relation;
    await start();
    await blocked('base_out_of_sync');
  });

  it('builds on an upstream that is ahead', async () => {
    await setup();
    merger.base.relation = 'local_behind';
    merger.base.remote!.commit = 'upstream';
    await start();
    await merged();
    expect(merger.build.mock.calls[0]![1].onto).toBe('upstream');
  });

  it('blocks missing checks', async () => {
    await setup({
      adjust: (c) => {
        c.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    await start();
    await blocked('check_unavailable');
  });

  it('blocks a thrown check', async () => {
    const executor = fakeExecutor();
    vi.mocked(executor.run).mockRejectedValue(new Error('check broke'));
    await setup({
      executor,
      adjust: (c) => {
        c.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    await start();
    await blocked('check_error');
  });

  it('blocks overlapping local checkout changes', async () => {
    await setup();
    merger.checkoutConflicts.mockResolvedValue(['a.ts']);
    await start();
    await blocked('local_checkout');
  });

  it.each([
    ['rejected', 'push_rejected'],
    ['unreachable', 'remote_unreachable'],
    ['non_fast_forward', 'remote_moved'],
  ] as const)('blocks push %s', async (reason, expected) => {
    await setup();
    merger.push.mockResolvedValue({ ok: false, reason, message: reason });
    await start();
    await blocked(expected);
    expect(
      h!.domain.inbox
        .list('AR', { kind: 'alert', state: 'open' })
        .filter((i) => i.payload.alert === 'merge_blocked'),
    ).toHaveLength(0);
    expect(task().stageId).toBe('code_review');
  });

  it('alerts only the human merger and retries a remote landed merge without pushing twice', async () => {
    await setup({
      adjust: (c) => {
        c.team.merger = { kind: 'member', handle: 'owner' };
      },
    });
    merger.advance.mockResolvedValueOnce({
      ok: false,
      reason: 'checkout_in_the_way',
      message: 'dirty',
      paths: ['a.ts'],
    });
    await start('AR-1', OWNER_ACTOR);
    await blocked('local_checkout');
    expect(row()?.landed).toBe('remote');
    const id = row()!.id;
    const alert = h!.domain.inbox
      .list('AR', { kind: 'alert', state: 'open' })
      .find((i) => i.payload.alert === 'merge_blocked')!;
    expect(alert.assignees).toEqual(['owner']);
    await start('AR-1', OWNER_ACTOR);
    await merged();
    expect(h!.repos.taskMerges.get(id)?.state).toBe('merged');
    expect(merger.push).toHaveBeenCalledTimes(1);
    expect(h!.domain.inbox.get('AR', alert.id).state).toBe('cancelled');
  });

  it('cancels at a boundary when the card is moved back', async () => {
    await setup();
    const gate = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build.mockReturnValueOnce(gate.promise);
    await start();
    await vi.waitFor(() => expect(merger.build).toHaveBeenCalled());
    const id = row()!.id;
    await h!.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    gate.resolve({ ok: true, mergeCommit: 'cancelled', changed: [] });
    await vi.waitFor(() => expect(h!.repos.taskMerges.get(id)?.state).toBe('cancelled'));
    expect(merger.push).not.toHaveBeenCalled();
    expect(events('task_merged')).toHaveLength(0);
  });

  it('cancels the rebuilt attempt after non-fast-forward', async () => {
    await setup();
    merger.push.mockResolvedValueOnce({ ok: false, reason: 'non_fast_forward', message: 'moved' });
    const gate = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build
      .mockResolvedValueOnce({ ok: true, mergeCommit: 'first', changed: [] })
      .mockReturnValueOnce(gate.promise);
    await start();
    await vi.waitFor(() => expect(merger.build).toHaveBeenCalledTimes(2));
    const id = row()!.id;
    await h!.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    gate.resolve({ ok: true, mergeCommit: 'second', changed: [] });
    await vi.waitFor(() => expect(h!.repos.taskMerges.get(id)?.state).toBe('cancelled'));
    expect(merger.push).toHaveBeenCalledTimes(1);
    expect(events('task_merged')).toHaveLength(0);
  });

  it('serializes two cards on one repository', async () => {
    await setup();
    await card('AR-2', 'web', 'dev-2');
    const gate = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build.mockReturnValueOnce(gate.promise);
    await start();
    await start('AR-2');
    await vi.waitFor(() => expect(merger.build).toHaveBeenCalledTimes(1));
    expect(row('AR-2')?.state).toBe('queued');
    gate.resolve({ ok: true, mergeCommit: 'first', changed: [] });
    await merged('AR-2');
    expect(merger.build.mock.calls.map((call) => call[1].commit)).toEqual(['approved-AR-1', 'approved-AR-2']);
  });

  it.each(['move', 'update', 'board', 'hand_on'] as const)(
    'gates the %s path without starting a merge',
    async (route) => {
      await setup({
        adjust: (c) => {
          if (route === 'hand_on') c.team.cardMover = { kind: 'project_manager' };
        },
      });
      const action =
        route === 'update'
          ? h!.domain.tasks.update('AR', 'AR-1', { stageId: 'done' }, OWNER_ACTOR)
          : route === 'board'
            ? h!.domain.tasks.moveOnBoard(
                'AR',
                'AR-1',
                { columnId: 'done', fromStageId: 'code_review', placement: { at: 'top' } },
                OWNER_ACTOR,
              )
            : h!.domain.tasks.moveToStage(
                'AR',
                'AR-1',
                'done',
                route === 'hand_on' ? aiActor('dev-1') : OWNER_ACTOR,
              );
      await expect(action).rejects.toMatchObject({
        code: 'task_not_merged',
        details: { reason: 'not_merged', merger: 'dev-1' },
      });
      expect(task().stageId).toBe('code_review');
      expect(row()?.state).toBe('requested');
      expect(merger.build).not.toHaveBeenCalled();
    },
  );

  it('records a discovered manual merge only with a persistent handover', async () => {
    await setup();
    merger.base.contains = { local: true, remote: true };
    await move();
    expect(task().merged).toMatchObject({ via: 'found', commit: 'approved-AR-1' });
    expect(task().merged?.by).toBeUndefined();
    expect(task().merged?.mergeCommit).toBeUndefined();
    expect(events('task_merged')[0]?.data.mergeId).toBeUndefined();
    expect(merger.build).not.toHaveBeenCalled();
  });

  it('refuses a locally merged commit missing upstream', async () => {
    await setup();
    merger.base.contains.local = true;
    await expect(move()).rejects.toMatchObject({
      code: 'task_not_merged',
      details: { reason: 'not_on_remote' },
    });
  });

  it('allows repositories whose integrating session merges', async () => {
    await setup({
      adjust: (c) => {
        delete c.project.repos[0]!.requireMerge;
        c.project.repos[0]!.fullTestAtMerge = true;
      },
    });
    await move();
    expect(task().status).toBe('done');
    expect(merger.prepare).not.toHaveBeenCalled();
  });

  it('allows code-free cards with no head or handover', async () => {
    await setup();
    h!.repos.db.prepare('DELETE FROM task_handovers').run();
    h!.worktrees.existing.clear();
    h!.worktrees.heads.clear();
    await move();
    expect(task().status).toBe('done');
    expect(merger.prepare).not.toHaveBeenCalled();
  });

  it('redirects a pending request when the configured merger changes', async () => {
    await setup();
    await h!.domain.merges.reconcile('AR', 'AR-1');
    const id = row()!.id;
    const loaded = await h!.domain.projects.load('AR');
    await h!.domain.projects.patch(
      'AR',
      { baseVersion: loaded.version, merger: { kind: 'member', handle: 'owner' } },
      { actor: OWNER_ACTOR, author: OWNER },
    );
    expect(h!.repos.taskMerges.get(id)?.state).toBe('cancelled');
    expect(row()).toMatchObject({ state: 'requested', merger: 'owner' });
    expect(h!.domain.inbox.list('AR', { kind: 'merge_request', state: 'open' })).toHaveLength(1);
  });

  it('attributes a reviewer merge to the last label setter owning the review stage', async () => {
    await setup({
      adjust: (c) => {
        c.team.merger = { kind: 'code_reviewer' };
      },
    });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    expect(row()?.merger).toBe('cr');
    expect(merger.build).not.toHaveBeenCalled();
  });

  it('restores a running row from prepare after restart and releases its checkout', async () => {
    await setup({ persistent: true });
    await h!.domain.merges.stop();
    await start();
    const saved = row()!;
    h!.repos.taskMerges.save({ ...saved, state: 'running', step: 'checking' });
    const next = fakeMerger();
    h = await restartDomainHarness(h!, { merger: next });
    merger = next;
    await merged();
    expect(next.prepare).toHaveBeenCalled();
    expect(next.releaseCheck).toHaveBeenCalled();
    expect(h!.repos.taskMerges.get(saved.id)?.state).toBe('merged');
  });

  it('runs separate repositories concurrently', async () => {
    await setup({
      adjust: (c) => {
        c.project.repos.push({ name: 'api', path: 'api', defaultBranch: 'main', requireMerge: true });
      },
    });
    await card('AR-2', 'api', 'dev-2');
    const first = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    const second = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await start();
    await start('AR-2');
    await vi.waitFor(() => expect(merger.build).toHaveBeenCalledTimes(2));
    first.resolve({ ok: true, mergeCommit: 'first', changed: [] });
    second.resolve({ ok: true, mergeCommit: 'second', changed: [] });
    await merged();
    await merged('AR-2');
  });

  it('reuses a passed full check only when the approved commit contains the base', async () => {
    const executor = fakeExecutor();
    await setup({
      executor,
      adjust: (c) => {
        c.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    const at = new Date().toISOString();
    h!.repos.fullTestRuns.queue({
      id: 'passed',
      projectKey: 'AR',
      taskKey: 'AR-1',
      repo: 'web',
      branch: 'task/AR-1',
      commit: 'approved-AR-1',
      createdAt: at,
    });
    h!.repos.fullTestRuns.finish('passed', { status: 'passed', finishedAt: at });
    merger.isAncestor.mockImplementation(
      async (_ref, input) => input.ancestor === 'base' && input.commit === 'approved-AR-1',
    );
    await start();
    await merged();
    expect(task().merged?.check).toMatchObject({ reused: true, runId: 'passed', status: 'passed' });
    expect(executor.run).not.toHaveBeenCalled();
  });

  it('blocks if the gate changes while the commit is built', async () => {
    await setup();
    const gate = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build.mockReturnValueOnce(gate.promise);
    await start();
    await vi.waitFor(() => expect(merger.build).toHaveBeenCalled());
    h!.repos.tasks.update(task().id, { labels: [] });
    gate.resolve({ ok: true, mergeCommit: 'gated', changed: [] });
    await blocked('gate_changed');
    expect(merger.push).not.toHaveBeenCalled();
  });

  it('blocks unexpected git errors', async () => {
    await setup();
    merger.prepare.mockRejectedValue(new Error('git broke'));
    await start();
    await blocked('merge_error');
    expect(merger.releaseCheck).toHaveBeenCalled();
  });

  it.each(['wrong_base', 'wrong_head', 'unavailable'] as const)('blocks PR %s', async (mode) => {
    await setup();
    h!.domain.tasks.addLink('AR', 'AR-1', { kind: 'pull_request', repo: 'acme/web', ref: '7' }, OWNER_ACTOR);
    if (mode !== 'unavailable')
      h!.github.prs.set(
        'acme/web#7',
        pullRequest({
          baseRef: mode === 'wrong_base' ? 'other' : 'main',
          headSha: mode === 'wrong_head' ? 'other' : 'approved-AR-1',
        }),
      );
    await start();
    await blocked('pull_request');
    expect(merger.build).not.toHaveBeenCalled();
  });

  it('keeps the approval label and requests the merge instead of moving after decide', async () => {
    await setup({
      adjust: (c) => {
        c.pipeline.stages
          .find((s) => s.id === 'done')!
          .gate!.conditions.push({ type: 'has_label', label: 'merge-ok' });
      },
    });
    // The commit is already merged when the human approval is requested, but the remote moves away before approval.
    merger.base.contains = { local: true, remote: true };
    h!.repos.db.prepare('DELETE FROM task_handovers').run();
    const requested = await move();
    expect(requested.pendingApproval).toHaveLength(1);
    merger.base.contains = { local: false, remote: false };
    h!.repos.taskHandovers.save({
      projectKey: 'AR',
      taskKey: 'AR-1',
      commit: 'approved-AR-1',
      branch: 'task/AR-1',
      stageId: 'code_review',
      at: new Date().toISOString(),
    });
    await h!.domain.inbox.resolve(
      'AR',
      requested.pendingApproval[0]!.id,
      { optionId: 'approve' },
      { handle: 'owner', access: 'owner' },
    );
    expect(task().labels).toContain('merge-ok');
    expect(task().stageId).toBe('code_review');
    expect(row()?.state).toBe('requested');
    expect(merger.build).not.toHaveBeenCalled();
  });

  it('preserves and repins the last handover after leaving review', async () => {
    await setup();
    await h!.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await h!.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    const tree = h!.worktrees.existing.get('AR/AR-1/web')!;
    h!.worktrees.heads.set(tree.path, { ...h!.worktrees.heads.get(tree.path)!, commit: 'new-approved' });
    await h!.domain.tasks.repinReview('AR', 'AR-1', 'dev-1');
    expect(h!.repos.taskHandovers.get('AR', 'AR-1')?.commit).toBe('new-approved');
  });

  it('reads the head at start and refuses uncommitted work without a handover', async () => {
    await setup();
    h!.repos.db.prepare('DELETE FROM task_handovers').run();
    const tree = h!.worktrees.existing.get('AR/AR-1/web')!;
    h!.worktrees.heads.set(tree.path, { ...h!.worktrees.heads.get(tree.path)!, dirty: true, changes: 1 });
    await expect(start()).rejects.toMatchObject({ code: 'handover_uncommitted' });
    expect(row()?.state).toBe('requested');
    expect(merger.build).not.toHaveBeenCalled();
  });

  it('refuses the gate without a merger on the card engine and blocks an explicit start', async () => {
    await setup({ unavailable: true });
    await expect(move()).rejects.toMatchObject({
      code: 'task_not_merged',
      details: { reason: 'engine_unavailable' },
    });
    await start();
    await blocked('engine_unavailable');
    expect(task().stageId).toBe('code_review');
  });

  it('reports each missing merge in a group drop without moving any card', async () => {
    await setup();
    await card('AR-2', 'web', 'dev-2', 'AR-1');
    const result = await h!.domain.tasks.moveOnBoard(
      'AR',
      'AR-1',
      { columnId: 'done', fromStageId: 'code_review', placement: { at: 'top' }, withSubtasks: true },
      OWNER_ACTOR,
    );
    expect(result.group).toEqual([
      expect.objectContaining({
        taskKey: 'AR-1',
        outcome: 'blocked',
        code: 'task_not_merged',
        unmet: [],
        approvals: [],
      }),
      expect.objectContaining({
        taskKey: 'AR-2',
        outcome: 'blocked',
        code: 'task_not_merged',
        unmet: [],
        approvals: [],
      }),
    ]);
    expect(task().stageId).toBe('code_review');
    expect(task('AR-2').stageId).toBe('code_review');
    expect(merger.build).not.toHaveBeenCalled();
  });

  it('AutoAdvance requests the merge but never starts it', async () => {
    await setup();
    vi.mocked(h!.domain.autoAdvance.check).mockRestore();
    for (const session of h!.domain.sessions.list('AR')) await h!.domain.sessions.stop('AR', session.id);
    await h!.domain.autoAdvance.check(task());
    await vi.waitFor(() => expect(row()?.state).toBe('requested'));
    expect(task().stageId).toBe('code_review');
    expect(merger.build).not.toHaveBeenCalled();
  });

  it('opens another human request carrying failed check details', async () => {
    await setup({
      adjust: (c) => {
        c.team.merger = { kind: 'member', handle: 'owner' };
      },
    });
    merger.build.mockResolvedValue({ ok: false, conflict: ['a.ts'] });
    await start('AR-1', OWNER_ACTOR);
    await vi.waitFor(() => expect(row()?.state).toBe('failed'));
    const item = h!.domain.inbox.list('AR', { kind: 'merge_request', state: 'open' })[0]!;
    expect(item.payload.mergeRequest).toMatchObject({
      failure: { reason: 'conflict', base: 'base', files: ['a.ts'] },
    });
  });

  it('aborts a running check after moving the card back', async () => {
    let signal: AbortSignal | undefined;
    const executor = fakeExecutor();
    vi.mocked(executor.run).mockImplementation(async (_spec, current) => {
      signal = current;
      return new Promise((resolve) =>
        current.addEventListener('abort', () => resolve({ ...passed, outcome: 'error' }), { once: true }),
      );
    });
    await setup({
      executor,
      adjust: (c) => {
        c.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    await start();
    await vi.waitFor(() => expect(signal).toBeDefined());
    const id = row()!.id;
    await h!.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await vi.waitFor(() => expect(h!.repos.taskMerges.get(id)?.state).toBe('cancelled'));
    expect(signal?.aborted).toBe(true);
    expect(merger.push).not.toHaveBeenCalled();
  });

  it('does not cancel after push starts even if the card is moved back', async () => {
    await setup();
    const pushed = deferred<Awaited<ReturnType<BranchMerger['push']>>>();
    merger.push.mockReturnValueOnce(pushed.promise);
    await start();
    await vi.waitFor(() => expect(merger.push).toHaveBeenCalled());
    await h!.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    pushed.resolve({ ok: true });
    await merged();
    expect(task().stageId).toBe('development');
    expect(events('task_merged')).toHaveLength(1);
  });

  it('checks the updated repository when a single update changes repo and stage', async () => {
    await setup({
      adjust: (c) => {
        c.project.repos[0]!.requireMerge = false;
        c.project.repos.push({ name: 'api', path: 'api', defaultBranch: 'main', requireMerge: true });
      },
    });
    await expect(
      h!.domain.tasks.update('AR', 'AR-1', { repo: 'api', stageId: 'done' }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'task_not_merged' });
    expect(task().repo).toBe('web');
    expect(task().stageId).toBe('code_review');
  });

  it('starts a new merger session with merge as the persisted cause', async () => {
    await setup({
      adjust: (c) => {
        c.team.merger = { kind: 'member', handle: 'dev-2' };
      },
    });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    await vi.waitFor(() =>
      expect(h!.domain.sessions.list('AR', { member: 'dev-2', taskKey: 'AR-1' })[0]?.startCause?.kind).toBe(
        'merge',
      ),
    );
    expect(merger.build).not.toHaveBeenCalled();
  });

  it('restores a human request if its notification was interrupted', async () => {
    await setup({
      adjust: (c) => {
        c.team.merger = { kind: 'member', handle: 'owner' };
      },
    });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    const id = row()!.id;
    const item = h!.domain.inbox.list('AR', { kind: 'merge_request', state: 'open' })[0]!;
    h!.domain.inbox.cancel(item.id);
    await h!.domain.merges.reconcile('AR', 'AR-1');
    expect(row()?.id).toBe(id);
    expect(h!.domain.inbox.list('AR', { kind: 'merge_request', state: 'open' })).toHaveLength(1);
  });

  it('does not treat a failed head read as a code-free card', async () => {
    await setup();
    h!.repos.db.prepare('DELETE FROM task_handovers').run();
    vi.spyOn(h!.worktrees, 'head').mockRejectedValue(new Error('engine disconnected during read'));
    await expect(move()).rejects.toMatchObject({
      code: 'task_not_merged',
      details: { reason: 'engine_unavailable' },
    });
    expect(task().stageId).toBe('code_review');
    expect(row()).toBeNull();
    expect(await h!.domain.sessions.sourceHead(await h!.domain.projects.config('AR'), task())).toBeNull();
  });

  it('passes the current caller to the merge_task domain handler and gates MCP update_task', async () => {
    await setup();
    const session = h!.domain.sessions.list('AR', { member: 'dev-1', taskKey: 'AR-1' })[0]!;
    const ctx = { projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1', sessionId: session.id };
    await expect(h!.domain.teamTools.updateTask(ctx, { taskKey: 'AR-1', stageId: 'done' })).rejects.toThrow(
      'the approved commit is not on the default branch',
    );
    const gate = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build.mockReturnValueOnce(gate.promise);
    const result = await h!.domain.teamTools.mergeTask(ctx, { taskKey: 'AR-1' });
    expect(result.task.merge?.startedBy).toBe('dev-1');
    gate.resolve({ ok: true, mergeCommit: 'mcp', changed: [] });
    await merged();
  });

  it('hides merge state, records and events from clients', async () => {
    await setup();
    await h!.domain.merges.reconcile('AR', 'AR-1');
    const visible = withVisibleCardLinks({ handle: 'client', access: 'client' }, task(), () => true);
    expect(visible.merge).toBeUndefined();
    expect(clientCanSeeTimelineEvent({ type: 'task_merge_requested' } as never)).toBe(false);
    expect(clientCanSeeTimelineEvent({ type: 'task_merge_failed' } as never)).toBe(false);
  });
});
