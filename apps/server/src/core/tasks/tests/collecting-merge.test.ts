import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import type { BranchMerger } from '../../../contracts';
import { createDomainHarness, OWNER_ACTOR } from '../../../../test/helpers/domain-harness';
import type { DomainHarness } from '../../../../test/helpers/domain-harness';
import { makeLocalOnly } from '../../../../test/helpers/test-template';

const AT = '2026-10-14T10:00:00.000Z';
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 3000 });

function fakeMerger() {
  return {
    prepare: vi.fn<BranchMerger['prepare']>(async () => ({
      local: 'base',
      remote: null,
      relation: 'same',
      contains: { local: false, remote: null },
      checkout: null,
    })),
    isAncestor: vi.fn<BranchMerger['isAncestor']>(async () => false),
    releaseCheck: vi.fn<BranchMerger['releaseCheck']>(async () => {}),
    checkoutConflicts: vi.fn<BranchMerger['checkoutConflicts']>(async () => []),
  };
}

/**
 * A collecting card without a branch or code of its own closes with its parts although the repository
 * requires a merge, whatever the engine is doing (PM-797); the card with a trace of a source keeps the merge check.
 */
describe.each([
  ['online', false],
  ['offline', true],
])('collecting card without code of its own, engine %s (PM-797)', (_name, offline) => {
  let h: DomainHarness | undefined;
  let merger: ReturnType<typeof fakeMerger>;
  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.cleanup();
    h = undefined;
  });

  /** AR-1 is the collecting card, in the first stage; its requirements: a merge, and gates it lacks the labels of. */
  async function setup(opts: { assignee?: boolean } = {}) {
    merger = fakeMerger();
    h = await createDomainHarness({
      merger: offline ? null : (merger as unknown as BranchMerger),
      adjust(config: ProjectConfig) {
        makeLocalOnly(config);
        config.project.repos[0]!.requireMerge = true;
        config.team.merger = { kind: 'member', handle: 'dev-1' };
      },
    });
    await h.domain.tasks.create('AR', { title: 'Collecting card', repo: 'web' }, OWNER_ACTOR);
    if (opts.assignee) {
      await h.domain.tasks.update('AR', 'AR-1', { assignee: 'dev-1' }, OWNER_ACTOR);
      await h.domain.tasks.update('AR', 'AR-1', { assignee: null }, OWNER_ACTOR);
    }
  }
  const part = (stageId: string) =>
    h!.domain.tasks.create(
      'AR',
      { title: 'A part', parentKey: 'AR-1', stageId, importedAt: AT },
      OWNER_ACTOR,
    );
  /** The card's branch has a worktree with committed work, as a source read finds it. */
  function withWorktreeHead() {
    const tree = {
      path: '/worktrees/AR-1',
      branch: 'task/AR-1',
      repo: 'web',
      gitDir: '/worktrees/AR-1/.git',
    };
    h!.worktrees.existing.set('AR/AR-1/web', tree);
    h!.worktrees.heads.set(tree.path, {
      path: tree.path,
      branch: tree.branch,
      commit: 'approved',
      dirty: false,
      changes: 0,
      committedAt: null,
    });
  }
  const card = () => h!.domain.tasks.get('AR', 'AR-1');
  const closeByUpdate = () => h!.domain.tasks.update('AR', 'AR-1', { stageId: 'done' }, OWNER_ACTOR);
  const mcp = () =>
    h!.domain.teamTools.updateTask(
      { projectKey: 'AR', member: 'dev-1', sessionId: 'ses_none', taskKey: null },
      { taskKey: 'AR-1', stageId: 'done' },
    );
  /** The reads and the merge preparations that need the engine. */
  function watchEngine() {
    return {
      sourceHead: vi.spyOn(h!.domain.sessions, 'sourceHead'),
      head: vi.spyOn(h!.worktrees, 'head'),
      find: vi.spyOn(h!.worktrees, 'find'),
    };
  }
  function expectEngineUntouched(watched: ReturnType<typeof watchEngine>) {
    expect(watched.sourceHead).not.toHaveBeenCalled();
    expect(watched.head).not.toHaveBeenCalled();
    expect(watched.find).not.toHaveBeenCalled();
    expect(merger.prepare).not.toHaveBeenCalled();
    expect(merger.isAncestor).not.toHaveBeenCalled();
  }
  const handover = () =>
    h!.repos.taskHandovers.save({
      projectKey: 'AR',
      taskKey: 'AR-1',
      commit: 'approved',
      branch: 'task/AR-1',
      stageId: 'code_review',
      at: AT,
    });
  const stageEvents = () =>
    h!.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((event) => event.type === 'task_stage_changed');

  it('closes by a person’s update without reading the source', async () => {
    await setup();
    await part('done');
    const watched = watchEngine();
    await closeByUpdate();
    expect(card().status).toBe('done');
    expect(stageEvents()[0]?.data).toMatchObject({ partsClosed: { done: ['AR-2'], cancelled: [] } });
    expectEngineUntouched(watched);
  });

  it('closes by the update_task tool without reading the source', async () => {
    await setup();
    await part('done');
    const watched = watchEngine();
    const { task } = await mcp();
    expect(task).toMatchObject({ key: 'AR-1', status: 'done', stageId: 'done' });
    expectEngineUntouched(watched);
  });

  it('closes by itself when its last part closes', async () => {
    await setup();
    await part('release');
    await part('release');
    const watched = watchEngine();
    await h!.domain.tasks.moveToStage('AR', 'AR-2', 'done', OWNER_ACTOR);
    await settle();
    expect(card().status).toBe('active');
    await h!.domain.tasks.moveToStage('AR', 'AR-3', 'done', OWNER_ACTOR);
    await waitFor(() => expect(card().status).toBe('done'));
    await settle();
    expect(stageEvents()).toHaveLength(1);
    expectEngineUntouched(watched);
  });

  it('keeps the gates and the open part rules', async () => {
    await setup();
    await part('done');
    await part('release');
    await expect(closeByUpdate()).rejects.toMatchObject({ code: 'gate_blocked' });
    expect(card().status).toBe('active');
  });

  it.each([
    ['a hand-over', () => handover()],
    ['a branch link', () => h!.repos.tasks.upsertLink(card().id, { kind: 'branch', ref: 'task/AR-1' }, AT)],
    [
      'a review pin',
      () =>
        h!.repos.db
          .prepare(
            `INSERT INTO task_review_pins (project_key, task_key, stage_id, commit_id, branch, pinned_at, pinned_by)
             VALUES ('AR', 'AR-1', 'code_review', 'approved', 'task/AR-1', ?, 'dev-1')`,
          )
          .run(AT),
    ],
    [
      'an old session with a branch',
      () =>
        h!.repos.db
          .prepare(
            `INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd,
               branch, state, started_at, last_activity_at)
             VALUES ('ses_old', 'AR', 'dev-1', 'task', 'AR-1', 'claude-1', '/work', 'task/AR-1', 'ended', ?, ?)`,
          )
          .run(AT, AT),
    ],
  ])('still refuses a card with %s while its source is not merged', async (_trace, add) => {
    await setup();
    await part('done');
    withWorktreeHead();
    add();
    await expect(closeByUpdate()).rejects.toMatchObject({ code: 'task_not_merged' });
    await expect(mcp()).rejects.toThrow();
    expect(card().status).toBe('active');
  });

  it('lets a card with a trace of a source through once the source is merged', async () => {
    await setup();
    await part('done');
    handover();
    merger.isAncestor.mockResolvedValue(true);
    merger.prepare.mockResolvedValue({
      local: 'base',
      remote: null,
      relation: 'same',
      contains: { local: true, remote: null },
      checkout: null,
    });
    if (offline) {
      await expect(closeByUpdate()).rejects.toMatchObject({ code: 'task_not_merged' });
      return;
    }
    await closeByUpdate();
    expect(card().status).toBe('done');
  });

  it('sends a card that once had an assignee to the merge check, and a failed read does not release it', async () => {
    await setup({ assignee: true });
    await part('done');
    const watched = watchEngine();
    watched.sourceHead.mockRejectedValue(new Error('engine disconnected during read'));
    await expect(closeByUpdate()).rejects.toMatchObject({
      code: 'task_not_merged',
      details: { reason: 'engine_unavailable' },
    });
    expect(watched.sourceHead).toHaveBeenCalled();
    expect(card().status).toBe('active');
  });

  it('refuses a card that has an assignee in the same update', async () => {
    await setup();
    await part('done');
    const watched = watchEngine();
    watched.sourceHead.mockRejectedValue(new Error('engine disconnected during read'));
    await expect(
      h!.domain.tasks.update('AR', 'AR-1', { stageId: 'done', assignee: 'dev-1' }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'task_not_merged' });
    expect(watched.sourceHead).toHaveBeenCalled();
  });

  it('does not use an exception that went stale when a trace of a source came after the preparation', async () => {
    await setup();
    await part('done');
    const original = h!.repos.tasks.sourceEvidence.bind(h!.repos.tasks);
    let calls = 0;
    vi.spyOn(h!.repos.tasks, 'sourceEvidence').mockImplementation((projectKey, taskKey) => {
      const read = original(projectKey, taskKey);
      if ((calls += 1) === 1) handover();
      return read;
    });
    await expect(closeByUpdate()).rejects.toMatchObject({ code: 'task_not_merged' });
    expect(card().status).toBe('active');
    expect(stageEvents()).toHaveLength(0);
  });

  it('does not use a waiver that went stale when a part reopened after the preparation', async () => {
    await setup();
    await part('done');
    const original = h!.repos.tasks.sourceEvidence.bind(h!.repos.tasks);
    let calls = 0;
    vi.spyOn(h!.repos.tasks, 'sourceEvidence').mockImplementation((projectKey, taskKey) => {
      const read = original(projectKey, taskKey);
      if ((calls += 1) === 1)
        h!.repos.tasks.update(h!.domain.tasks.get('AR', 'AR-2').id, { status: 'active', stageId: 'release' });
      return read;
    });
    await expect(closeByUpdate()).rejects.toMatchObject({ code: 'gate_blocked' });
    expect(card().status).toBe('active');
  });
});
