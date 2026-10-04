import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerEvent } from '@projectman/shared';
import type { ProjectConfig, Task } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import type { DomainHarness } from './helpers/domain-harness';
import { settle } from './helpers/fakes';
import { waitFor } from '../src/runner/test-helpers';
import { aiActor } from '../src/domain';

const start = (h: DomainHarness, key: string, assignee?: string) =>
  h.domain.taskStarts.start('AR', key, { assignee, actor: OWNER_ACTOR, author: OWNER, sponsor: 'owner' });

const code = async (promise: Promise<unknown>): Promise<string> => (await rejection(promise)).code;

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
      allowedTools: expect.arrayContaining(['mcp__team__*', 'Bash(git commit:*)']),
      initialMessage: 'Brief for AR-1: Login page',
    });
    expect(h.worktrees.calls).toEqual([{ repoName: 'web', taskKey: 'AR-1' }]);
    expect(spec.cwd).toBe(join(h.dir, 'worktrees', 'AR', 'AR-1-web'));
    expect(result.session!.cwd).toBe(spec.cwd);
    expect(result.session!.branch).toBe('task/AR-1');
    expect(result.task.links).toEqual([{ kind: 'branch', ref: 'task/AR-1', repo: 'acme/web' }]);
    expect(spec.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:4700\/mcp\/[\w-]{20,}$/);
    const token = spec.mcpUrl.split('/').pop()!;
    expect(h.domain.sessions.resolveToken(token)).toEqual({
      sessionId: result.session!.id,
      projectKey: 'AR',
      member: 'dev-1',
      taskKey: 'AR-1',
    });
    expect(h.contextBuilder.inputs[0]).toMatchObject({ task: { key: 'AR-1' }, stage: { id: 'development' } });

    // A task without a repo of its own works in the worktree of the project's only repo, never in the workspace.
    const other = await h.domain.tasks.create('AR', { title: 'Docs' }, OWNER_ACTOR);
    const second = await start(h, other.key);
    expect(second.session!.cwd).toBe(join(h.dir, 'worktrees', 'AR', 'AR-2-web'));
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

  it('stops the sessions of a done task and removes its clean worktree, keeping local work', async () => {
    h = await createDomainHarness({ adjust: withoutGates });
    await h.domain.tasks.create('AR', { title: 'Clean', repo: 'web' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Dirty', repo: 'web' }, OWNER_ACTOR);
    const clean = (await start(h, 'AR-1')).session!;
    const dirty = (await start(h, 'AR-2')).session!;
    h.worktrees.statuses.set(dirty.cwd, { dirty: true, unpushedCommits: 0 });

    await h.domain.tasks.moveToStage('AR', 'AR-1', 'done', OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', 'AR-2', 'done', OWNER_ACTOR);
    await settle();

    expect(h.runner.isRunning(clean.id)).toBe(false);
    expect(h.runner.isRunning(dirty.id)).toBe(false);
    expect(h.domain.sessions.get('AR', clean.id).state).toBe('exited');
    expect(h.worktrees.removed).toEqual([clean.cwd]);
  });

  /** AR-1 in code review: the developer's session and the reviewer's, both running. */
  async function inReview(h: DomainHarness) {
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    const dev = (await start(h, 'AR-1')).session!;
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    const review = await waitFor(
      () => h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: 'AR-1' }),
      { what: 'the reviewer session' },
    );
    return { dev, review };
  }

  it('lets the session that moved its task to done finish its turn, then stops it (PM-190)', async () => {
    h = await createDomainHarness({ adjust: withoutGates });
    const { dev, review } = await inReview(h);
    h.runner.setState(review.id, 'working');

    await h.domain.tasks.moveToStage('AR', 'AR-1', 'done', aiActor('cr'));
    await waitFor(() => !h.runner.isRunning(dev.id), { what: 'the developer session stopped' });
    await settle();

    // The mover is still in its turn: it runs, its team tools still answer, the worktree stays.
    expect(h.runner.isRunning(review.id)).toBe(true);
    const token = h.runner.started
      .find((s) => s.sessionId === review.id)!
      .mcpUrl.split('/')
      .pop()!;
    expect(h.domain.sessions.resolveToken(token)).toMatchObject({ sessionId: review.id });
    expect(h.worktrees.removed).toEqual([]);

    h.runner.setState(review.id, 'idle');
    await waitFor(() => !h.runner.isRunning(review.id), { what: 'the mover stopped at the end of its turn' });
    expect(h.domain.sessions.get('AR', review.id).state).toBe('exited');
    await waitFor(() => h.worktrees.removed.length > 0, { what: 'the worktree removed' });
    expect(h.worktrees.removed).toEqual([dev.cwd]);
  });

  it('delivers what the mover sends after the move through the team tools, then stops it (PM-190)', async () => {
    h = await createDomainHarness({ adjust: withoutGates });
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    const dev = (await start(h, 'AR-1')).session!;
    h.runner.setState(dev.id, 'working');
    const token = h.runner.started
      .find((s) => s.sessionId === dev.id)!
      .mcpUrl.split('/')
      .pop()!;
    const ctx = h.domain.sessions.resolveToken(token)!;

    // The calls of the session's own turn: the move, and after it a message.
    await h.domain.teamTools.updateTask(ctx, { taskKey: 'AR-1', stageId: 'done' });
    await settle();
    expect(h.runner.isRunning(dev.id)).toBe(true);
    await h.domain.teamTools.sendMessage(ctx, { to: ['owner'], text: 'Five notes that do not block' });
    expect(h.repos.messages.list('AR').find((m) => m.body === 'Five notes that do not block')).toMatchObject({
      from: 'dev-1',
      to: ['owner'],
      taskKey: 'AR-1',
    });

    h.runner.setState(dev.id, 'idle');
    await waitFor(() => !h.runner.isRunning(dev.id), { what: 'the mover stopped at the end of its turn' });
    expect(h.domain.sessions.get('AR', dev.id).state).toBe('exited');
  });

  it('stops a mover that does not finish its turn at the limit, and a mover already idle at once', async () => {
    h = await createDomainHarness({ adjust: withoutGates, doneTurnLimitMs: 50 });
    const { review } = await inReview(h);
    h.runner.setState(review.id, 'working');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'done', aiActor('cr'));
    await settle();
    expect(h.runner.isRunning(review.id)).toBe(true);
    await waitFor(() => !h.runner.isRunning(review.id), { what: 'the mover stopped at the limit' });

    await h.domain.tasks.create('AR', { title: 'Signup page', repo: 'web' }, OWNER_ACTOR);
    const second = (await start(h, 'AR-2')).session!;
    h.runner.setState(second.id, 'idle');
    await h.domain.tasks.moveToStage('AR', 'AR-2', 'done', aiActor('dev-1'));
    await settle();
    expect(h.runner.isRunning(second.id)).toBe(false);
  });

  it('a human assignee gets the task without an AI session', async () => {
    h = await createDomainHarness({
      adjust: (c) => {
        c.pipeline.stages.find((s) => s.kind === 'work')!.owners!.push('owner');
      },
    });
    await h.domain.tasks.create('AR', { title: 'Manual' }, OWNER_ACTOR);
    const result = await start(h, 'AR-1', 'owner');
    expect(result.session).toBeNull();
    expect(result.task).toMatchObject({ assignee: 'owner', stageId: 'development' });
    expect(h.runner.started).toHaveLength(0);
  });

  it('starts the AI owner of a later stage when a human moves the task there', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const dev = await start(h, 'AR-1');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);

    const review = await waitFor(
      () => h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: 'AR-1' }),
      { what: 'the reviewer session' },
    );
    expect(h.runner.lastStarted()).toMatchObject({
      sessionId: review.id,
      initialMessage: 'Brief for AR-1: Login page',
    });
    // Back to the work stage: nothing starts, the developer's live session hears of it.
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await waitFor(
      () => h.runner.messages.find((m) => m.sessionId === dev.session!.id && /Development/.test(m.text)),
      {
        what: 'the developer notice',
      },
    );
    expect(h.runner.started).toHaveLength(2);
    // Re-entering the stage tells the reviewer's running session instead of starting another one.
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    const notice = await waitFor(
      () => h.runner.messages.find((m) => m.sessionId === review.id && /Code review/.test(m.text)),
      { what: 'the reviewer notice' },
    );
    expect(notice.text).toMatch(
      /^\[team message from owner about AR-1\]\nTask AR-1 is now in stage Code review/,
    );
    expect(h.runner.started).toHaveLength(2);
  });

  it('tells a resumed stage owner session which stage the task is in now', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await start(h, 'AR-1');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    const review = await waitFor(
      () => h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: 'AR-1' }),
      { what: 'the reviewer session' },
    );
    // The conversation ends with a transcript, so the next start resumes it (without a brief).
    h.runner.emit({ type: 'transcript_path', sessionId: review.id, path: '/tmp/cr-transcript.jsonl' });
    h.runner.emit({ type: 'exit', sessionId: review.id, exitCode: 0, signal: null });
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);

    const notice = await waitFor(
      () => h.runner.messages.find((m) => m.sessionId === review.id && /Code review/.test(m.text)),
      { what: 'the notice to the resumed reviewer' },
    );
    expect(h.runner.lastStarted()).toMatchObject({
      sessionId: review.id,
      resume: true,
      // dev-1 still works on the card: the resumed reviewer is told so first (PM-249).
      initialMessage: 'Standing AR-1: workers dev-1; questions 0\n\nContinue AR-1: Login page',
    });
    expect(notice.text).toContain('Task AR-1 is now in stage Code review');
  });

  it('defers the hand-over while admission refuses new AI work', async () => {
    h = await createDomainHarness({ adjust: (c) => void (c.team.limits.maxConcurrentAi = 1) });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const dev = await start(h, 'AR-1');
    const snapshots: Task[] = [];
    h.domain.bus.subscribe((event) => {
      if (event.type === 'task_upserted') {
        const parsed = ServerEvent.parse(event);
        if (parsed.type === 'task_upserted') snapshots.push(parsed.task);
      }
    });
    h.runner.setState(dev.session!.id, 'working', 'Bash: npm test');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    await settle();
    expect(h.runner.started).toHaveLength(1);
    const waiting = h.domain.tasks.get('AR', 'AR-1').startWaiting;
    expect(waiting).toMatchObject({ reason: 'ai_limit_reached', member: 'cr', since: expect.any(String) });
    expect(h.domain.tasks.list('AR')[0]?.startWaiting).toEqual(waiting);
    expect(h.domain.tasks.detail('AR', 'AR-1').task.startWaiting).toEqual(waiting);
    expect(snapshots.at(-1)?.startWaiting).toEqual(waiting);
    const snapshotCount = snapshots.length;
    // Still refused: the retry keeps waiting.
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(1);
    expect(h.domain.tasks.get('AR', 'AR-1').startWaiting).toEqual(waiting);
    expect(snapshots).toHaveLength(snapshotCount);
    // Capacity frees up: the retry starts the reviewer, once.
    h.runner.setState(dev.session!.id, 'idle');
    await h.domain.admission.retryDeferred();
    expect(h.domain.tasks.get('AR', 'AR-1').startWaiting).toBeUndefined();
    expect(snapshots.length).toBeGreaterThan(snapshotCount);
    expect(snapshots.at(-1)?.startWaiting).toBeUndefined();
    expect(h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: 'AR-1' })).not.toBeNull();
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(2);
    expect(h.log.errors).toEqual([]);
  });

  it('drops a deferred hand-over once the task leaves the stage', async () => {
    h = await createDomainHarness({ adjust: (c) => void (c.team.limits.maxConcurrentAi = 1) });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const dev = await start(h, 'AR-1');
    h.runner.setState(dev.session!.id, 'working', 'Bash: npm test');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    await settle();
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await settle();
    h.runner.setState(dev.session!.id, 'idle');
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(1);
  });
});
