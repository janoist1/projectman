import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import type { BranchMerger, FullTestExecutor, FullTestResult, MergeBaseState } from '../src/contracts';
import { withVisibleCardLinks, clientCanSeeTimelineEvent } from '../src/domain/visibility';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { pullRequest } from './helpers/fakes';

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

describe('merge on Done', () => {
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
    } = {},
  ) {
    merger = fakeMerger(opts.remote);
    h = await createDomainHarness({
      merger,
      fullTestExecutor: opts.executor,
      persistent: opts.persistent,
      adjust(config) {
        config.project.repos[0]!.mergeOnDone = true;
        config.pipeline.stages = config.pipeline.stages.filter(
          (stage) => stage.id !== 'merge' && stage.id !== 'release',
        );
        config.pipeline.stages.find((stage) => stage.id === 'done')!.gate = {
          conditions: [{ type: 'has_label', label: 'code-review-ok' }],
        };
        opts.adjust?.(config);
      },
    });
    await card('AR-1', 'web', 'dev-1');
  }
  async function card(key: string, repo: string, assignee: string) {
    await h!.domain.tasks.create('AR', { title: `Card ${key}`, repo }, OWNER_ACTOR);
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
  const done = async (key = 'AR-1') => vi.waitFor(() => expect(task(key).status).toBe('done'));
  const blocked = async (reason: string) => vi.waitFor(() => expect(row()?.block?.reason).toBe(reason));
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  });

  it.each([true, false])('lands the approved commit with remote=%s before entering Done', async (remote) => {
    await setup({ remote });
    const gate = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build.mockReturnValueOnce(gate.promise);
    const result = await move();
    expect(result).toMatchObject({ moved: false, merging: { commit: 'approved-AR-1', state: 'queued' } });
    expect(task().stageId).toBe('code_review');
    gate.resolve({ ok: true, mergeCommit: 'landed', changed: ['a.ts'] });
    await done();
    expect(merger.push).toHaveBeenCalledTimes(remote ? 1 : 0);
    expect(merger.advance).toHaveBeenCalledWith(
      { projectKey: 'AR', repo: 'web' },
      { base: 'main', from: 'base', to: 'landed' },
    );
    expect(task().merged).toMatchObject({ mergeCommit: 'landed', commit: 'approved-AR-1' });
    expect(task().merge).toBeUndefined();
    expect(events('task_merged')).toHaveLength(1);
    if (remote) expect(task().merged?.pushed?.commitUrl).toBe('https://github.com/acme/web/commit/landed');
  });

  it('finishes without a merged record when the commit is already on the base', async () => {
    await setup();
    merger.base.contains.remote = true;
    await move();
    await done();
    expect(task().merged).toBeUndefined();
    expect(merger.build).not.toHaveBeenCalled();
  });

  it('preserves handovers after the pin is cleared and merges that commit', async () => {
    await setup();
    const config = await h!.domain.projects.config('AR');
    h!.repos.tasks.update(task().id, { stageId: 'development', labels: [] });
    await h!.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    expect(h!.repos.taskHandovers.get('AR', 'AR-1')?.commit).toBe('approved-AR-1');
    h!.repos.reviewPins.clear('AR-1');
    h!.repos.tasks.update(task().id, { labels: ['code-review-ok'] });
    const tree = h!.worktrees.existing.get('AR/AR-1/web')!;
    h!.worktrees.heads.set(tree.path, {
      ...h!.worktrees.heads.get(tree.path)!,
      commit: 'new-head',
      dirty: true,
    });
    await move();
    await done();
    expect(task().merged?.commit).toBe('approved-AR-1');
    expect(config.project.repos[0]!.mergeOnDone).toBe(true);
  });

  it('reads the current clean head without a handover and refuses uncommitted work', async () => {
    await setup();
    h!.repos.db.prepare('DELETE FROM task_handovers').run();
    const tree = h!.worktrees.existing.get('AR/AR-1/web')!;
    const head = h!.worktrees.heads.get(tree.path)!;
    h!.worktrees.heads.set(tree.path, { ...head, dirty: true, changes: 1 });
    await expect(move()).rejects.toMatchObject({ code: 'handover_uncommitted' });
    expect(row()).toBeNull();
    h!.worktrees.heads.set(tree.path, head);
    await move();
    await done();
    expect(task().merged?.commit).toBe(head.commit);
  });

  it('sends conflicts back as a fix round without changing the base', async () => {
    await setup();
    merger.build.mockResolvedValue({ ok: false, conflict: ['a.ts', 'b.ts'] });
    await move();
    await vi.waitFor(() => expect(task().stageId).toBe('development'));
    expect(
      events('task_stage_changed').find((event) => event.data.mergeFailed)?.data.mergeFailed,
    ).toMatchObject({ reason: 'conflict', files: ['a.ts', 'b.ts'] });
    expect(h!.domain.cardMeasure.withRounds(h!.domain.tasks.detail('AR', 'AR-1')).fixRounds?.rounds).toBe(1);
    expect(merger.advance).not.toHaveBeenCalled();
    expect(merger.push).not.toHaveBeenCalled();
  });

  it.each(['passed', 'failed', 'error'] as const)(
    'handles check outcome %s and releases its checkout',
    async (outcome) => {
      const executor = fakeExecutor({
        ...passed,
        outcome,
        exitCode: outcome === 'passed' ? 0 : 1,
        outputTail: Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(200)}`).join('\n'),
      });
      await setup({
        executor,
        adjust: (config) => {
          config.project.repos[0]!.reviewTest = reviewTest;
        },
      });
      await move();
      if (outcome === 'passed') {
        await done();
        expect(task().merged?.check?.status).toBe('passed');
      } else if (outcome === 'error') await blocked('check_error');
      else {
        await vi.waitFor(() => expect(task().stageId).toBe('development'));
        const failed = events('task_stage_changed').find((event) => event.data.mergeFailed)?.data
          .mergeFailed as { outputTail: string };
        expect(failed.outputTail.length).toBeLessThanOrEqual(8000);
        expect(failed.outputTail.split('\n').length).toBeLessThanOrEqual(40);
        expect(merger.push).not.toHaveBeenCalled();
      }
      expect(merger.releaseCheck).toHaveBeenCalled();
      expect(executor.run).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/fake/check',
          command: 'npm test',
          maxWorkers: 2,
          timeoutMs: 600000,
        }),
        expect.any(AbortSignal),
      );
    },
  );

  it('reuses a passed full test only when the approved commit contains the base', async () => {
    const executor = fakeExecutor();
    await setup({
      executor,
      adjust: (config) => {
        config.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    h!.repos.fullTestRuns.queue({
      id: 'passed-run',
      projectKey: 'AR',
      taskKey: 'AR-1',
      repo: 'web',
      branch: 'task/AR-1',
      commit: 'approved-AR-1',
      createdAt: new Date().toISOString(),
    });
    h!.repos.fullTestRuns.finish('passed-run', { status: 'passed', finishedAt: new Date().toISOString() });
    merger.isAncestor.mockImplementation(async (_ref, input) => input.ancestor === 'base');
    await move();
    await done();
    expect(task().merged?.check).toMatchObject({ reused: true, runId: 'passed-run' });
    expect(executor.run).not.toHaveBeenCalled();
  });

  it.each(['local_ahead', 'diverged'] as const)('blocks an out-of-sync base (%s)', async (relation) => {
    await setup();
    merger.base.relation = relation;
    await move();
    await blocked('base_out_of_sync');
    expect(task().stageId).toBe('code_review');
    expect(merger.build).not.toHaveBeenCalled();
  });
  it('builds onto the remote when the local base is behind', async () => {
    await setup();
    merger.base.relation = 'local_behind';
    merger.base.remote!.commit = 'remote-base';
    await move();
    await done();
    expect(merger.build.mock.calls[0]![1].onto).toBe('remote-base');
  });
  it('blocks a dirty default checkout', async () => {
    await setup();
    merger.checkoutConflicts.mockResolvedValue(['a.ts']);
    await move();
    await blocked('local_checkout');
    expect(merger.push).not.toHaveBeenCalled();
  });
  it('blocks without a check executor', async () => {
    await setup({
      adjust: (config) => {
        config.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    await move();
    await blocked('check_unavailable');
  });
  it('blocks thrown git errors', async () => {
    await setup();
    merger.build.mockRejectedValue(new Error('git failed'));
    await move();
    await blocked('merge_error');
  });

  it.each(['rejected', 'unreachable', 'non_fast_forward'] as const)(
    'blocks push failure %s',
    async (reason) => {
      await setup();
      merger.push.mockResolvedValue({ ok: false, reason, message: 'push failed' });
      await move();
      await blocked(
        reason === 'rejected'
          ? 'push_rejected'
          : reason === 'unreachable'
            ? 'remote_unreachable'
            : 'remote_moved',
      );
      expect(merger.push).toHaveBeenCalledTimes(reason === 'non_fast_forward' ? 2 : 1);
      expect(merger.advance).not.toHaveBeenCalled();
    },
  );
  it('rebuilds and rechecks after one remote race', async () => {
    await setup();
    merger.push.mockResolvedValueOnce({ ok: false, reason: 'non_fast_forward', message: 'remote moved' });
    await move();
    await done();
    expect(merger.prepare).toHaveBeenCalledTimes(2);
    expect(merger.build).toHaveBeenCalledTimes(2);
  });
  it('retries a remote landed merge with the same id and only advances', async () => {
    await setup();
    merger.advance.mockResolvedValueOnce({
      ok: false,
      reason: 'checkout_in_the_way',
      message: 'dirty',
      paths: ['a.ts'],
    });
    await move();
    await blocked('local_checkout');
    const id = row()!.id;
    expect(row()?.landed).toBe('remote');
    expect(h!.domain.inbox.list('AR', { kind: 'alert', state: 'open' })).toHaveLength(1);
    await h!.domain.merges.retry('AR', 'AR-1');
    await done();
    expect(events('task_merged')[0]?.data.mergeId).toBe(id);
    expect(merger.push).toHaveBeenCalledTimes(1);
    expect(merger.build).toHaveBeenCalledTimes(1);
    expect(h!.domain.inbox.list('AR', { kind: 'alert', state: 'open' })).toHaveLength(0);
    await expect(h!.domain.merges.retry('AR', 'AR-1')).rejects.toMatchObject({ code: 'merge_not_blocked' });
  });

  it('rechecks the gate before push', async () => {
    await setup();
    merger.checkoutConflicts.mockImplementation(async () => {
      h!.repos.tasks.update(task().id, { labels: [] });
      return [];
    });
    await move();
    await blocked('gate_changed');
    expect(merger.push).not.toHaveBeenCalled();
  });
  it.each(['wrong-base', 'new-head', 'unreadable'])('blocks a mismatched PR (%s)', async (scenario) => {
    await setup();
    h!.repos.tasks.upsertLink(
      task().id,
      { kind: 'pull_request', repo: 'acme/web', ref: '7' },
      new Date().toISOString(),
    );
    if (scenario !== 'unreadable')
      h!.github.prs.set(
        'acme/web#7',
        pullRequest({
          headSha: scenario === 'new-head' ? 'new' : 'approved-AR-1',
          baseRef: scenario === 'wrong-base' ? 'other' : 'main',
        }),
      );
    await move();
    await blocked('pull_request');
    expect(merger.build).not.toHaveBeenCalled();
  });
  it('records matching open PRs after landing', async () => {
    await setup();
    h!.repos.tasks.upsertLink(
      task().id,
      { kind: 'pull_request', repo: 'acme/web', ref: '7' },
      new Date().toISOString(),
    );
    h!.github.prs.set('acme/web#7', pullRequest({ headSha: 'approved-AR-1' }));
    await move();
    await done();
    expect(task().merged?.pullRequests).toEqual([{ number: 7, url: 'https://github.com/acme/web/pull/7' }]);
  });

  it('queues two cards of a repo FIFO while another repo runs concurrently', async () => {
    await setup({
      adjust: (config) => {
        config.project.repos.push({ name: 'api', path: 'api', defaultBranch: 'main', mergeOnDone: true });
        config.team.limits.maxConcurrentAi = 5;
        const dev = config.team.members.find((member) => member.handle === 'dev-1');
        if (dev?.kind === 'ai') dev.capacity = 2;
      },
    });
    await card('AR-2', 'web', 'dev-2');
    await card('AR-3', 'api', 'dev-1');
    const waiting = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build.mockReturnValueOnce(waiting.promise);
    await move();
    await vi.waitFor(() => expect(merger.build).toHaveBeenCalledTimes(1));
    await move('AR-2');
    await move('AR-3');
    await done('AR-3');
    expect(row('AR-2')?.state).toBe('queued');
    waiting.resolve({ ok: true, mergeCommit: 'first', changed: [] });
    await done();
    await done('AR-2');
    expect(merger.build.mock.calls.map(([ref, input]) => `${ref.repo}:${input.commit}`)).toEqual([
      'web:approved-AR-1',
      'api:approved-AR-3',
      'web:approved-AR-2',
    ]);
  });
  it('cancels a running check when the card moves back', async () => {
    const result = deferred<FullTestResult>();
    let signal: AbortSignal | undefined;
    const executor = fakeExecutor();
    executor.run = vi.fn(async (_spec, input) => {
      signal = input;
      input.addEventListener('abort', () => result.resolve({ ...passed, outcome: 'error' }));
      return result.promise;
    });
    await setup({
      executor,
      adjust: (config) => {
        config.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    await move();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await h!.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await vi.waitFor(() => expect(h!.repos.taskMerges.list('cancelled')).toHaveLength(1));
    expect(signal?.aborted).toBe(true);
    expect(merger.push).not.toHaveBeenCalled();
  });
  it('cancels queued and blocked merges on moves and closure, and clears alerts', async () => {
    await setup();
    await h!.domain.merges.stop();
    await move();
    await h!.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    expect(h!.repos.taskMerges.list('cancelled')).toHaveLength(1);
    expect(row()).toBeNull();
    await h!.domain.merges.init();
    h!.repos.tasks.update(task().id, { stageId: 'code_review', labels: ['code-review-ok'] });
    merger.push.mockResolvedValue({ ok: false, reason: 'rejected', message: 'rejected' });
    await move();
    await blocked('push_rejected');
    await h!.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
    expect(row()).toBeNull();
    expect(h!.domain.inbox.list('AR', { kind: 'alert', state: 'open' })).toHaveLength(0);
  });
  it('returns the merging task from a task update without asking for approval', async () => {
    await setup();
    const build = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build.mockReturnValueOnce(build.promise);
    const result = await h!.domain.tasks.update('AR', 'AR-1', { stageId: 'done' }, OWNER_ACTOR);
    expect(result.merge).toMatchObject({ commit: 'approved-AR-1' });
    expect(result.stageId).toBe('code_review');
    build.resolve({ ok: true, mergeCommit: 'update-merge', changed: [] });
    await done();
  });
  it('keeps a successful merge successful when checkout cleanup fails', async () => {
    await setup();
    merger.releaseCheck.mockRejectedValue(new Error('checkout busy'));
    await move();
    await done();
    expect(task().merged).toBeDefined();
  });
  it('recovers a push completed before its landed write without rebuilding or pushing again', async () => {
    await setup();
    await h!.domain.merges.stop();
    await move();
    const queued = row()!;
    h!.repos.taskMerges.save({ ...queued, state: 'running', step: 'pushing', mergeCommit: 'crash-merge' });
    merger.base.remote!.commit = 'crash-merge';
    merger.base.contains.remote = true;
    merger.isAncestor.mockImplementation(
      async (_ref, input) => input.ancestor === 'crash-merge' && input.commit === 'crash-merge',
    );
    await h!.domain.merges.init();
    await done();
    expect(merger.build).not.toHaveBeenCalled();
    expect(merger.push).not.toHaveBeenCalled();
    expect(task().merged?.mergeCommit).toBe('crash-merge');
  });
  it('finishes and records a push already started even if the card moved away', async () => {
    await setup();
    const push = deferred<Awaited<ReturnType<BranchMerger['push']>>>();
    merger.push.mockReturnValueOnce(push.promise);
    await move();
    await vi.waitFor(() => expect(merger.push).toHaveBeenCalledTimes(1));
    await h!.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    push.resolve({ ok: true });
    await vi.waitFor(() => expect(task().merged).toBeDefined());
    expect(task().stageId).toBe('development');
    expect(events('task_merged')).toHaveLength(1);
  });

  it('returns merging on ordinary updates and board group moves', async () => {
    await setup();
    await card('AR-2', 'web', 'dev-2');
    await h!.domain.tasks.update('AR', 'AR-2', { parentKey: 'AR-1' }, OWNER_ACTOR);
    const gate = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
    merger.build.mockReturnValueOnce(gate.promise);
    const board = await h!.domain.tasks.moveOnBoard(
      'AR',
      'AR-1',
      { fromStageId: 'code_review', columnId: 'done', placement: { at: 'end' }, withSubtasks: true },
      OWNER_ACTOR,
    );
    expect(board.outcome).toBe('merging');
    expect(board.group?.map((item) => item.outcome)).toEqual(['merging', 'merging']);
    gate.resolve({ ok: true, mergeCommit: 'group', changed: [] });
    await done();
    await done('AR-2');
  });
  it('queues after a human approves the Done move', async () => {
    await setup({
      adjust: (config) => {
        config.pipeline.stages
          .find((stage) => stage.id === 'done')!
          .gate!.conditions.push({ type: 'has_label', label: 'merge-ok' });
      },
    });
    const result = await move();
    expect(result.pendingApproval).toHaveLength(1);
    expect(row()).toBeNull();
    await h!.domain.inbox.resolve(
      'AR',
      result.pendingApproval[0]!.id,
      { optionId: 'approve' },
      { handle: 'owner', access: 'owner' },
    );
    await done();
    expect(task().merged?.commit).toBe('approved-AR-1');
  });

  it('resumes a persisted running row from prepare after restart', async () => {
    await setup({ persistent: true });
    await h!.domain.merges.stop();
    await move();
    const queued = row()!;
    h!.repos.taskMerges.save({ ...queued, state: 'running', step: 'checking' });
    h = await restartDomainHarness(h!, { merger });
    await done();
    expect(merger.prepare).toHaveBeenCalledTimes(1);
    expect(task().merged?.commit).toBe(queued.commit);
    expect(merger.releaseCheck).toHaveBeenCalledWith(
      { projectKey: 'AR', repo: 'web' },
      { mergeId: queued.id },
    );
  });
  it('blocks an unavailable engine instead of marking Done', async () => {
    await setup();
    const unavailable = { ...merger };
    h!.domain.tasks.useMerges(
      new (await import('../src/domain/merges')).Merges({
        ctx: h!.domain.ctx,
        projects: h!.domain.projects,
        tasks: h!.domain.tasks,
        sessions: h!.domain.sessions,
        messaging: h!.domain.messaging,
        timeline: h!.domain.timeline,
        inbox: h!.domain.inbox,
        github: h!.github,
        engines: { get: () => null, ids: () => [], engineFor: () => null, onChange: () => () => {} },
      }),
    );
    await move();
    await blocked('engine_unavailable');
    expect(unavailable.build).not.toHaveBeenCalled();
  });
  it.each(['no-repo', 'integrator', 'no-source'] as const)(
    'keeps the existing Done path for %s',
    async (scenario) => {
      await setup();
      await h!.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
        if (scenario === 'no-repo') config.project.repos = [];
        else if (scenario === 'integrator') {
          delete config.project.repos[0]!.mergeOnDone;
          config.project.repos[0]!.fullTestAtMerge = true;
        }
        return 'Set merge policy';
      });
      if (scenario === 'no-repo') h!.repos.tasks.update(task().id, { repo: null });
      if (scenario === 'no-source') {
        h!.repos.db.prepare('DELETE FROM task_handovers').run();
        h!.worktrees.heads.clear();
      }
      expect((await move()).moved).toBe(true);
      expect(task().status).toBe('done');
      expect(merger.build).not.toHaveBeenCalled();
    },
  );
  it('hides both merge fields and merge events from clients', async () => {
    await setup();
    await move();
    await done();
    const viewer = { access: 'client' as const, handle: 'client' };
    const visible = withVisibleCardLinks(
      viewer,
      {
        ...task(),
        merge: {
          id: 'm',
          repo: 'web',
          base: 'main',
          commit: 'c',
          branch: 'b',
          toStageId: 'done',
          requestedBy: 'owner',
          state: 'blocked',
          step: 'checking',
          startedAt: 'now',
          landed: 'nowhere',
        },
      },
      () => true,
    );
    expect(visible.merge).toBeUndefined();
    expect(visible.merged).toBeUndefined();
    expect(clientCanSeeTimelineEvent(events('task_merged')[0]!)).toBe(false);
  });
});
