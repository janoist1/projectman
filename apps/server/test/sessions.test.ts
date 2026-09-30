import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@projectman/shared';
import { allowedToolsFor, DomainError, LOCAL_ONLY_DENIED_TOOLS } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { testConfig } from './helpers/test-template';

describe('session orchestrator', () => {
  let h: DomainHarness;
  let events: ServerEvent[];
  beforeEach(async () => {
    h = await createDomainHarness();
    events = [];
    h.domain.bus.subscribe((e) => events.push(e));
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(() => h.cleanup());

  const task = { type: 'task' as const, taskKey: 'AR-1' };

  it('reuses a running session, resumes an exited one in the same directory', async () => {
    const first = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(first).toMatchObject({ created: true, resumed: false, started: true });
    const again = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(again).toMatchObject({ created: false, started: false });
    expect(again.session.id).toBe(first.session.id);
    expect(h.runner.started).toHaveLength(1);

    const token = h.runner.lastStarted().mcpUrl.split('/').pop()!;
    h.runner.emit({ type: 'transcript_path', sessionId: first.session.id, path: '/tmp/transcript.jsonl' });
    h.runner.emit({ type: 'exit', sessionId: first.session.id, exitCode: 0, signal: null });
    expect(h.domain.sessions.get('AR', first.session.id)).toMatchObject({
      state: 'exited',
      transcriptPath: '/tmp/transcript.jsonl',
    });
    expect(h.domain.sessions.resolveToken(token)).toBeNull();

    const resumed = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(resumed).toMatchObject({ created: false, resumed: true, started: true });
    expect(resumed.session.id).toBe(first.session.id);
    const spec = h.runner.lastStarted();
    expect(spec).toMatchObject({
      resume: true,
      claudeSessionId: first.session.claudeSessionId,
      cwd: first.session.cwd,
      initialMessage: null,
    });
    expect(spec.mcpUrl.split('/').pop()).not.toBe(token);
    const timeline = h.domain.timeline
      .list('AR', { taskKey: 'AR-1' })
      .map((e) => [e.type, e.data.resumed ?? null]);
    expect(timeline).toContainEqual(['session_started', true]);
    expect(timeline).toContainEqual(['session_ended', null]);
  });

  it('reads a reloaded chat as its provider wrote it, relative to the session directory', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(session.provider).toBe('claude');
    expect(h.runner.lastStarted()).toMatchObject({ provider: 'claude', firstUserOrigin: 'brief' });
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/tmp/fictional.jsonl' });
    h.runnerModule.transcripts.set('/tmp/fictional.jsonl', []);
    await h.domain.sessions.detail('AR', session.id);
    const general = (await h.domain.sessions.ensureSession('AR', 'cr', { type: 'general' })).session;
    expect(h.runner.lastStarted()).toMatchObject({ firstUserOrigin: 'human' });
    h.runner.emit({ type: 'transcript_path', sessionId: general.id, path: '/tmp/general.jsonl' });
    h.runnerModule.transcripts.set('/tmp/general.jsonl', []);
    await h.domain.sessions.detail('AR', general.id);
    expect(h.runnerModule.transcriptReads).toEqual([
      {
        path: '/tmp/fictional.jsonl',
        opts: { provider: 'claude', self: 'cr', cwd: session.cwd, firstUserOrigin: 'brief' },
      },
      {
        path: '/tmp/general.jsonl',
        opts: { provider: 'claude', self: 'cr', cwd: general.cwd, firstUserOrigin: 'human' },
      },
    ]);
  });

  it('starts over with the brief when the first start never produced a conversation', async () => {
    h.runner.failNextStart = new Error('spawn failed');
    const err = await h.domain.sessions.ensureSession('AR', 'cr', task).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('session_start_failed');
    const failed = h.domain.sessions.list('AR', { member: 'cr' })[0]!;
    expect(failed.state).toBe('failed');

    const retry = await h.domain.sessions.ensureSession('AR', 'cr', task);
    expect(retry.session.id).toBe(failed.id);
    expect(h.runner.lastStarted()).toMatchObject({
      resume: false,
      initialMessage: 'Brief for AR-1: Login page',
    });
  });

  it('mirrors runner events into sessions, member state, chat and terminal events', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.setState(session.id, 'working', 'Bash: npm test');
    expect(h.domain.sessions.get('AR', session.id)).toMatchObject({
      state: 'working',
      activity: 'Bash: npm test',
    });
    let roster = await h.domain.members.roster('AR');
    expect(roster.find((m) => m.handle === 'cr')).toMatchObject({
      status: 'working',
      activity: 'Bash: npm test',
      currentTaskKeys: ['AR-1'],
    });

    h.runner.setState(session.id, 'waiting_permission', 'Bash: rm -rf dist');
    roster = await h.domain.members.roster('AR');
    expect(roster.find((m) => m.handle === 'cr')?.status).toBe('waiting_for_human');

    h.runner.emit({
      type: 'chat',
      sessionId: session.id,
      items: [{ id: 'c1', ts: '2026-09-29T10:00:00.000Z', kind: 'assistant_text', text: 'Done' }],
    });
    h.runner.emit({ type: 'terminal_data', sessionId: session.id, data: '\u001b[32mok' });
    h.runner.setState(session.id, 'idle');

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'chat_appended', projectKey: 'AR', sessionId: session.id }),
    );
    expect(events).toContainEqual({ type: 'terminal_data', sessionId: session.id, data: '\u001b[32mok' });
    expect(events).toContainEqual({
      type: 'member_state',
      projectKey: 'AR',
      handle: 'cr',
      status: 'working',
      activity: 'Bash: npm test',
    });
    expect(events.filter((e) => e.type === 'session_upserted').length).toBeGreaterThanOrEqual(4);
    expect(h.repos.memberState.get('AR', 'cr')?.status).toBe('idle');
  });

  it('delivers human messages into the session and records them as team messages', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    const message = await h.domain.sessions.sendHumanMessage(
      'AR',
      session.id,
      'Please check the tests',
      'owner',
    );
    await new Promise((r) => setImmediate(r));
    expect(h.runner.messages).toEqual([{ sessionId: session.id, text: 'Please check the tests' }]);
    expect(message).toMatchObject({ from: 'owner', to: ['cr'], taskKey: 'AR-1' });
    expect(h.repos.messages.get(message.id)?.deliveredAt).not.toBeNull();

    // A stopped session is resumed for the message.
    await h.domain.sessions.stop('AR', session.id);
    expect(h.domain.sessions.get('AR', session.id).state).toBe('exited');
    await h.domain.sessions.sendHumanMessage('AR', session.id, 'Are you there?', 'owner');
    expect(h.runner.started).toHaveLength(2);
  });

  it('stops the sessions of a retired member and hands its tasks over', async () => {
    const started = await h.domain.scheduler.startTask('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    expect(started.task.assignee).toBe('dev-1');
    await h.domain.members.retire(
      'AR',
      'dev-1',
      { handoverTo: 'dev-2' },
      { actor: OWNER_ACTOR, author: OWNER },
    );
    expect(h.runner.isRunning(started.session!.id)).toBe(false);
    expect(h.domain.tasks.get('AR', 'AR-1').assignee).toBe('dev-2');
    const config = await h.domain.projects.config('AR');
    expect(config.team.members.map((m) => m.handle)).not.toContain('dev-1');
    expect(config.pipeline.stages.find((s) => s.id === 'development')?.owners).toEqual(['dev-2']);
    const roster = await h.domain.members.roster('AR');
    expect(roster.map((m) => m.handle)).not.toContain('dev-1');
    expect(h.repos.memberState.get('AR', 'dev-1')?.status).toBe('retired');
  });

  it.each([
    [{ handoverTo: 'dev-2' }, { assignee: 'dev-2', previous: 'dev-1', reason: 'handover', from: 'dev-1' }],
    [{}, { assignee: null, previous: 'dev-1', reason: 'member_removed' }],
  ])('records the hand-over of a retired member’s task once (%j)', async (opts, assigned) => {
    await h.domain.scheduler.startTask('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
    const before = h.domain.timeline.list('AR', { taskKey: 'AR-1' }).length;
    events.length = 0;
    await h.domain.members.retire('AR', 'dev-1', opts, { actor: OWNER_ACTOR, author: OWNER });
    const recorded = h.domain.timeline.list('AR', { taskKey: 'AR-1' }).slice(before);
    expect(recorded.filter((e) => e.type === 'task_assigned').map((e) => e.data)).toEqual([assigned]);
    const pushed = events.filter((e) => e.type === 'task_upserted' && e.task.key === 'AR-1');
    expect(pushed.map((e) => e.type === 'task_upserted' && e.task.assignee)).toEqual([assigned.assignee]);
  });

  it('runs reviewers in the workspace with read-only tools, developers in the task worktree', async () => {
    const withRepo = await h.domain.tasks.create('AR', { title: 'With repo', repo: 'web' }, OWNER_ACTOR);
    const review = await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: withRepo.key });
    expect(review.session).toMatchObject({ cwd: h.workspace, branch: null });
    expect(h.runner.lastStarted().allowedTools).toEqual(allowedToolsFor('code_review', testConfig()));
    expect(h.runner.lastStarted().additionalDirectories).toBeUndefined();
    expect(h.worktrees.calls).toEqual([]);

    const dev = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: withRepo.key });
    expect(dev.session.branch).toBe('task/AR-2');
    expect(dev.session.cwd).not.toBe(h.workspace);
    expect(h.runner.lastStarted().allowedTools).toEqual(allowedToolsFor('developer', testConfig()));
    expect(h.runner.lastStarted().writableRoots).toEqual([`${h.workspace}/.git`]);
    expect(h.runner.lastStarted().deniedTools).toEqual([]);
    expect(h.domain.tasks.get('AR', withRepo.key).links).toContainEqual({
      kind: 'branch',
      ref: 'task/AR-2',
      repo: 'acme/web',
    });
  });

  it('grants reviewers the existing developer worktree and propagates local-only deny rules', async () => {
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      delete draft.project.repos[0]!.github;
      return 'Use a local-only repository';
    });
    const withRepo = await h.domain.tasks.create('AR', { title: 'Example change', repo: 'web' }, OWNER_ACTOR);
    const item = { type: 'task' as const, taskKey: withRepo.key };
    const developer = await h.domain.sessions.ensureSession('AR', 'dev-1', item);
    expect(h.runner.lastStarted().deniedTools).toEqual(LOCAL_ONLY_DENIED_TOOLS);
    await h.domain.sessions.ensureSession('AR', 'cr', item);
    expect(h.runner.lastStarted()).toMatchObject({
      additionalDirectories: [developer.session.cwd],
      deniedTools: LOCAL_ONLY_DENIED_TOOLS,
    });
    expect(h.runner.lastStarted().writableRoots).toBeUndefined();
    expect(h.worktrees.calls).toHaveLength(1);
  });

  it('logs worktree lookup failures and starts the reviewer anyway', async () => {
    h.worktrees.find = async () => {
      throw new Error('Example lookup failure');
    };
    const withRepo = await h.domain.tasks.create('AR', { title: 'Example change', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: withRepo.key });
    expect(h.runner.lastStarted().additionalDirectories).toBeUndefined();
    expect(h.log.warnings).toHaveLength(1);
  });

  it('applies the session policy of the new roles and of custom roles', async () => {
    const withRepo = await h.domain.tasks.create('AR', { title: 'With repo', repo: 'web' }, OWNER_ACTOR);
    const item = { type: 'task' as const, taskKey: withRepo.key };
    const hireBy = { actor: OWNER_ACTOR, author: OWNER, sponsor: 'owner' };
    await h.domain.members.hire('AR', { role: 'maintainer' }, hireBy);
    await h.domain.members.hire('AR', { role: 'architect' }, hireBy);
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.team.roles.push({
        id: 'data_steward',
        name: 'Data steward',
        summary: 'Keeps data clean.',
        notTheirJob: '',
        holders: 'ai',
        instructions: '',
      });
      return 'Add a custom role';
    });
    await h.domain.members.hire('AR', { role: 'data_steward' }, hireBy);

    const maintainer = await h.domain.sessions.ensureSession('AR', 'maintainer', item);
    expect(maintainer.session.branch).toBe(`task/${withRepo.key}`);
    expect(h.runner.lastStarted()).toMatchObject({
      allowedTools: allowedToolsFor('maintainer', testConfig()),
      permissionMode: 'acceptEdits',
    });

    const architect = await h.domain.sessions.ensureSession('AR', 'architect', item);
    expect(architect.session).toMatchObject({ cwd: h.workspace, branch: null });
    expect(h.runner.lastStarted().allowedTools).toContain('Bash(gh pr diff:*)');

    const steward = await h.domain.sessions.ensureSession('AR', 'data-steward', item);
    expect(steward.session).toMatchObject({ cwd: h.workspace, branch: null });
    expect(h.runner.lastStarted()).toMatchObject({
      allowedTools: ['mcp__team__*'],
      permissionMode: 'default',
    });
  });

  it('marks live sessions as exited after a restart', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', task);
    h.runner.setState(session.id, 'working');
    await h.runner.shutdown();
    h.repos.sessions.update(session.id, { state: 'working' }); // simulate a crash: the row still says working
    h.domain.sessions.reconcileAfterRestart();
    expect(h.domain.sessions.get('AR', session.id).state).toBe('exited');
  });
});
