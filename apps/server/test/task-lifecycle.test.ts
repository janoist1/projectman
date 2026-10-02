import { existsSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, ServerEvent, TaskStatus } from '@projectman/shared';
import { aiActor, humanActor, LIVE_SESSION_STATES } from '../src/domain';
import type { StageChange } from '../src/domain';
import { TEAM_TOOLS, TEAM_TOOL_NAMES } from '../src/mcp/tools';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

const start = (h: DomainHarness, taskKey: string) =>
  h.domain.taskStarts.start('AR', taskKey, { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });

describe('task lifecycle', () => {
  let h: DomainHarness;
  let events: ServerEvent[];
  beforeEach(async () => {
    h = await createDomainHarness();
    events = [];
    h.domain.bus.subscribe((event) => events.push(event));
    await h.domain.tasks.create('AR', { title: 'Acme webshop checkout', repo: 'web' }, OWNER_ACTOR);
  });
  afterEach(() => h.cleanup());

  it('cancels all live task sessions, preserves the worktree and broadcasts the attributed reason', async () => {
    const { session } = await start(h, 'AR-1');
    const review = await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' });
    const other = await h.domain.sessions.ensureSession('AR', 'dev-2', { type: 'general' });
    const file = `${session!.cwd}/checkout.txt`;
    writeFileSync(file, 'Acme checkout draft');
    const before = h.domain.tasks.get('AR', 'AR-1');
    const cancelled = await h.domain.tasks.cancel('AR', 'AR-1', { reason: 'Scope changed' }, OWNER_ACTOR);

    expect(cancelled).toEqual({
      ...before,
      status: 'cancelled',
      closedAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(h.runner.stopped).toEqual([session!.id, review.session.id]);
    expect(h.domain.sessions.get('AR', session!.id)).toMatchObject({
      state: 'exited',
      endedAt: expect.any(String),
    });
    expect(h.runner.isRunning(other.session.id)).toBe(true);
    expect(h.worktrees.removed).toEqual([]);
    expect(existsSync(file)).toBe(true);
    // A delayed done cleanup must never remove a cancelled task's files.
    await h.domain.sessions.cleanupDoneTask('AR', 'AR-1');
    expect(h.worktrees.removed).toEqual([]);
    expect(events).toContainEqual({ type: 'task_upserted', projectKey: 'AR', task: cancelled });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'timeline_appended',
        event: expect.objectContaining({
          actor: OWNER_ACTOR,
          type: 'task_updated',
          data: {
            fields: ['status', 'closedAt'],
            action: 'cancelled',
            previousStatus: 'active',
            reason: 'Scope changed',
          },
        }),
      }),
    );
  });

  it.each(['active', 'waiting', 'blocked'] as const)('cancels a %s task without a reason', async (status) => {
    const task = h.domain.tasks.get('AR', 'AR-1');
    h.repos.tasks.update(task.id, { status });
    expect(await h.domain.tasks.cancel('AR', task.key, {}, OWNER_ACTOR)).toMatchObject({
      status: 'cancelled',
    });
    const event = h.domain.tasks.detail('AR', task.key).timeline.at(-1)!;
    expect(event.data).not.toHaveProperty('reason');
  });

  it('reopens in the same stage and clears closedAt and assignee without starting work', async () => {
    await start(h, 'AR-1');
    const cancelled = await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
    const reopened = await h.domain.tasks.reopen('AR', 'AR-1', OWNER_ACTOR);
    expect(reopened).toEqual({
      ...cancelled,
      status: 'active',
      closedAt: null,
      assignee: null,
      updatedAt: expect.any(String),
    });
    expect(h.runner.started).toHaveLength(1);
    expect(h.domain.tasks.detail('AR', 'AR-1').timeline.at(-1)).toMatchObject({
      type: 'task_updated',
      actor: OWNER_ACTOR,
      data: { fields: ['status', 'closedAt', 'assignee'], action: 'reopened', previousAssignee: 'dev-1' },
    });
    expect(events).toContainEqual({ type: 'task_upserted', projectKey: 'AR', task: reopened });
  });

  it.each(['dev-2', 'owner', null])('changes the assignee to %s without starting work', async (assignee) => {
    h.domain.tasks.assign('AR', 'AR-1', 'dev-1', OWNER_ACTOR);
    const task = await h.domain.tasks.update('AR', 'AR-1', { assignee, title: 'Acme checkout' }, OWNER_ACTOR);
    expect(task).toMatchObject({ assignee, title: 'Acme checkout', stageId: 'backlog' });
    expect(h.runner.started).toEqual([]);
    expect(h.domain.tasks.detail('AR', 'AR-1').timeline.at(-1)).toMatchObject({
      type: 'task_assigned',
      actor: OWNER_ACTOR,
      data: { assignee, previous: 'dev-1' },
    });
    expect(events).toContainEqual({ type: 'task_upserted', projectKey: 'AR', task });
  });

  it.each(LIVE_SESSION_STATES)(
    'rejects reassignment with a %s session, including an unassigned reviewer session',
    async (state) => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'cr', {
        type: 'task',
        taskKey: 'AR-1',
      });
      h.runner.setState(session.id, state);
      const before = h.domain.tasks.detail('AR', 'AR-1');
      for (const assignee of ['dev-2', null]) {
        await expect(
          h.domain.tasks.update(
            'AR',
            'AR-1',
            { assignee, stageId: 'development', title: 'Changed' },
            OWNER_ACTOR,
          ),
        ).rejects.toMatchObject({
          status: 409,
          code: 'task_session_live',
          details: { sessionId: session.id },
        });
      }
      expect(h.domain.tasks.detail('AR', 'AR-1')).toEqual(before);
    },
  );

  it.each(['exited', 'failed'] as const)('allows reassignment after a session is %s', async (state) => {
    const { session } = await start(h, 'AR-1');
    h.runner.emit({
      type: 'exit',
      sessionId: session!.id,
      exitCode: state === 'failed' ? 1 : 0,
      signal: null,
    });
    h.repos.sessions.update(session!.id, { state });
    expect(await h.domain.tasks.update('AR', 'AR-1', { assignee: 'dev-2' }, OWNER_ACTOR)).toMatchObject({
      assignee: 'dev-2',
    });
  });

  const loadOf = async (handle: string, excludeTaskKey?: string) =>
    h.domain.admission.memberLoad(await h.domain.projects.config('AR'), handle, excludeTaskKey);

  it('counts only what the member is working on now', async () => {
    const { session } = await start(h, 'AR-1');
    const second = await h.domain.tasks.create('AR', { title: 'Acme order summary' }, OWNER_ACTOR);
    expect(await loadOf('dev-1')).toBe(1);
    await expect(start(h, second.key)).rejects.toMatchObject({ code: 'member_at_capacity' });
    // The session ended but the task stays open and assigned: nothing is being worked on.
    h.runner.emit({ type: 'exit', sessionId: session!.id, exitCode: 0, signal: null });
    h.repos.sessions.update(session!.id, { state: 'exited' });
    expect(h.domain.tasks.get('AR', 'AR-1')).toMatchObject({ assignee: 'dev-1', status: 'active' });
    expect(await loadOf('dev-1')).toBe(0);
    expect((await start(h, second.key)).task.assignee).toBe('dev-1');
    expect(await loadOf('dev-1')).toBe(1);
  });

  it('does not count an idle session on a task that moved on to the next stage', async () => {
    const { session } = await start(h, 'AR-1');
    // Finished its turn, the process still runs, but the task is still in the member's own stage.
    h.runner.setState(session!.id, 'working');
    h.runner.setState(session!.id, 'idle');
    expect(h.runner.isRunning(session!.id)).toBe(true);
    expect(await loadOf('dev-1')).toBe(1);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    expect(h.runner.isRunning(session!.id)).toBe(true);
    expect(await loadOf('dev-1')).toBe(0);
    // A turn in progress counts wherever the task is.
    h.repos.sessions.update(session!.id, { state: 'working' });
    expect(await loadOf('dev-1')).toBe(1);
    expect(await loadOf('dev-1', 'AR-1')).toBe(0);
  });

  describe('temp workers carry one task at a time', () => {
    const by = { actor: OWNER_ACTOR, author: OWNER };
    const hireOne = async () => {
      await h.domain.projects.update('AR', by, (draft) => {
        draft.team.limits.tempWorkers = { enabled: true, max: 1, role: 'developer' };
        return 'Enable temp workers';
      });
      for (const title of ['Two', 'Three', 'Four', 'Five']) {
        await h.domain.tasks.create('AR', { title }, OWNER_ACTOR);
      }
      await h.domain.taskStarts.start('AR', 'AR-1', by);
      await h.domain.taskStarts.start('AR', 'AR-2', by);
      const third = await h.domain.taskStarts.start('AR', 'AR-3', by);
      expect(third.hired).toMatchObject({ temp: true });
      return { handle: third.hired!.handle, session: third.session! };
    };

    it('does not give a second task to a temp worker whose session ended', async () => {
      const temp = await hireOne();
      h.runner.emit({ type: 'exit', sessionId: temp.session.id, exitCode: 0, signal: null });
      h.repos.sessions.update(temp.session.id, { state: 'exited' });
      expect(await loadOf(temp.handle)).toBe(0);
      expect(h.domain.admission.hasOpenAssignment('AR', temp.handle)).toBe(true);
      // dev-1 and dev-2 are busy and the temp worker still carries AR-3: nobody is free.
      await expect(h.domain.taskStarts.start('AR', 'AR-4', by)).rejects.toMatchObject({
        code: 'no_free_member',
      });
      expect(h.domain.tasks.get('AR', 'AR-4').assignee).toBeNull();
    });

    it('retires a temp worker only when no open task is assigned to it', async () => {
      const temp = await hireOne();
      const finished = h.domain.tasks.get('AR', 'AR-3');
      h.domain.tasks.assign('AR', 'AR-4', temp.handle, OWNER_ACTOR);
      h.repos.sessions.update(temp.session.id, { state: 'exited' });
      h.repos.tasks.update(finished.id, { status: 'done', closedAt: new Date().toISOString() });
      const change = { task: h.domain.tasks.get('AR', 'AR-3') } as StageChange;
      await h.domain.taskStarts.retireFinishedTempWorker(change);
      expect((await h.domain.members.roster('AR')).map((m) => m.handle)).toContain(temp.handle);
      h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-4').id, {
        status: 'done',
        closedAt: new Date().toISOString(),
      });
      await h.domain.taskStarts.retireFinishedTempWorker({
        task: h.domain.tasks.get('AR', 'AR-4'),
      } as StageChange);
      expect((await h.domain.members.roster('AR')).map((m) => m.handle)).not.toContain(temp.handle);
    });
  });

  it.each(['cancelled', 'done'] as const)('excludes %s tasks from capacity', async (status) => {
    await start(h, 'AR-1');
    const second = await h.domain.tasks.create('AR', { title: 'Acme order summary' }, OWNER_ACTOR);
    await expect(start(h, second.key)).rejects.toMatchObject({ code: 'member_at_capacity' });
    if (status === 'cancelled') await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
    else
      h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, {
        status,
        closedAt: new Date().toISOString(),
      });
    expect(await loadOf('dev-1')).toBe(0);
    expect((await start(h, second.key)).task.assignee).toBe('dev-1');
    expect(h.domain.tasks.get('AR', 'AR-1').assignee).toBe('dev-1');
  });

  it.each(['active', 'waiting', 'blocked', 'done'] satisfies TaskStatus[])(
    'rejects reopening a %s task',
    async (status) => {
      h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { status });
      await expect(h.domain.tasks.reopen('AR', 'AR-1', OWNER_ACTOR)).rejects.toMatchObject({
        status: 409,
        code: 'task_not_cancelled',
      });
    },
  );

  it.each(['done', 'cancelled'] as const)('rejects cancelling a %s task', async (status) => {
    h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { status });
    await expect(h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR)).rejects.toMatchObject({
      status: 409,
      code: 'task_closed',
    });
  });

  it.each([
    aiActor('dev-1'),
    humanActor('dev-1'),
    humanActor('absent'),
    { kind: 'system', handle: null } satisfies Actor,
  ])('rejects lifecycle changes by $kind $handle', async (actor) => {
    await expect(h.domain.tasks.cancel('AR', 'AR-1', {}, actor)).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_access',
    });
    await expect(h.domain.tasks.reopen('AR', 'AR-1', actor)).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_access',
    });
    await expect(h.domain.tasks.update('AR', 'AR-1', { assignee: null }, actor)).rejects.toMatchObject({
      status: 403,
      code: 'insufficient_access',
    });
  });

  it('keeps team tools unchanged and rejects lifecycle fields in update_task', () => {
    expect(TEAM_TOOL_NAMES).not.toContain('cancel_task');
    expect(TEAM_TOOL_NAMES).not.toContain('reopen_task');
    expect(TEAM_TOOL_NAMES).not.toContain('reassign_task');
    const tool = TEAM_TOOLS.find((t) => t.name === 'update_task')!;
    for (const extra of [{ assignee: 'dev-2' }, { assignee: null }, { status: 'cancelled' }]) {
      expect(tool.inputSchema.safeParse({ task_key: 'AR-1', ...extra }).success).toBe(false);
    }
  });
});
