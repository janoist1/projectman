import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateRequestOf } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import type { TaskMoves } from '../moves';
import { TaskService } from '../service';
import { TaskStore } from '../store';
import type {
  BranchMerger,
  EngineDirectory,
  FullTestExecutor,
  FullTestResult,
  MergeBaseState,
} from '../../../contracts';
import { EngineLinkLostError } from '../../../contracts';
import { LocalEngineDirectory } from '../../../runtime/sessions';
import { createCloudRemote } from '../../../engine-link/remote';
import type { CloudRemote } from '../../../engine-link/remote';
import { createFakeCloud } from '../../../engine-link/remote/test-support';
import {
  createDomainHarness,
  OWNER,
  OWNER_ACTOR,
  restartDomainHarness,
  waitForSession,
} from '../../../../test/helpers/domain-harness';
import type { DomainHarness } from '../../../../test/helpers/domain-harness';
import { flush, pullRequest } from '../../../../test/helpers/fakes';
import { makeLocalOnly } from '../../../../test/helpers/test-template';
import { aiActor, humanActor } from '../../../kernel';

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
    commitRegenerated: vi.fn<BranchMerger['commitRegenerated']>(async () => ({
      ok: true,
      mergeCommit: 'regenerated',
      changed: ['a.ts'],
    })),
    checkoutConflicts: vi.fn<BranchMerger['checkoutConflicts']>(async () => []),
    checkoutForCheck: vi.fn<BranchMerger['checkoutForCheck']>(async () => ({
      path: '/fake/check',
      gitDir: '/fake/git',
    })),
    releaseCheck: vi.fn<BranchMerger['releaseCheck']>(async () => {}),
    push: vi.fn<BranchMerger['push']>(async () => ({ ok: true })),
    remoteTags: vi.fn<BranchMerger['remoteTags']>(async () => []),
    pushTag: vi.fn<BranchMerger['pushTag']>(async () => ({ ok: true })),
    advance: vi.fn<BranchMerger['advance']>(async () => ({ ok: true })),
    readFile: vi.fn<BranchMerger['readFile']>(async () => ({ commit: 'c'.repeat(40), text: null })),
    commitFiles: vi.fn<BranchMerger['commitFiles']>(async () => ({ commit: 'd'.repeat(40), changed: [] })),
    listPaths: vi.fn<BranchMerger['listPaths']>(async () => ({
      commit: 'e'.repeat(40),
      paths: [],
      truncated: false,
    })),
    changedPaths: vi.fn<BranchMerger['changedPaths']>(async () => []),
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
  let engines: EngineDirectory;
  let remoteCheck: CloudRemote | undefined;
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
      /** Keeps the merge and release stages of the test template (a web client project). */
      fullPipeline?: boolean;
    } = {},
  ) {
    merger = fakeMerger(opts.remote);
    const getEngine = vi.spyOn(LocalEngineDirectory.prototype, 'get');
    h = await createDomainHarness({
      merger: opts.unavailable ? null : merger,
      fullTestExecutor: opts.executor,
      persistent: opts.persistent,
      adjust(config) {
        config.project.repos[0]!.requireMerge = true;
        config.team.merger = { kind: 'member', handle: 'dev-1' };
        if (opts.fullPipeline) makeLocalOnly(config);
        else {
          config.pipeline.stages = config.pipeline.stages.filter(
            (stage) => stage.id !== 'merge' && stage.id !== 'release',
          );
          config.pipeline.stages.find((stage) => stage.id === 'done')!.gate = {
            conditions: [{ type: 'has_label', label: 'code-review-ok' }],
          };
        }
        opts.adjust?.(config);
      },
    });
    engines = getEngine.mock.contexts[0] as EngineDirectory;
    getEngine.mockRestore();
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
  const fix = (options: { fixConflict?: boolean; resolution?: string }, actor = aiActor('dev-1')) =>
    h!.domain.merges.start('AR', 'AR-1', actor, options);
  async function conflictFailure() {
    await setup({ remote: false });
    merger.build.mockResolvedValueOnce({ ok: false, conflict: ['a.ts'] });
    await start();
    await vi.waitFor(() => expect(row()?.failure?.reason).toBe('conflict'));
  }
  it('requests a fix only for the nominated merger after a conflict and preserves the request id', async () => {
    await setup();
    await expect(fix({ fixConflict: true })).rejects.toMatchObject({ code: 'merge_fix_not_allowed' });
    merger.build.mockResolvedValueOnce({ ok: false, conflict: ['a.ts'] });
    await start();
    await vi.waitFor(() => expect(row()?.state).toBe('failed'));
    const id = row()!.id;
    await expect(fix({ fixConflict: true }, aiActor('cr'))).rejects.toMatchObject({
      code: 'merge_fix_not_allowed',
      details: { reason: 'not_merger' },
    });
    await fix({ fixConflict: true });
    expect(row()).toMatchObject({
      id,
      state: 'fixing',
      commit: 'approved-AR-1',
      fix: { by: 'dev-1', base: 'base', branch: 'merge-fix/AR-1' },
    });
    await expect(fix({ fixConflict: true })).rejects.toMatchObject({ code: 'merge_fix_not_allowed' });
    await expect(start()).rejects.toMatchObject({ code: 'merge_fix_not_allowed' });
  });
  it.each(['uncommitted', 'missing_commit', 'missing_base'] as const)(
    'refuses an invalid resolution: %s',
    async (reason) => {
      await conflictFailure();
      await fix({ fixConflict: true });
      const tree = [...h!.worktrees.fixes.values()][0]!;
      if (reason === 'uncommitted') h!.worktrees.heads.get(tree.path)!.dirty = true;
      if (reason === 'missing_base')
        merger.isAncestor.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await expect(fix({ resolution: 'Resolve imports in a.ts' })).rejects.toMatchObject({
        code: 'merge_fix_invalid',
        details: { reason },
      });
      expect(row()?.state).toBe('fixing');
    },
  );
  it('queues the clean fix head, records its note, accepts the approved source at the gate, and cleans up', async () => {
    await conflictFailure();
    await fix({ fixConflict: true });
    const id = row()!.id;
    const tree = [...h!.worktrees.fixes.values()][0]!;
    h!.worktrees.heads.get(tree.path)!.commit = 'resolved';
    merger.isAncestor.mockResolvedValue(true);
    await fix({ resolution: 'Resolve adjacent imports in a.ts' });
    expect(events('task_note').at(-1)).toMatchObject({
      actor: aiActor('dev-1'),
      data: { text: 'Resolve adjacent imports in a.ts' },
    });
    await merged();
    expect(task().merged).toMatchObject({
      commit: 'resolved',
      resolution: { commit: 'resolved', note: 'Resolve adjacent imports in a.ts' },
    });
    expect(h!.repos.taskMerges.get(id)?.fix?.base).toBe('base');
    expect(merger.build).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ commit: 'resolved' }),
    );
    await h!.domain.merges.checkGate(await h!.domain.projects.config('AR'), task(), 'done');
    expect(task().merged?.resolution?.note).toBe('Resolve adjacent imports in a.ts');
    await vi.waitFor(() => expect(h!.worktrees.fixes.size).toBe(0));
  });
  it('refuses a fix when the merger runs on another engine', async () => {
    await conflictFailure();
    vi.spyOn(h!.domain.sessions, 'cardEngineId').mockReturnValue('another');
    await expect(fix({ fixConflict: true })).rejects.toMatchObject({ code: 'merge_fix_engine_mismatch' });
  });
  it('rechecks open fix state after delayed sweep discovery', async () => {
    await conflictFailure();
    await fix({ fixConflict: true });
    const current = row()!;
    h!.repos.taskMerges.save({ ...current, state: 'cancelled' });
    const listed = await h!.worktrees.listMergeFixes({
      project: await h!.domain.projects.config('AR'),
      repoName: 'web',
    });
    const discovery = deferred<typeof listed>();
    const list = vi.spyOn(h!.worktrees, 'listMergeFixes').mockReturnValueOnce(discovery.promise);
    const remove = vi.spyOn(h!.worktrees, 'removeMergeFix');
    const sweep = h!.domain.worktreeSweep.run();
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    h!.repos.taskMerges.save({ ...current, state: 'fixing' });
    discovery.resolve(listed);
    await sweep;
    expect(remove).not.toHaveBeenCalled();
    expect(h!.worktrees.fixes.size).toBe(1);
  });
  it('serializes fix creation behind an in-flight sweep removal', async () => {
    await conflictFailure();
    await fix({ fixConflict: true });
    const current = row()!;
    h!.repos.taskMerges.save({ ...current, state: 'cancelled' });
    const gate = deferred<void>();
    const originalRemove = h!.worktrees.removeMergeFix.bind(h!.worktrees);
    const remove = vi.spyOn(h!.worktrees, 'removeMergeFix').mockImplementationOnce(async (args) => {
      await gate.promise;
      await originalRemove(args);
    });
    const sweep = h!.domain.worktreeSweep.run();
    await vi.waitFor(() => expect(remove).toHaveBeenCalled());
    h!.repos.taskMerges.save({ ...current, state: 'failed' });
    const ensure = vi.spyOn(h!.worktrees, 'ensureMergeFix');
    const pendingFix = fix({ fixConflict: true });
    expect(ensure).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([sweep, pendingFix]);
    expect(ensure).toHaveBeenCalledOnce();
    expect(row()?.state).toBe('fixing');
    expect(h!.worktrees.fixes.size).toBe(1);
  });
  // Any state but `failed` is refused alike; a failed check is the other refusing branch.
  it.each(['running', 'failed'] as const)(
    'refuses fixing an unrelated state or check failure: %s',
    async (state) => {
      await setup();
      await h!.domain.merges.reconcile('AR', 'AR-1');
      h!.repos.taskMerges.save({
        ...row()!,
        state,
        failure: { reason: 'check_failed', base: 'base', at: 'now' },
      });
      await expect(fix({ fixConflict: true })).rejects.toMatchObject({
        code: 'merge_fix_not_allowed',
        details: { reason: 'not_conflict' },
      });
      expect(h!.worktrees.fixes.size).toBe(0);
    },
  );
  async function workspaceConflict() {
    merger = fakeMerger(false);
    h = await createDomainHarness({
      memberWorkspaces: true,
      merger,
      adjust(config) {
        config.project.repos[0]!.requireMerge = true;
        config.team.merger = { kind: 'member', handle: 'dev-1' };
        config.pipeline.stages = config.pipeline.stages.filter(
          (stage) => stage.id !== 'merge' && stage.id !== 'release',
        );
      },
    });
    vi.spyOn(h.domain.autoAdvance, 'check').mockResolvedValue(undefined);
    const card = await h.domain.tasks.create('AR', { title: 'Conflict', repo: 'web' }, OWNER_ACTOR);
    const now = new Date().toISOString();
    h.repos.tasks.update(card.id, { stageId: 'code_review', labels: ['code-review-ok'] });
    h.repos.taskHandovers.save({
      projectKey: 'AR',
      taskKey: card.key,
      commit: 'approved',
      branch: 'task/AR-1',
      stageId: 'code_review',
      at: now,
    });
    h.repos.taskMerges.save({
      id: 'm',
      projectKey: 'AR',
      taskKey: card.key,
      repo: 'web',
      base: 'main',
      commit: 'approved',
      branch: 'task/AR-1',
      fromStageId: 'code_review',
      toStageId: 'done',
      merger: 'dev-1',
      requestedAt: now,
      state: 'failed',
      landed: 'nowhere',
      failure: { reason: 'conflict', base: 'base', at: now },
      createdAt: now,
      updatedAt: now,
    });
  }
  it('publishes the approved workspace commit before creating a fix and merges its resolution without republishing it', async () => {
    await workspaceConflict();
    const publish = vi
      .spyOn(h!.domain.sessions, 'prepareMergeSource')
      .mockImplementation(async (_c, _t, commit) => {
        if (commit !== 'approved') throw new Error('workspace_source_missing');
      });
    const ensureFix = vi.spyOn(h!.worktrees, 'ensureMergeFix');
    await fix({ fixConflict: true });
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'AR-1' }),
      'approved',
    );
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(ensureFix.mock.invocationCallOrder[0]!);
    expect(h!.worktrees.fixes.size).toBe(1);
    expect(row()).toMatchObject({ state: 'fixing', fix: { branch: 'merge-fix/AR-1' } });
    const tree = [...h!.worktrees.fixes.values()][0]!;
    h!.worktrees.heads.get(tree.path)!.commit = 'resolved';
    merger.isAncestor.mockResolvedValue(true);
    await fix({ resolution: 'Resolve the mechanical conflict' });
    await merged();
    expect(publish.mock.calls.map((call) => call[2])).not.toContain('resolved');
    expect(task()).toMatchObject({
      stageId: 'code_review',
      labels: ['code-review-ok'],
      merged: {
        commit: 'resolved',
        resolution: { commit: 'resolved', note: 'Resolve the mechanical conflict' },
      },
    });
    await move();
    expect(task().stageId).toBe('done');
  });
  it('can fix a submitted workspace resolution again when it conflicts with a newer base', async () => {
    await workspaceConflict();
    const publish = vi
      .spyOn(h!.domain.sessions, 'prepareMergeSource')
      .mockImplementation(async (_config, _task, commit) => {
        if (commit !== 'approved') throw new Error('workspace_source_missing');
      });
    await fix({ fixConflict: true });
    const tree = [...h!.worktrees.fixes.values()][0]!;
    h!.worktrees.heads.get(tree.path)!.commit = 'resolved';
    merger.isAncestor.mockResolvedValue(true);
    merger.base.local = 'new-base';
    merger.build.mockResolvedValueOnce({ ok: false, conflict: ['a.ts'] });
    await fix({ resolution: 'Resolve the first conflict' });
    await vi.waitFor(() => expect(row()?.state).toBe('failed'));
    expect(row()).toMatchObject({ commit: 'resolved', failure: { base: 'new-base' } });
    await fix({ fixConflict: true });
    expect(row()).toMatchObject({ state: 'fixing', fix: { base: 'new-base' } });
    expect(publish.mock.calls.map((call) => call[2])).not.toContain('resolved');
    h!.worktrees.heads.get(tree.path)!.commit = 'resolved-again';
    await fix({ resolution: 'Resolve the newer base conflict' });
    await merged();
    expect(task().merged).toMatchObject({
      commit: 'resolved-again',
      resolution: { commit: 'resolved-again', note: 'Resolve the newer base conflict' },
    });
    expect(publish.mock.calls.map((call) => call[2])).not.toContain('resolved-again');
  });
  it('preserves a source publication failure before creating a fix', async () => {
    await workspaceConflict();
    const error = new EngineLinkLostError('link dropped');
    vi.spyOn(h!.domain.sessions, 'prepareMergeSource').mockRejectedValue(error);
    await expect(fix({ fixConflict: true })).rejects.toBe(error);
    expect(h!.worktrees.fixes.size).toBe(0);
    expect(row()?.state).toBe('failed');
  });
  it('retains the resolved commit and note when retrying a blocked fix merge', async () => {
    await conflictFailure();
    await fix({ fixConflict: true });
    const tree = [...h!.worktrees.fixes.values()][0]!;
    h!.worktrees.heads.get(tree.path)!.commit = 'resolved';
    merger.isAncestor.mockResolvedValue(true);
    merger.advance.mockResolvedValueOnce({
      ok: false,
      reason: 'checkout_in_the_way',
      message: 'dirty',
      paths: ['a.ts'],
    });
    await fix({ resolution: 'Resolve imports in a.ts' });
    await blocked('local_checkout');
    await start();
    await merged();
    expect(task().merged).toMatchObject({
      commit: 'resolved',
      resolution: { commit: 'resolved', note: 'Resolve imports in a.ts' },
    });
  });
  it('restarts a lead developer after their turn into the writable fix checkout and sweeps it after cancellation', async () => {
    await setup({
      remote: false,
      adjust(config) {
        config.team.merger = { kind: 'member', handle: 'cr' };
        const member = config.team.members.find((m) => m.handle === 'cr')!;
        if (member.kind === 'ai') {
          member.role = 'lead_developer';
          member.permissionMode = 'auto';
        }
      },
    });
    const session = (await h!.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' }))
      .session;
    h!.runner.setState(session.id, 'working');
    merger.build.mockResolvedValueOnce({ ok: false, conflict: ['a.ts'] });
    await start('AR-1', aiActor('cr'));
    await vi.waitFor(() => expect(row()?.state).toBe('failed'));
    const before = h!.runner.started.length;
    await fix({ fixConflict: true }, aiActor('cr'));
    expect(h!.runner.started).toHaveLength(before);
    h!.runner.setState(session.id, 'idle');
    await vi.waitFor(() => expect(h!.runner.started.length).toBe(before + 1));
    const spec = h!.runner.lastStarted();
    expect(spec.policy).toMatchObject({
      placement: { kind: 'task_worktree', mergeFix: { branch: 'merge-fix/AR-1' } },
    });
    expect(spec.policy!.filesystem.writableRoots).toContain(spec.cwd);
    expect(spec.cwd).toContain('_merge-fix');
    const labels = task().labels;
    h!.repos.tasks.update(task().id, { labels: [] });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    await h!.domain.worktreeSweep.run();
    expect(h!.worktrees.fixes.size).toBe(1);
    await h!.domain.sessions.stop('AR', session.id);
    await h!.domain.worktreeSweep.run();
    expect(h!.worktrees.fixes.size).toBe(0);
    await h!.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' });
    const reader = h!.runner.lastStarted();
    expect(reader.cwd).not.toContain('_merge-fix');
    expect(reader.policy!.placement.kind).toBe('read_only');
    h!.runner.setState(session.id, 'idle');
    expect(h!.domain.sessions.isRunning(session.id)).toBe(true);
    h!.repos.tasks.update(task().id, { labels });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    merger.build.mockResolvedValueOnce({ ok: false, conflict: ['a.ts'] });
    await start('AR-1', aiActor('cr'));
    await vi.waitFor(() => expect(row()?.state).toBe('failed'));
    h!.runner.setState(session.id, 'working');
    const restarted = h!.runner.started.length;
    await fix({ fixConflict: true }, aiActor('cr'));
    h!.runner.setState(session.id, 'idle');
    await vi.waitFor(() => expect(h!.runner.started.length).toBe(restarted + 1));
    expect(h!.runner.lastStarted().policy).toMatchObject({
      placement: { kind: 'task_worktree', mergeFix: { branch: 'merge-fix/AR-1' } },
    });
  });
  describe('while the merge runs on the server (PM-552)', () => {
    type Built = Awaited<ReturnType<BranchMerger['build']>>;
    const sessionOf = async (member: string) => await waitForSession(h!.domain, { member, taskKey: 'AR-1' });
    const lastStop = (id: string) => h!.repos.sessions.get(id)?.lastStop;
    /** The turn ends. A message that waited is typed in first, and its round ends too. */
    async function endTurn(id: string) {
      for (let round = 0; round < 3 && h!.runner.isRunning(id); round++) {
        h!.runner.setState(id, 'working');
        h!.runner.setState(id, 'idle');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    /** The merger's session has a conversation and its turn is running; the merge waits at the gate. */
    async function runningMerge() {
      await setup();
      const session = await sessionOf('dev-1');
      h!.runner.setState(session.id, 'working');
      h!.runner.emit({ type: 'transcript_path', sessionId: session.id, path: `/tmp/${session.id}.jsonl` });
      const gate = deferred<Built>();
      merger.build.mockReturnValueOnce(gate.promise);
      await start();
      await vi.waitFor(() => expect(['queued', 'running']).toContain(row()?.state));
      return { session, gate };
    }

    it('closes the idle session of the merger, keeps its conversation and wakes it for a failure', async () => {
      const { session, gate } = await runningMerge();
      // It works until the turn ends.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h!.runner.isRunning(session.id)).toBe(true);

      await endTurn(session.id);
      expect(h!.runner.isRunning(session.id)).toBe(false);
      expect(lastStop(session.id)).toEqual({ kind: 'merge_running', taskKey: 'AR-1' });
      expect(h!.repos.sessions.get(session.id)?.claudeSessionId).toBe(session.claudeSessionId);

      const starts = h!.runner.started.filter((s) => s.sessionId === session.id).length;
      gate.resolve({ ok: false, conflict: ['a.ts'] });
      await vi.waitFor(() => expect(row()?.state).toBe('failed'));
      await vi.waitFor(() =>
        expect(h!.runner.started.filter((s) => s.sessionId === session.id)).toHaveLength(starts + 1),
      );
      expect(h!.runner.lastStarted()).toMatchObject({ sessionId: session.id, resume: true });
    });

    it('does not start a session for a merge that went in', async () => {
      const { session, gate } = await runningMerge();
      await endTurn(session.id);
      expect(h!.runner.isRunning(session.id)).toBe(false);
      const starts = h!.runner.started.length;
      gate.resolve({ ok: true, mergeCommit: 'merged-ok', changed: ['a.ts'] });
      await merged();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h!.runner.started).toHaveLength(starts);
    });

    it('closes an idle session at the sweep, without a quarter of an hour of silence', async () => {
      await setup();
      const session = await sessionOf('dev-1');
      h!.runner.setState(session.id, 'working');
      h!.runner.setState(session.id, 'idle');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(h!.runner.isRunning(session.id)).toBe(true);
      const gate = deferred<Built>();
      merger.build.mockReturnValueOnce(gate.promise);
      await start();
      await vi.waitFor(() => expect(['queued', 'running']).toContain(row()?.state));
      // The message that waited is typed in at the first round; the next one closes the session.
      await vi.waitFor(async () => {
        await h!.domain.sessionCloser.sweep();
        expect(h!.runner.isRunning(session.id)).toBe(false);
      });
      expect(lastStop(session.id)).toEqual({ kind: 'merge_running', taskKey: 'AR-1' });
      gate.resolve({ ok: true, mergeCommit: 'merged-ok', changed: [] });
      await merged();
    });

    it("leaves another member's session on the card open", async () => {
      const { session, gate } = await runningMerge();
      const other = (await h!.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' }))
        .session;
      h!.runner.setState(other.id, 'working');
      h!.runner.setState(other.id, 'idle');
      await endTurn(session.id);
      expect(h!.runner.isRunning(session.id)).toBe(false);
      await h!.domain.sessionCloser.sweep();
      expect(h!.runner.isRunning(other.id)).toBe(true);
      expect(lastStop(other.id)).toBeUndefined();
      gate.resolve({ ok: true, mergeCommit: 'merged-ok', changed: [] });
      await merged();
    });

    it('keeps the session of a merger whose merge failed open', async () => {
      await setup();
      const session = await sessionOf('dev-1');
      merger.build.mockResolvedValueOnce({ ok: false, conflict: ['a.ts'] });
      h!.runner.setState(session.id, 'working');
      await start();
      await vi.waitFor(() => expect(row()?.state).toBe('failed'));
      h!.runner.setState(session.id, 'idle');
      await h!.domain.sessionCloser.sweep();
      expect(h!.runner.isRunning(session.id)).toBe(true);
      expect(lastStop(session.id)).toBeUndefined();
    });

    it('stops the merge-fix session with the same reason once the resolution is in', async () => {
      await setup({
        remote: false,
        adjust(config) {
          config.team.merger = { kind: 'member', handle: 'cr' };
          const member = config.team.members.find((m) => m.handle === 'cr')!;
          if (member.kind === 'ai') {
            member.role = 'lead_developer';
            member.permissionMode = 'auto';
          }
        },
      });
      const session = (await h!.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' }))
        .session;
      h!.runner.setState(session.id, 'working');
      merger.build.mockResolvedValueOnce({ ok: false, conflict: ['a.ts'] });
      await start('AR-1', aiActor('cr'));
      await vi.waitFor(() => expect(row()?.state).toBe('failed'));
      const before = h!.runner.started.length;
      await fix({ fixConflict: true }, aiActor('cr'));
      h!.runner.setState(session.id, 'idle');
      await vi.waitFor(() => expect(h!.runner.started.length).toBe(before + 1));
      // The restarted session takes the messages waiting for it at its first idle moment; one left waiting
      // wakes the member again once the session is stopped, as the member queue is level driven (PM-925).
      h!.runner.setState(session.id, 'idle');
      await vi.waitFor(() => expect(h!.domain.messages.waiting('AR', 'cr', session.workItem)).toEqual([]));

      const tree = [...h!.worktrees.fixes.values()][0]!;
      h!.worktrees.heads.get(tree.path)!.commit = 'resolved';
      merger.isAncestor.mockResolvedValue(true);
      const gate = deferred<Built>();
      merger.build.mockReturnValueOnce(gate.promise);
      h!.runner.setState(session.id, 'working');
      await fix({ resolution: 'Resolve adjacent imports in a.ts' }, aiActor('cr'));
      h!.runner.setState(session.id, 'idle');
      await vi.waitFor(() => expect(h!.runner.isRunning(session.id)).toBe(false));
      expect(lastStop(session.id)).toEqual({ kind: 'merge_running', taskKey: 'AR-1' });
      gate.resolve({ ok: true, mergeCommit: 'merged-ok', changed: [] });
      await merged();
    });
  });
  afterEach(async () => {
    await h?.cleanup();
    remoteCheck?.close();
    remoteCheck = undefined;
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

  it('queues a fresh merger wake when a later approval arrives, once per label event', async () => {
    await setup();
    await h!.domain.merges.reconcile('AR', 'AR-1');
    const request = row()!;
    const requestedEvent = events('task_merge_requested').at(-1)!;
    const original = h!.repos.messages
      .list('AR', { taskKey: 'AR-1' })
      .find((message) => message.origin?.kind === 'note' && message.origin.eventId === requestedEvent.id)!;
    h!.domain.messages.markRecipientDelivered(original.id, 'dev-1');

    await h!.domain.tasks.update('AR', 'AR-1', { addLabels: ['security-ok'] }, OWNER_ACTOR);
    const approval = events('task_labels_changed').at(-1)!;
    await vi.waitFor(() => {
      const message = h!.repos.messages
        .list('AR', { taskKey: 'AR-1' })
        .find((message) => message.origin?.kind === 'note' && message.origin.eventId === approval.id);
      expect(message).toMatchObject({ from: 'system', to: ['dev-1'], kind: 'action' });
      expect(
        h!.repos.memberQueue.findBySource('AR', 'dev-1', { type: 'message', id: message!.id }),
      ).toMatchObject({
        wake: true,
        place: { type: 'task', taskKey: 'AR-1' },
      });
    });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    expect(
      h!.repos.messages
        .list('AR', { taskKey: 'AR-1' })
        .filter((message) => message.origin?.kind === 'note' && message.origin.eventId === approval.id),
    ).toHaveLength(1);
    expect(row()).toMatchObject({ id: request.id, state: 'requested' });
    expect(events('task_merge_requested')).toHaveLength(1);
    expect(merger.build).not.toHaveBeenCalled();
  });

  describe('engine reconnection', () => {
    const withCheck = (config: ProjectConfig) => {
      config.project.repos[0]!.reviewTest = reviewTest;
    };

    it.each(['run', 'attach'] as const)(
      'blocks an engine handler error during %s after one check',
      async (phase) => {
        const executor = fakeExecutor();
        await setup({ executor, adjust: withCheck });
        const cloud = createFakeCloud();
        remoteCheck = createCloudRemote({
          links: cloud.links,
          registry: cloud.registry,
          recordedEngine: () => null,
          spoolDir: `${h!.dir}/refused-check-spool`,
          logger: h!.log.logger,
        });
        const refusal = () => {
          throw Object.assign(new Error('fixture failure'), { code: 'internal' });
        };
        const engine = cloud.connect('eng_a' as never);
        engine.answer('full_test.run', phase === 'run' ? refusal : () => new Promise(() => {}));
        const remoteExecutor = remoteCheck.directory.host(engine.id)!.fullTestExecutor!;
        vi.mocked(executor.run).mockImplementation((...args) => remoteExecutor.run(...args));
        engines.awaitConnected = vi.fn(async () => 'connected' as const);
        await start();
        if (phase === 'attach') {
          await vi.waitFor(() =>
            expect(engine.requests.some((request) => request.method === 'full_test.run')).toBe(true),
          );
          engine.disconnect();
          await vi.waitFor(() => expect(row()?.step).toBe('engine_waiting'));
          cloud.connect(engine.id, {
            prepare(next) {
              next.answer('full_test.attach', refusal);
            },
          });
        }
        await blocked('check_error');
        expect(row()?.block?.message).toContain('spawn_failed');
        expect(executor.run).toHaveBeenCalledTimes(1);
        expect(merger.build).toHaveBeenCalledTimes(1);
        expect(merger.push).not.toHaveBeenCalled();
        expect(engines.awaitConnected).not.toHaveBeenCalled();
      },
    );

    it.each(['ended', 'unknown', 'old'] as const)(
      'completes a disconnected check without a manual retry (attach: %s)',
      async (attach) => {
        const executor = fakeExecutor();
        await setup({ executor, adjust: withCheck });
        const cloud = createFakeCloud();
        remoteCheck = createCloudRemote({
          links: cloud.links,
          registry: cloud.registry,
          recordedEngine: () => null,
          spoolDir: `${h!.dir}/reconnect-spool`,
          logger: h!.log.logger,
        });
        const first = cloud.connect('eng_a' as never);
        first.answer('full_test.run', () => new Promise(() => {}));
        const remoteExecutor = remoteCheck.directory.host(first.id)!.fullTestExecutor!;
        vi.mocked(executor.run).mockImplementation((...args) => remoteExecutor.run(...args));
        await start();
        await vi.waitFor(() => expect(first.requests.some((r) => r.method === 'full_test.run')).toBe(true));
        const firstRun = (
          first.requests.find((r) => r.method === 'full_test.run')!.params as { spec: { runId: string } }
        ).spec.runId;
        first.disconnect();
        await vi.waitFor(() => expect(row()?.step).toBe('engine_waiting'));
        expect(h!.domain.merges.busy('AR', 'web')).toBe(true);
        const next = cloud.connect(first.id, {
          prepare(engine) {
            if (attach !== 'old')
              engine.answer('full_test.attach', () =>
                attach === 'ended' ? { state: 'ended', result: passed } : { state: 'unknown' },
              );
            engine.answer('full_test.cancel', async () => null);
            engine.answer('full_test.run', () => passed);
          },
        });
        await merged();
        if (attach === 'ended') {
          expect(task().merged?.check?.runId).toBe(firstRun);
          expect(merger.checkoutForCheck).toHaveBeenCalledTimes(1);
          expect(next.requests.map((r) => r.method)).toEqual(['full_test.attach']);
        } else {
          expect(task().merged?.check?.runId).not.toBe(firstRun);
          expect(merger.checkoutForCheck).toHaveBeenCalledTimes(2);
          expect(next.requests.some((r) => r.method === 'full_test.cancel')).toBe(attach === 'old');
          expect(next.requests.filter((r) => r.method === 'full_test.run')).toHaveLength(1);
        }
        expect(merger.push).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['build', 'checkoutForCheck'] as const)(
      'restarts after losing the link during %s',
      async (method) => {
        await setup({ executor: fakeExecutor(), adjust: withCheck });
        merger[method].mockRejectedValueOnce({ linkCode: 'link_down' });
        const back = deferred<'connected'>();
        engines.awaitConnected = vi.fn(() => back.promise);
        await start();
        await vi.waitFor(() => expect(row()?.step).toBe('engine_waiting'));
        expect(engines.awaitConnected).toHaveBeenCalledWith(
          expect.anything(),
          900_000,
          expect.any(AbortSignal),
        );
        back.resolve('connected');
        await merged();
        expect(merger.build).toHaveBeenCalledTimes(2);
        expect(merger.push).toHaveBeenCalledTimes(1);
      },
    );

    it('waits for a registered engine that disconnected before execution', async () => {
      await setup();
      let busy = true;
      h!.domain.merges.registerSlotPeer({ busy: () => busy, pump: () => {} });
      await start();
      const get = vi.spyOn(engines, 'get').mockReturnValue(null);
      const back = deferred<'connected'>();
      engines.awaitConnected = vi.fn(() => back.promise);
      busy = false;
      h!.domain.merges.pump();
      await vi.waitFor(() => expect(row()?.step).toBe('engine_waiting'));
      expect(merger.build).not.toHaveBeenCalled();
      get.mockRestore();
      back.resolve('connected');
      await merged();
    });

    it('waits when the check availability probe reports an offline engine', async () => {
      const executor = fakeExecutor();
      await setup({ executor, adjust: withCheck });
      vi.mocked(executor.available).mockResolvedValueOnce({ ok: false, reason: 'engine_offline' });
      const back = deferred<'connected'>();
      engines.awaitConnected = vi.fn(() => back.promise);
      await start();
      await vi.waitFor(() => expect(row()?.step).toBe('engine_waiting'));
      back.resolve('connected');
      await merged();
      expect(executor.run).toHaveBeenCalledTimes(1);
    });

    it('blocks after fifteen minutes without an engine', async () => {
      await setup();
      merger.build.mockRejectedValueOnce(new EngineLinkLostError('disconnected'));
      engines.awaitConnected = (_id, waitMs) =>
        new Promise((resolve) => setTimeout(() => resolve('timeout'), waitMs));
      vi.useFakeTimers();
      try {
        await start();
        await vi.waitFor(() => expect(row()?.step).toBe('engine_waiting'));
        await vi.advanceTimersByTimeAsync(900_000);
        await blocked('engine_offline');
        expect(row()?.block?.message).toBe('the card engine was unreachable for 15 minutes');
        expect(merger.push).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('notes the test files a passed merge check reran once, and merges', async () => {
      await setup({
        executor: fakeExecutor({
          ...passed,
          outputTail:
            'merge-test flaky: apps/server/test/a.test.ts\nmerge-test flaky: apps/web/src/b.test.ts\n',
        }),
        adjust: withCheck,
      });
      await start();
      await merged();
      const notes = h!.domain.timeline
        .list('AR', { taskKey: 'AR-1' })
        .filter((event) => event.type === 'task_note' && String(event.data.text).includes('flaky'));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ actor: { kind: 'system' } });
      expect(notes[0]!.data.text).toMatch(
        /^Merge check \S+ passed after rerunning these test files once \(flaky\): apps\/server\/test\/a\.test\.ts, apps\/web\/src\/b\.test\.ts$/,
      );
    });

    it('adds no note when a passed merge check reran nothing', async () => {
      await setup({ executor: fakeExecutor(), adjust: withCheck });
      await start();
      await merged();
      expect(
        h!.domain.timeline
          .list('AR', { taskKey: 'AR-1' })
          .filter((event) => event.type === 'task_note' && String(event.data.text).includes('flaky')),
      ).toHaveLength(0);
    });

    it('does not wait another fifteen minutes when the executor already waited', async () => {
      await setup({
        executor: fakeExecutor({ ...passed, outcome: 'error', reason: 'engine_offline' }),
        adjust: withCheck,
      });
      engines.awaitConnected = vi.fn(async () => 'timeout' as const);
      await start();
      await blocked('engine_offline');
      expect(engines.awaitConnected).toHaveBeenCalledWith(expect.anything(), 0, expect.any(AbortSignal));
    });

    it('requeues a disconnected check when the cloud stops waiting before domain shutdown', async () => {
      const executor = fakeExecutor();
      await setup({ executor, adjust: withCheck });
      const cloud = createFakeCloud();
      remoteCheck = createCloudRemote({
        links: cloud.links,
        registry: cloud.registry,
        recordedEngine: () => null,
        spoolDir: `${h!.dir}/shutdown-spool`,
        logger: h!.log.logger,
      });
      const engine = cloud.connect('eng_a' as never);
      engine.answer('full_test.run', () => new Promise(() => {}));
      const remoteExecutor = remoteCheck.directory.host(engine.id)!.fullTestExecutor!;
      vi.mocked(executor.run).mockImplementation((...args) => remoteExecutor.run(...args));
      await start();
      await vi.waitFor(() => expect(engine.requests.some((r) => r.method === 'full_test.run')).toBe(true));
      engine.disconnect();
      await vi.waitFor(() => expect(row()?.step).toBe('engine_waiting'));
      const drain = deferred<void>();
      const stop = h!.domain.fullTests.stop.bind(h!.domain.fullTests);
      const fullTestsStop = vi.spyOn(h!.domain.fullTests, 'stop').mockImplementation(async () => {
        await drain.promise;
        await stop();
      });
      remoteCheck.stopWaiting();
      const stopping = h!.domain.stop();
      await flush();
      expect(row()).toMatchObject({ state: 'running', step: 'engine_waiting' });
      drain.resolve();
      await stopping;
      fullTestsStop.mockRestore();
      expect(row()).toMatchObject({ state: 'queued', step: 'queued' });
    });

    it.each([false, true])(
      'requeues a wait on shutdown, retaining publication recovery (push started: %s)',
      async (pushing) => {
        await setup();
        merger[pushing ? 'push' : 'build'].mockRejectedValueOnce(new EngineLinkLostError('disconnected'));
        engines.awaitConnected = (_id, _waitMs, signal) =>
          new Promise((resolve) =>
            signal!.addEventListener('abort', () => resolve('aborted'), { once: true }),
          );
        await start();
        await vi.waitFor(() => expect(row()?.step).toBe('engine_waiting'));
        const id = row()!.id;
        await h!.domain.merges.stop();
        expect(row()).toMatchObject({
          id,
          state: pushing ? 'running' : 'queued',
          step: pushing ? 'engine_waiting' : 'queued',
        });
        engines.awaitConnected = vi.fn(async () => 'connected' as const);
        await h!.domain.merges.init();
        await merged();
      },
    );

    it('recovers a push that landed before the connection was lost', async () => {
      await setup();
      merger.push.mockImplementationOnce(async (_ref, input) => {
        merger.base.remote!.commit = input.mergeCommit;
        throw new EngineLinkLostError('push reply lost');
      });
      merger.isAncestor.mockImplementation(async (_ref, input) => input.ancestor === input.commit);
      engines.awaitConnected = vi.fn(async () => 'connected' as const);
      await start();
      await merged();
      expect(merger.push).toHaveBeenCalledTimes(1);
      expect(merger.build).toHaveBeenCalledTimes(1);
      expect(merger.advance).toHaveBeenCalledTimes(1);
    });

    it('blocks the sixth engine loss', async () => {
      await setup();
      merger.build.mockRejectedValue(new EngineLinkLostError('disconnected'));
      engines.awaitConnected = vi.fn(async () => 'connected' as const);
      await start();
      await blocked('engine_offline');
      expect(row()?.block?.message).toBe('the card engine kept losing its link');
      expect(merger.build).toHaveBeenCalledTimes(6);
      expect(engines.awaitConnected).toHaveBeenCalledTimes(5);
    });

    it('does not treat another link code as a lost link', async () => {
      await setup();
      merger.build.mockRejectedValueOnce({ linkCode: 'timeout' });
      engines.awaitConnected = vi.fn(async () => 'connected' as const);
      await start();
      await blocked('merge_error');
      expect(engines.awaitConnected).not.toHaveBeenCalled();
    });

    it('holds its repository slot while a different repository can merge', async () => {
      await setup({
        adjust(config) {
          config.project.repos.push({ name: 'api', path: 'api', defaultBranch: 'main', requireMerge: true });
          config.team.limits.maxConcurrentAi = 6;
          for (const member of config.team.members)
            if (member.kind === 'ai' && member.handle.startsWith('dev-')) member.capacity = 4;
        },
      });
      await card('AR-2', 'web', 'dev-2');
      await card('AR-3', 'api', 'dev-2');
      merger.build.mockRejectedValueOnce(new EngineLinkLostError('disconnected'));
      const back = deferred<'connected'>();
      engines.awaitConnected = () => back.promise;
      await start();
      await vi.waitFor(() => expect(row()?.step).toBe('engine_waiting'));
      await start('AR-2');
      await start('AR-3');
      await merged('AR-3');
      expect(row('AR-2')?.state).toBe('queued');
      expect(h!.domain.merges.holder('AR', 'web')).toBe('AR-1');
      back.resolve('connected');
      await merged();
      await merged('AR-2');
    });
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

  it.each([
    [{ kind: 'developer' }, 'dev-1'],
    [{ kind: 'member', handle: 'owner' }, 'owner'],
    [{ kind: 'code_reviewer' }, 'cr'],
  ] as const)('resolves the merger of %j', async (merger, expected) => {
    await setup({
      adjust: (c) => {
        c.team.merger = merger;
      },
    });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    expect(row()?.merger).toBe(expected);
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
    expect(events('task_merged')[0]?.actor).toEqual({ kind: 'ai', handle: 'dev-1' });
    expect(merger.releaseCheck).toHaveBeenCalled();
    await move();
    expect(task().status).toBe('done');
  });

  it('records a tool success on the system when there is nothing left to merge', async () => {
    await setup();
    merger.base.contains = { local: true, remote: true };
    await start();
    await merged();
    expect(merger.build).not.toHaveBeenCalled();
    expect(task().stageId).toBe('code_review');
    expect(events('task_merged')[0]?.actor).toEqual({ kind: 'system', handle: null });
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
    const text = h!.repos.messages
      .list('AR', { taskKey: 'AR-1' })
      .map((m) => m.body)
      .find((body) => body.includes('failed (conflict)'));
    expect(text).toContain('fix_conflict: true');
    expect(task().stageId).toBe('code_review');
    expect(merger.push).not.toHaveBeenCalled();
    expect(merger.advance).not.toHaveBeenCalled();
    await start();
    await merged();
    expect(merger.build).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed check on the card with the start of its output and releases the checkout', async () => {
    const output = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(200)}`).join('\n');
    await setup({
      executor: fakeExecutor({ ...passed, outcome: 'failed', outputTail: output }),
      adjust: (c) => {
        c.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    await start();
    await vi.waitFor(() => expect(row()?.state).toBe('failed'));
    expect(row()?.failure?.outputTail?.length).toBeLessThanOrEqual(8000);
    // The executor's report is kept from its start (PM-554), not cut to its last lines.
    expect(row()?.failure?.outputTail).toBe(output.slice(0, 8000));
    expect(task().stageId).toBe('code_review');
    expect(merger.push).not.toHaveBeenCalled();
    expect(merger.releaseCheck).toHaveBeenCalled();
  });

  describe('dependency preparation (PM-681)', () => {
    const withCheck = (config: ProjectConfig) => {
      config.project.repos[0]!.reviewTest = reviewTest;
    };

    it('asks the engine for an installation and passes the request on to the executor under the heavy-run queue', async () => {
      const executor = fakeExecutor();
      await setup({ executor, adjust: withCheck });
      merger.checkoutForCheck.mockResolvedValueOnce({
        path: '/fake/check',
        gitDir: '/fake/git',
        dependencyInstallRequired: true,
      });
      await start();
      await merged();
      expect(merger.checkoutForCheck.mock.calls[0]![1]).toMatchObject({ allowDependencyInstall: true });
      const spec = vi.mocked(executor.run).mock.calls[0]![0];
      expect(spec).toMatchObject({
        requireHeavyLock: true,
        npmCi: {
          ref: { projectKey: 'AR', repo: expect.any(String) },
          mergeId: expect.stringMatching(/^merge_/),
        },
      });
      expect(spec.npmCi!.mergeId).toBe(merger.checkoutForCheck.mock.calls[0]![1].mergeId);
      expect(vi.mocked(executor.run)).toHaveBeenCalledTimes(1);
    });

    it('sends no installation request when the engine does not ask for one', async () => {
      const executor = fakeExecutor();
      await setup({ executor, adjust: withCheck });
      await start();
      await merged();
      const spec = vi.mocked(executor.run).mock.calls[0]![0];
      expect(spec).not.toHaveProperty('npmCi');
      expect(spec.requireHeavyLock).toBe(true);
    });

    it('blocks as check_error, not as a failed check, when the check cannot run', async () => {
      const executor = fakeExecutor({
        ...passed,
        outcome: 'error',
        reason: 'dependency_install_failed',
        exitCode: 1,
        outputTail: 'npm ERR! network',
      });
      await setup({ executor, adjust: withCheck });
      merger.checkoutForCheck.mockResolvedValueOnce({
        path: '/fake/check',
        gitDir: '/fake/git',
        dependencyInstallRequired: true,
      });
      await start();
      await blocked('check_error');
      expect(row()?.block?.message).toContain('dependency_install_failed');
      expect(row()?.failure).toBeUndefined();
      expect(task().stageId).not.toBe('development');
      expect(executor.run).toHaveBeenCalledTimes(1);
      expect(merger.push).not.toHaveBeenCalled();
      expect(merger.advance).not.toHaveBeenCalled();
      expect(merger.releaseCheck).toHaveBeenCalled();
    });

    it('releases the checkout after the executor has ended when the merge is cancelled', async () => {
      const executor = fakeExecutor();
      const finish = deferred<FullTestResult>();
      let signal: AbortSignal | undefined;
      vi.mocked(executor.run).mockImplementation((_spec, runSignal) => {
        signal = runSignal;
        return finish.promise;
      });
      await setup({ executor, adjust: withCheck });
      merger.checkoutForCheck.mockResolvedValueOnce({
        path: '/fake/check',
        gitDir: '/fake/git',
        dependencyInstallRequired: true,
      });
      await start();
      await vi.waitFor(() => expect(executor.run).toHaveBeenCalled());
      const id = row()!.id;
      await h!.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      // The child of the installation has not ended yet: its checkout stays.
      expect(merger.releaseCheck).not.toHaveBeenCalled();
      finish.resolve({ ...passed, outcome: 'error', reason: 'killed', exitCode: null });
      await vi.waitFor(() => expect(merger.releaseCheck).toHaveBeenCalled());
      await vi.waitFor(() => expect(h!.repos.taskMerges.get(id)?.state).toBe('cancelled'));
      expect(merger.push).not.toHaveBeenCalled();
    });
  });

  it('blocks a local default branch that is ahead of its upstream', async () => {
    await setup();
    merger.base.relation = 'local_ahead';
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

  it('waits for the machine queue as its own step, then checks when the run starts', async () => {
    const steps: unknown[] = [];
    const executor = fakeExecutor();
    vi.mocked(executor.run).mockImplementation(async (_spec, _signal, onStarted) => {
      steps.push(row()?.step);
      onStarted?.();
      steps.push(row()?.step);
      return passed;
    });
    await setup({
      executor,
      adjust: (c) => {
        c.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    await start();
    await merged();
    expect(steps).toEqual(['check_waiting', 'checking']);
  });

  describe('GitHub Actions runner (PM-900)', () => {
    const viaGithub = (github: string | undefined) => (config: ProjectConfig) => {
      const repo = config.project.repos[0]!;
      repo.reviewTest = { ...reviewTest, runner: 'github_actions' };
      repo.github = github;
    };

    it('sends the descriptor with no checkout, heavy-run lock or installation, and records the runner and the run page', async () => {
      const url = 'https://github.com/acme/web/actions/runs/7';
      const executor = fakeExecutor({ ...passed, externalUrl: url });
      await setup({ executor, adjust: viaGithub('acme/web') });
      vi.mocked(executor.available).mockClear();
      await start();
      await merged();
      const spec = vi.mocked(executor.run).mock.calls[0]![0];
      expect(spec).toEqual({
        runId: expect.stringMatching(/^mergecheck_/),
        cwd: 'github-actions:acme/web',
        command: reviewTest.command,
        maxWorkers: reviewTest.maxWorkers,
        timeoutMs: reviewTest.timeoutMinutes * 60_000,
        sandbox: { denyRead: [], allowRead: [] },
        githubActions: {
          ref: { projectKey: 'AR', repo: expect.any(String) },
          mergeId: expect.stringMatching(/^merge_/),
          repo: 'acme/web',
          base: expect.any(String),
          commit: expect.stringMatching(/^merged-/),
          workflow: 'merge-check.yml',
        },
      });
      expect(merger.checkoutForCheck).not.toHaveBeenCalled();
      expect(executor.available).not.toHaveBeenCalled();
      expect(merger.releaseCheck.mock.calls[0]![1]).toEqual({ mergeId: spec.githubActions!.mergeId });
      expect(h!.repos.mergeCheckRuns.list({ projectKey: 'AR', limit: 10 }).runs).toEqual([
        expect.objectContaining({ runner: 'github_actions', url }),
      ]);
    });

    it('keeps the runner and the run page on the failed merge for the card (PM-918)', async () => {
      const url = 'https://github.com/acme/web/actions/runs/8';
      await setup({
        executor: fakeExecutor({ ...passed, outcome: 'failed', externalUrl: url }),
        adjust: viaGithub('acme/web'),
      });
      await start();
      await vi.waitFor(() => expect(row()?.state).toBe('failed'));
      expect(row()?.check).toMatchObject({ status: 'failed', runner: 'github_actions', url });
    });

    it('blocks as check_unavailable when the configuration no longer names the github owner/name', async () => {
      const executor = fakeExecutor();
      await setup({ executor, adjust: viaGithub('acme/web') });
      // The invariant refuses such a configuration, so the loss is simulated at the read.
      const read = h!.domain.projects.config.bind(h!.domain.projects);
      vi.spyOn(h!.domain.projects, 'config').mockImplementation(async (key) => {
        const config = structuredClone(await read(key));
        delete config.project.repos[0]!.github;
        return config;
      });
      await start();
      await blocked('check_unavailable');
      expect(row()?.block?.message).toContain('github');
      expect(executor.run).not.toHaveBeenCalled();
    });
  });

  describe('recorded merge check (PM-876)', () => {
    const runs = () => h!.repos.mergeCheckRuns.list({ projectKey: 'AR', limit: 10 }).runs;
    const report = {
      scope: 'modules' as const,
      workers: 4,
      commandMs: 50,
      steps: [
        {
          index: 0,
          kind: 'test' as const,
          workspace: 'apps/server',
          result: 'passed' as const,
          durationMs: 40,
        },
      ],
    };

    it.each([2, 4])(
      'records the check with %i workers, its queue turn and the engine report',
      async (workers) => {
        const executor = fakeExecutor();
        vi.mocked(executor.run).mockImplementation(async (_spec, _signal, onStarted) => {
          onStarted?.();
          return { ...passed, durationMs: 50, report };
        });
        await setup({
          executor,
          adjust: (c) => {
            c.project.repos[0]!.reviewTest = { ...reviewTest, maxWorkers: workers };
          },
        });
        await start();
        await merged();
        expect(vi.mocked(executor.run).mock.calls[0]![0].maxWorkers).toBe(workers);
        expect(runs()).toEqual([
          expect.objectContaining({
            kind: 'merge',
            taskKeys: ['AR-1'],
            trainId: null,
            maxWorkers: workers,
            status: 'passed',
            durationMs: 50,
            startedAt: expect.any(String),
            report,
          }),
        ]);
      },
    );

    it.each([
      ['failed', 'failed', 'failed'],
      ['error', 'error', 'check_error'],
    ] as const)('records a %s check as %s', async (outcome, status, blockReason) => {
      await setup({
        executor: fakeExecutor({ ...passed, outcome, durationMs: 9, report }),
        adjust: (c) => {
          c.project.repos[0]!.reviewTest = reviewTest;
        },
      });
      await start();
      if (outcome === 'error') await blocked(blockReason);
      else await vi.waitFor(() => expect(row()?.state).toBe(blockReason));
      expect(runs()).toEqual([expect.objectContaining({ status, durationMs: 9, report })]);
    });

    it('records a check that never started its queue turn without a start time, and marks the unfinished ones interrupted at the hub start', async () => {
      const executor = fakeExecutor();
      const finish = deferred<FullTestResult>();
      vi.mocked(executor.run).mockImplementation(() => finish.promise);
      await setup({
        executor,
        adjust: (c) => {
          c.project.repos[0]!.reviewTest = reviewTest;
        },
      });
      await start();
      await vi.waitFor(() => expect(runs()).toHaveLength(1));
      expect(runs()[0]).toMatchObject({ status: 'running', startedAt: null, finishedAt: null });
      await h!.domain.merges.init();
      expect(runs()[0]).toMatchObject({
        status: 'cancelled',
        reason: 'interrupted',
        finishedAt: expect.any(String),
      });
      finish.resolve(passed);
      await merged();
    });
  });

  describe('conflicts in generated files (PM-1050)', () => {
    const regenerate = { paths: ['gen/**'], command: 'npm run generate' };
    const withRegenerate = {
      adjust: (c: ProjectConfig) => {
        c.project.repos[0]!.reviewTest = { ...reviewTest, regenerate };
      },
    };

    it('regenerates the files on the merge result, checks the regenerated commit and notes it', async () => {
      const executor = fakeExecutor();
      await setup({ executor, ...withRegenerate });
      merger.build
        .mockResolvedValueOnce({ ok: false, conflict: ['gen/a.snap'] })
        .mockResolvedValueOnce({ ok: false, conflict: ['gen/a.snap'], provisional: 'provisional' });
      await start();
      await merged();
      expect(merger.build).toHaveBeenCalledTimes(2);
      expect(merger.build.mock.calls[1]![1]).toMatchObject({ regenerate: regenerate.paths });
      expect(vi.mocked(executor.run).mock.calls.map(([spec]) => spec.command)).toEqual([
        regenerate.command,
        reviewTest.command,
      ]);
      // Only the regeneration may write, in a checkout of its own; the merge check stays read-only.
      const specs = vi.mocked(executor.run).mock.calls.map(([spec]) => spec);
      const regenId = specs[0]!.regenerate!.mergeId;
      expect(specs[0]!.regenerate).toEqual({
        ref: expect.anything(),
        mergeId: regenId,
        patterns: regenerate.paths,
      });
      expect(specs[1]!.regenerate).toBeUndefined();
      const checkoutIds = merger.checkoutForCheck.mock.calls.map(([, input]) => input.mergeId);
      expect(checkoutIds[0]).toBe(regenId);
      expect(checkoutIds[1]).not.toBe(regenId);
      expect(merger.commitRegenerated).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ mergeId: regenId, paths: ['gen/a.snap'], patterns: regenerate.paths }),
      );
      expect(merger.releaseCheck.mock.calls.map(([, input]) => input.mergeId)).toContain(regenId);
      expect(merger.checkoutForCheck.mock.calls.map(([, input]) => input.mergeCommit)).toEqual([
        'provisional',
        'regenerated',
      ]);
      expect(
        events('task_note').some((event) => JSON.stringify(event.data).includes('generated files')),
      ).toBe(true);
    });

    it('fails as a conflict with the reason when the command fails', async () => {
      const executor = fakeExecutor({
        ...passed,
        outcome: 'failed',
        exitCode: 1,
        outputTail: 'generator broke',
      });
      await setup({ executor, ...withRegenerate });
      merger.build
        .mockResolvedValueOnce({ ok: false, conflict: ['gen/a.snap'] })
        .mockResolvedValueOnce({ ok: false, conflict: ['gen/a.snap'], provisional: 'provisional' });
      await start();
      await vi.waitFor(() => expect(row()?.failure?.reason).toBe('conflict'));
      expect(row()?.failure).toMatchObject({
        files: ['gen/a.snap'],
        outputTail: expect.stringContaining('generator broke'),
      });
      expect(merger.commitRegenerated).not.toHaveBeenCalled();
    });

    it('keeps the conflict when the merge result has no provisional commit', async () => {
      const executor = fakeExecutor();
      await setup({ executor, ...withRegenerate });
      merger.build.mockResolvedValue({ ok: false, conflict: ['gen/a.snap', 'src/a.ts'] });
      await start();
      await vi.waitFor(() => expect(row()?.failure?.reason).toBe('conflict'));
      expect(row()?.failure).toMatchObject({ files: ['gen/a.snap', 'src/a.ts'] });
      expect(executor.run).not.toHaveBeenCalled();
    });

    it('keeps the old conflict path when the repository configures no regeneration', async () => {
      await setup({ adjust: (c) => void (c.project.repos[0]!.reviewTest = reviewTest) });
      merger.build.mockResolvedValueOnce({ ok: false, conflict: ['gen/a.snap'] });
      await start();
      await vi.waitFor(() => expect(row()?.failure?.reason).toBe('conflict'));
      expect(merger.build).toHaveBeenCalledTimes(1);
    });
  });

  it('stays at the waiting step when the executor never reports the start', async () => {
    const executor = fakeExecutor();
    const finish = deferred<FullTestResult>();
    vi.mocked(executor.run).mockImplementation(() => finish.promise);
    await setup({
      executor,
      adjust: (c) => {
        c.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    await start();
    await vi.waitFor(() => expect(executor.run).toHaveBeenCalled());
    expect(row()?.step).toBe('check_waiting');
    finish.resolve(passed);
    await merged();
  });

  it('blocks a repository that runs its full test at the merge but names no command', async () => {
    await setup({
      adjust: (c) => {
        c.project.repos[0]!.fullTestAtMerge = true;
      },
    });
    await start();
    await blocked('check_unavailable');
    expect(row()?.block?.message).toContain('fullTestAtMerge');
    expect(merger.push).not.toHaveBeenCalled();
    expect(merger.advance).not.toHaveBeenCalled();
  });

  it('tells the AI merger the failed files and output after a failed full check', async () => {
    await setup({
      executor: fakeExecutor({
        ...passed,
        outcome: 'failed',
        failedFiles: ['src/a.test.ts'],
        outputTail: 'FAIL src/a.test.ts\nAssertionError: expected 1 to be 2',
      }),
      adjust: (c) => {
        c.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    await start();
    await vi.waitFor(() => expect(row()?.state).toBe('failed'));
    const text = h!.repos.messages
      .list('AR', { taskKey: 'AR-1' })
      .map((m) => m.body)
      .find((body) => body.includes('The full check'));
    expect(text).toContain('`npm test`');
    expect(text).toContain('FAIL src/a.test.ts');
    expect(text).toContain('AssertionError: expected 1 to be 2');
    expect(text).toContain('update_task');
    expect(text).toContain('merge_task');
    expect(text).toContain('npm run dead-code');
    expect(text).toContain('project manager');
    expect(text).toContain('docs/LESSONS.md');
    expect(row()?.failure?.files).toEqual(['src/a.test.ts']);
  });

  it('hands the approved commit over to the source repository before it prepares or builds (PM-739)', async () => {
    await setup();
    const order: string[] = [];
    const handOver = vi
      .spyOn(h!.domain.sessions, 'prepareMergeSource')
      .mockImplementation(async () => void order.push('handOver'));
    merger.prepare.mockImplementation(async () => {
      order.push('prepare');
      return structuredClone(merger.base);
    });
    merger.build.mockImplementation(async (_ref, input) => {
      order.push('build');
      return { ok: true, mergeCommit: `merged-${input.commit}`, changed: ['a.ts'] };
    });
    await start();
    await merged();
    expect(handOver).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ key: 'AR-1' }),
      'approved-AR-1',
    );
    expect(order.slice(0, 2)).toEqual(['handOver', 'prepare']);
    expect(order.indexOf('handOver')).toBeLessThan(order.indexOf('build'));
  });

  it('blocks the merge without touching the source when the commit cannot be handed over (PM-739)', async () => {
    await setup();
    vi.spyOn(h!.domain.sessions, 'prepareMergeSource').mockRejectedValue(
      new Error('The commit is not known in this repository'),
    );
    await start();
    await blocked('merge_error');
    expect(merger.prepare).not.toHaveBeenCalled();
    expect(merger.build).not.toHaveBeenCalled();
    expect(merger.advance).not.toHaveBeenCalled();
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
    expect(events('task_merged')[0]?.actor).toEqual({ kind: 'human', handle: 'owner' });
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

  describe('queue order (PM-576)', () => {
    const prioritize = (key: string, actor = aiActor('dev-1')) =>
      h!.domain.merges.prioritize('AR', key, actor, 'the others depend on it');
    const prioritized = (key: string) =>
      h!.domain.timeline
        .list('AR', { taskKey: key })
        .filter((event) => event.type === 'task_merge_prioritized');
    async function threeCards() {
      await setup({
        adjust: (config) => {
          const member = config.team.members.find((m) => m.handle === 'dev-2')!;
          if (member.kind === 'ai') member.capacity = 3;
        },
      });
      await card('AR-2', 'web', 'dev-2');
      await card('AR-3', 'web', 'dev-2');
      const gate = deferred<Awaited<ReturnType<BranchMerger['build']>>>();
      merger.build.mockReturnValueOnce(gate.promise);
      await start();
      await start('AR-2');
      await start('AR-3');
      await vi.waitFor(() => expect(merger.build).toHaveBeenCalledTimes(1));
      return gate;
    }

    it('merges the prioritized card next, without interrupting the running one, and records who and why', async () => {
      const gate = await threeCards();
      const result = await prioritize('AR-3');
      expect(result.moved).toBe(true);
      expect(row('AR-1')?.state).toBe('running');
      expect(prioritized('AR-3')).toMatchObject([
        {
          actor: { handle: 'dev-1' },
          data: { reason: 'the others depend on it', ahead: ['AR-2'], repo: 'web' },
        },
      ]);
      const third = row('AR-3')!;
      expect(third.prioritizedAt).toBeDefined();
      gate.resolve({ ok: true, mergeCommit: 'first', changed: [] });
      await merged('AR-2');
      expect(merger.build.mock.calls.map((call) => call[1].commit)).toEqual([
        'approved-AR-1',
        'approved-AR-3',
        'approved-AR-2',
      ]);
      // The mark goes when the merge starts running.
      expect(h!.repos.taskMerges.get(third.id)?.prioritizedAt).toBeUndefined();
    });

    it('puts the latest decision first and keeps created_at untouched', async () => {
      const gate = await threeCards();
      const created = row('AR-2')!.createdAt;
      expect((await prioritize('AR-3')).moved).toBe(true);
      expect((await prioritize('AR-2')).moved).toBe(true);
      expect(prioritized('AR-2')).toMatchObject([{ data: { ahead: ['AR-3'] } }]);
      expect(row('AR-2')!.createdAt).toBe(created);
      expect(h!.repos.taskMerges.waitingOf('AR', 'web').map((item) => item.taskKey)).toEqual([
        'AR-2',
        'AR-3',
      ]);
      gate.resolve({ ok: true, mergeCommit: 'first', changed: [] });
      await merged('AR-3');
      expect(merger.build.mock.calls.map((call) => call[1].commit)).toEqual([
        'approved-AR-1',
        'approved-AR-2',
        'approved-AR-3',
      ]);
    });

    it('leaves a card that is first already, and refuses the running one and a card with no merge', async () => {
      const gate = await threeCards();
      expect((await prioritize('AR-2')).moved).toBe(false);
      expect(prioritized('AR-2')).toHaveLength(0);
      expect((await prioritize('AR-3')).moved).toBe(true);
      expect((await prioritize('AR-3')).moved).toBe(false);
      expect(prioritized('AR-3')).toHaveLength(1);
      await expect(prioritize('AR-1')).rejects.toMatchObject({
        code: 'merge_not_prioritizable',
        details: { reason: 'running' },
      });
      gate.resolve({ ok: true, mergeCommit: 'first', changed: [] });
      await merged('AR-3');
      await expect(prioritize('AR-3')).rejects.toMatchObject({ code: 'merge_not_prioritizable' });
    });

    it('refuses a merge that is not queued yet', async () => {
      await setup();
      await h!.domain.merges.reconcile('AR', 'AR-1');
      expect(row()?.state).toBe('requested');
      await expect(prioritize('AR-1')).rejects.toMatchObject({
        code: 'merge_not_prioritizable',
        details: { reason: 'not_queued' },
      });
    });

    it('lets the card merger, an owner and the Operator decide, and nobody else', async () => {
      const gate = await threeCards();
      await expect(prioritize('AR-3', aiActor('dev-2'))).rejects.toMatchObject({ code: 'merge_not_merger' });
      await expect(prioritize('AR-3', humanActor('guest'))).rejects.toMatchObject({
        code: 'merge_not_merger',
      });
      expect(prioritized('AR-3')).toHaveLength(0);
      expect((await prioritize('AR-3', aiActor('operator'))).moved).toBe(true);
      expect(prioritized('AR-3')).toMatchObject([{ actor: { handle: 'operator' } }]);
      expect((await prioritize('AR-2', OWNER_ACTOR)).moved).toBe(true);
      expect(prioritized('AR-2')).toMatchObject([{ actor: { handle: 'owner' } }]);
      gate.resolve({ ok: true, mergeCommit: 'first', changed: [] });
      await merged('AR-3');
    });
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
    await vi.waitFor(() => {
      expect(h!.repos.taskMerges.get(id)?.state).toBe('cancelled');
      expect(row()).toMatchObject({ state: 'requested', merger: 'owner' });
      expect(h!.domain.inbox.list('AR', { kind: 'merge_request', state: 'open' })).toHaveLength(1);
    });
  });

  it('does not hold configuration changes or roster reconciliation behind a merge read', async () => {
    await setup();
    const pending = deferred<void>();
    const reconcile = vi.spyOn(h!.domain.merges, 'reconcile').mockReturnValueOnce(pending.promise);
    const members = vi.spyOn(h!.domain.members, 'reconcile');
    const sessions = vi.spyOn(h!.domain.sessions, 'handleConfigChange');
    try {
      const loaded = await h!.domain.projects.load('AR');
      await h!.domain.projects.patch(
        'AR',
        { baseVersion: loaded.version, merger: { kind: 'member', handle: 'owner' } },
        { actor: OWNER_ACTOR, author: OWNER },
      );
      expect(reconcile).toHaveBeenCalledWith('AR', 'AR-1');
      expect(members).toHaveBeenCalled();
      expect(sessions).toHaveBeenCalled();
    } finally {
      pending.resolve();
    }
  });

  it('continues configuration reconciliation after one card fails', async () => {
    await setup();
    await card('AR-2', 'web', 'dev-2');
    vi.spyOn(h!.domain.merges, 'reconcile').mockRejectedValueOnce(new Error('unreadable card'));
    const loaded = await h!.domain.projects.load('AR');
    await h!.domain.projects.patch(
      'AR',
      { baseVersion: loaded.version, merger: { kind: 'member', handle: 'owner' } },
      { actor: OWNER_ACTOR, author: OWNER },
    );
    await vi.waitFor(() => expect(row('AR-2')).toMatchObject({ state: 'requested', merger: 'owner' }));
    expect(
      h!.log.warnings.some(
        (entry) =>
          Array.isArray(entry) &&
          entry.includes('could not reconcile a merge request after configuration changed'),
      ),
    ).toBe(true);
  });

  it('starts without waiting for merge request reconciliation', async () => {
    await setup();
    const pending = deferred<void>();
    const reconcile = vi.spyOn(h!.domain.merges, 'reconcile').mockReturnValueOnce(pending.promise);
    try {
      await h!.domain.merges.init();
      await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith('AR', 'AR-1'));
      expect(row()).toBeNull();
    } finally {
      pending.resolve();
    }
  });

  it('continues startup reconciliation after one card fails', async () => {
    await setup();
    await card('AR-2', 'web', 'dev-2');
    vi.spyOn(h!.domain.merges, 'reconcile').mockRejectedValueOnce(new Error('unreadable card'));
    await h!.domain.merges.init();
    await vi.waitFor(() => expect(row('AR-2')).toMatchObject({ state: 'requested' }));
    expect(
      h!.log.warnings.some(
        (entry) =>
          Array.isArray(entry) && entry.includes('could not reconcile a merge request after startup'),
      ),
    ).toBe(true);
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

  it('leaves a card that has no request and is not ready before it reads the reviewer or the source (PM-770)', async () => {
    await setup();
    const timeline = vi.spyOn(h!.repos.timeline, 'listOfTypes');
    h!.repos.tasks.update(task().id, { labels: [] });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    expect(timeline).not.toHaveBeenCalled();
    expect(merger.prepare).not.toHaveBeenCalled();
    expect(row()).toBeNull();

    // The same card with its approval is looked at in full.
    h!.repos.tasks.update(task().id, { labels: ['code-review-ok'] });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    expect(timeline).toHaveBeenCalled();
    expect(row()).toMatchObject({ state: 'requested' });
  });

  it('reconciles the open request of a closed card at startup, and reads no closed card history (PM-770)', async () => {
    await setup({ persistent: true });
    await h!.domain.merges.reconcile('AR', 'AR-1');
    const requested = row()!;
    for (let n = 0; n < 40; n++) {
      const closed = await h!.domain.tasks.create('AR', { title: `Closed ${n}`, repo: 'web' }, OWNER_ACTOR);
      h!.repos.tasks.update(closed.id, { status: 'done', closedAt: new Date().toISOString() });
    }
    // The request's card closed while the server was down.
    h!.repos.tasks.update(task().id, { status: 'done', closedAt: new Date().toISOString() });

    const list = vi.spyOn(TaskService.prototype, 'list');
    const view = vi.spyOn(TaskStore.prototype, 'view');
    try {
      const next = fakeMerger();
      h = await restartDomainHarness(h!, { merger: next });
      merger = next;
      await vi.waitFor(() => expect(h!.repos.taskMerges.get(requested.id)?.state).toBe('cancelled'));
      expect(list.mock.calls.filter(([projectKey]) => projectKey === 'AR')).toEqual([]);
      // The card of the request and the few the start reads are viewed, not the forty closed cards.
      expect(view.mock.calls.length).toBeLessThan(20);
    } finally {
      list.mockRestore();
      view.mockRestore();
    }
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

  it('does not take a GitHub Actions review result for the merge candidate’s own check (PM-909)', async () => {
    const executor = fakeExecutor();
    await setup({
      executor,
      adjust: (c) => {
        c.project.repos[0]!.reviewTest = reviewTest;
      },
    });
    const at = new Date().toISOString();
    h!.repos.fullTestRuns.queue({
      id: 'review-run',
      projectKey: 'AR',
      taskKey: 'AR-1',
      repo: 'web',
      branch: 'task/AR-1',
      commit: 'approved-AR-1',
      runner: 'github_actions',
      createdAt: at,
    });
    h!.repos.fullTestRuns.finish('review-run', { status: 'passed', finishedAt: at });
    merger.isAncestor.mockImplementation(
      async (_ref, input) => input.ancestor === 'base' && input.commit === 'approved-AR-1',
    );
    await start();
    await merged();
    expect(task().merged?.check).toMatchObject({ status: 'passed' });
    expect(task().merged?.check?.reused).toBeUndefined();
    expect(executor.run).toHaveBeenCalledTimes(1);
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
    const session = await waitForSession(h!.domain, { member: 'dev-1', taskKey: 'AR-1' });
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

  describe('the missing approval is asked before the merge is checked (PM-484)', () => {
    // The done gate asks for the merge approval (an owner's label) next to the code review, like the small team.
    const needsApproval = (c: ProjectConfig) => {
      c.team.merger = { kind: 'code_reviewer' };
      c.pipeline.stages
        .find((s) => s.id === 'done')!
        .gate!.conditions.push({ type: 'has_label', label: 'merge-ok' });
    };
    const withApproval = ['code-review-ok', 'merge-ok'];
    const openDecisions = () => h!.domain.inbox.list('AR', { kind: 'decision', state: 'open' });
    const approve = async (itemId: string) =>
      h!.domain.inbox.resolve('AR', itemId, { optionId: 'approve' }, { handle: 'owner', access: 'owner' });
    const movesOf = () => (h!.domain.tasks as unknown as { moves: TaskMoves }).moves;

    it('opens the approval request, with the merge that follows, and checks no merge', async () => {
      await setup({ adjust: needsApproval });
      const config = await h!.domain.projects.config('AR');
      for (const session of h!.domain.sessions.list('AR')) await h!.domain.sessions.stop('AR', session.id);
      const requested = await move();
      expect(requested.moved).toBe(false);
      expect(requested.pendingApproval).toHaveLength(1);
      expect(gateRequestOf(requested.pendingApproval[0]!)).toMatchObject({
        label: 'merge-ok',
        merge: { merger: 'cr', base: config.project.repos[0]!.defaultBranch },
      });
      expect(task().status).toBe('waiting');
      expect(row()).toBeNull();
      expect(merger.prepare).not.toHaveBeenCalled();
      expect(h!.domain.taskWaits.ofCard(config, task())?.reason).toBe('approval');
    });

    it('asks for the merge once the approval is given, and moves after the merge', async () => {
      await setup({ adjust: needsApproval });
      const requested = await move();
      await approve(requested.pendingApproval[0]!.id);
      expect(task().labels).toContain('merge-ok');
      expect(task().stageId).toBe('code_review');
      expect(row()).toMatchObject({ state: 'requested', merger: 'cr' });
      expect(events('task_merge_requested')).toHaveLength(1);
      await start('AR-1', aiActor('cr'));
      await merged();
      await move();
      expect(task().status).toBe('done');
    });

    it('requests the approval for an AI member, a drop on the board and a group drop', async () => {
      await setup({ adjust: needsApproval });
      const session = await waitForSession(h!.domain, { member: 'dev-1', taskKey: 'AR-1' });
      const ctx = { projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1', sessionId: session.id };
      // The team tool words the request for the member: not `task_not_merged`.
      await expect(h!.domain.teamTools.updateTask(ctx, { taskKey: 'AR-1', stageId: 'done' })).rejects.toThrow(
        'needs a human approval',
      );
      expect(openDecisions()).toHaveLength(1);
      const drop = { columnId: 'done', fromStageId: 'code_review', placement: { at: 'top' } } as const;
      await expect(h!.domain.tasks.moveOnBoard('AR', 'AR-1', drop, OWNER_ACTOR)).rejects.toMatchObject({
        code: 'approval_requested',
      });
      await card('AR-2', 'web', 'dev-2', 'AR-1');
      const group = await h!.domain.tasks.moveOnBoard(
        'AR',
        'AR-1',
        { ...drop, withSubtasks: true },
        OWNER_ACTOR,
      );
      expect(group.group).toEqual([
        expect.objectContaining({ taskKey: 'AR-1', outcome: 'approval_pending' }),
        expect.objectContaining({ taskKey: 'AR-2', outcome: 'approval_pending' }),
      ]);
      expect(merger.prepare).not.toHaveBeenCalled();
    });

    it('still refuses a card with every label but no merge', async () => {
      await setup({ adjust: needsApproval });
      h!.repos.tasks.update(task().id, { labels: withApproval });
      await expect(move()).rejects.toMatchObject({ code: 'task_not_merged', details: { merger: 'cr' } });
      expect(openDecisions()).toHaveLength(0);
    });

    it('writes nothing when one update puts the approval on and moves without the merge', async () => {
      await setup({ adjust: needsApproval });
      await expect(
        h!.domain.tasks.update('AR', 'AR-1', { addLabels: ['merge-ok'], stageId: 'done' }, OWNER_ACTOR),
      ).rejects.toMatchObject({ code: 'task_not_merged' });
      expect(task().labels).toEqual(['code-review-ok']);
      expect(task().stageId).toBe('code_review');
      expect(openDecisions()).toHaveLength(0);
    });

    it('refuses a move whose approval came after it was prepared', async () => {
      await setup({ adjust: needsApproval });
      const prepare = movesOf().prepareMove.bind(movesOf());
      vi.spyOn(movesOf(), 'prepareMove').mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        h!.repos.tasks.update(task().id, { labels: withApproval });
        return prepared;
      });
      await expect(move()).rejects.toMatchObject({ code: 'task_not_merged' });
      expect(task().stageId).toBe('code_review');
    });

    it('does not move on an approval whose merge was not checked, but asks for the merge', async () => {
      await setup({ adjust: needsApproval });
      const requested = await move();
      vi.spyOn(movesOf(), 'prepareMove').mockResolvedValue({ handover: null, mergeChecked: false });
      await approve(requested.pendingApproval[0]!.id);
      expect(task().stageId).toBe('code_review');
      expect(task().status).toBe('active');
      expect(row()).toMatchObject({ state: 'requested' });
    });

    it('asks for the merge before the release approval of a web client project', async () => {
      await setup({ fullPipeline: true });
      h!.repos.tasks.update(task().id, { stageId: 'merge', labels: withApproval });
      await expect(h!.domain.tasks.moveToStage('AR', 'AR-1', 'release', OWNER_ACTOR)).rejects.toMatchObject({
        code: 'task_not_merged',
      });
      expect(openDecisions()).toHaveLength(0);
      expect(row()).toMatchObject({ state: 'requested' });
      await start();
      await merged();
      const requested = await h!.domain.tasks.moveToStage('AR', 'AR-1', 'release', OWNER_ACTOR);
      expect(requested.pendingApproval).toHaveLength(1);
      const gate = gateRequestOf(requested.pendingApproval[0]!);
      expect(gate).toMatchObject({ label: 'release-ok' });
      expect(gate?.merge).toBeUndefined();
    });
  });
});
