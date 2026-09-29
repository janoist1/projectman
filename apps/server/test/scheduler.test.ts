import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { DomainError } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

const start = (h: DomainHarness, key: string, assignee?: string) =>
  h.domain.scheduler.startTask('AR', key, { assignee, actor: OWNER_ACTOR, author: OWNER, sponsor: 'owner' });

async function code(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  return (err as DomainError).code;
}

/** Removes every gate so tasks can move straight to done. */
function withoutGates(config: ProjectConfig): void {
  for (const stage of config.pipeline.stages) {
    if (stage.kind !== 'release') delete stage.gate;
  }
  config.pipeline.stages = config.pipeline.stages.filter((s) => s.kind !== 'release');
}

describe('scheduler', () => {
  let h: DomainHarness;
  afterEach(() => h.cleanup());

  it('assigns a free developer, moves the task into the work stage and starts its session with the brief', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    const result = await start(h, task.key);

    expect(result.task).toMatchObject({ assignee: 'dev-1', stageId: 'development', status: 'active' });
    const spec = h.runner.lastStarted();
    expect(spec).toMatchObject({
      sessionId: result.session!.id,
      claudeSessionId: result.session!.claudeSessionId,
      resume: false,
      displayName: 'Dev One · AR-1',
      model: 'opus',
      permissionMode: 'default',
      allowedTools: ['mcp__team__*'],
      initialMessage: 'Brief for AR-1: Login page',
    });
    expect(h.worktrees.calls).toEqual([{ repoName: 'web', taskKey: 'AR-1' }]);
    expect(spec.cwd).toBe(join(h.dir, 'worktrees', 'AR', 'AR-1'));
    expect(result.session!.cwd).toBe(spec.cwd);
    expect(result.session!.branch).toBe('task/AR-1');
    expect(spec.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:4700\/mcp\/[\w-]{20,}$/);
    const token = spec.mcpUrl.split('/').pop()!;
    expect(h.domain.sessions.resolveToken(token)).toEqual({
      sessionId: result.session!.id,
      projectKey: 'AR',
      member: 'dev-1',
      taskKey: 'AR-1',
    });
    expect(h.contextBuilder.inputs[0]).toMatchObject({ task: { key: 'AR-1' }, stage: { id: 'development' } });

    // Without a repo the session starts in the workspace.
    const other = await h.domain.tasks.create('AR', { title: 'Docs' }, OWNER_ACTOR);
    const second = await start(h, other.key);
    expect(second.session!.cwd).toBe(h.workspace);
    expect(second.session!.member).toBe('dev-2');
  });

  it('respects member capacity and refuses when nobody is free and temp workers are off', async () => {
    h = await createDomainHarness();
    for (let i = 1; i <= 3; i++) await h.domain.tasks.create('AR', { title: `Task ${i}` }, OWNER_ACTOR);
    expect((await start(h, 'AR-1')).task.assignee).toBe('dev-1');
    expect((await start(h, 'AR-2')).task.assignee).toBe('dev-2');
    h.runner.setState(h.runner.started[0]!.sessionId, 'idle');
    h.runner.setState(h.runner.started[1]!.sessionId, 'idle');
    expect(await code(start(h, 'AR-3'))).toBe('no_free_member');
    expect(await code(start(h, 'AR-3', 'dev-1'))).toBe('member_at_capacity');
    // Starting a task again reuses the running session of its assignee.
    const again = await start(h, 'AR-1');
    expect(again.session!.id).toBe(h.runner.started[0]!.sessionId);
    expect(h.runner.started).toHaveLength(2);
  });

  it('respects the global cap on working AI sessions', async () => {
    h = await createDomainHarness({ adjust: (c) => void (c.team.limits.maxConcurrentAi = 1) });
    await h.domain.tasks.create('AR', { title: 'One' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Two' }, OWNER_ACTOR);
    const first = await start(h, 'AR-1');
    expect(await code(start(h, 'AR-2'))).toBe('ai_limit_reached');
    h.runner.setState(first.session!.id, 'working', 'Bash: npm test');
    expect(await code(start(h, 'AR-2'))).toBe('ai_limit_reached');
    h.runner.setState(first.session!.id, 'idle');
    expect((await start(h, 'AR-2')).task.assignee).toBe('dev-2');
  });

  it('pauses new AI work above the plan usage threshold; unknown usage allows it', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'One' }, OWNER_ACTOR);
    h.runnerModule.planUsage.value = {
      fiveHourPercent: 91,
      weeklyPercent: 40,
      fiveHourResetsAt: null,
      weeklyResetsAt: null,
      fetchedAt: '2026-09-29T10:00:00.000Z',
    };
    expect(await code(start(h, 'AR-1'))).toBe('plan_usage_paused');
    h.runnerModule.planUsage.value = { ...h.runnerModule.planUsage.value, fiveHourPercent: 80 };
    expect((await start(h, 'AR-1')).session).not.toBeNull();
  });

  it('hires a temp worker when everyone is busy and retires it when its task is done', async () => {
    h = await createDomainHarness({
      adjust: (c) => {
        withoutGates(c);
        c.team.limits.tempWorkers = { enabled: true, max: 1, role: 'developer' };
      },
    });
    for (let i = 1; i <= 4; i++) await h.domain.tasks.create('AR', { title: `Task ${i}` }, OWNER_ACTOR);
    await start(h, 'AR-1');
    await start(h, 'AR-2');
    for (const s of h.runner.started) h.runner.setState(s.sessionId, 'idle');

    const third = await start(h, 'AR-3');
    expect(third.hired).toMatchObject({ handle: 'dev-3', role: 'developer', temp: true, sponsor: 'owner' });
    expect(third.task.assignee).toBe('dev-3');
    const config = await h.domain.projects.config('AR');
    expect(config.team.members.some((m) => m.handle === 'dev-3')).toBe(true);
    h.runner.setState(third.session!.id, 'idle');
    expect(await code(start(h, 'AR-4'))).toBe('no_free_member'); // only one temp worker allowed

    await h.domain.tasks.moveToStage('AR', 'AR-3', 'done', OWNER_ACTOR);
    const after = await h.domain.projects.config('AR');
    expect(after.team.members.some((m) => m.handle === 'dev-3')).toBe(false);
    expect(h.repos.memberState.get('AR', 'dev-3')?.status).toBe('retired');
    expect(h.runner.isRunning(third.session!.id)).toBe(false);
    const history = await h.domain.projects.history('AR');
    expect(history[0]!.message).toBe('Retire dev-3');
    expect(history[1]!.message).toBe('Hire temporary developer dev-3');

    // A new temp worker never reuses a retired handle.
    const fourth = await start(h, 'AR-4');
    expect(fourth.hired?.handle).toBe('dev-4');
  });

  it('a human assignee gets the task without an AI session', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Manual' }, OWNER_ACTOR);
    const result = await start(h, 'AR-1', 'owner');
    expect(result.session).toBeNull();
    expect(result.task).toMatchObject({ assignee: 'owner', stageId: 'development' });
    expect(h.runner.started).toHaveLength(0);
  });
});
