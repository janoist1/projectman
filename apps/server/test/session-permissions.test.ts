import { afterEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig, Session, TaskDetail } from '@projectman/shared';
import { APPROVER_NONE_REFUSAL } from '../src/contracts';
import { humanActor } from '../src/domain';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/** Delegation on, and the reviewer `cr` holds the boundary authorization duty: an AI decider. */
function withDecider(config: ProjectConfig) {
  config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
  config.team.roles.push({
    id: 'custom_lead',
    name: 'Custom lead',
    summary: 'Authorize external operations',
    duties: ['boundary_authorization', 'code_review'],
    holders: 'both',
    instructions: '',
    notTheirJob: '',
  });
  const cr = config.team.members.find((m) => m.handle === 'cr')!;
  if (cr.kind === 'ai') cr.role = 'custom_lead';
}

describe('the permission settings of one session (PM-170)', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const task = { type: 'task', taskKey: 'AR-1' } as const;

  /** dev-1 runs AR-1 in Auto with a person deciding; its conversation exists (a transcript). */
  async function running(adjust?: (config: ProjectConfig) => void) {
    h = await createDomainHarness({
      adjust: (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev?.kind === 'ai') dev.permissionMode = 'auto';
        adjust?.(config);
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fake/transcript.jsonl' });
    return session.id;
  }

  const set = (
    sessionId: string,
    body: Parameters<DomainHarness['domain']['sessions']['updatePermissions']>[2],
  ) => h.domain.sessions.updatePermissions('AR', sessionId, body, OWNER_ACTOR);
  const member = async (): Promise<AiMemberConfig> => {
    const found = (await h.domain.projects.config('AR')).team.members.find((m) => m.handle === 'dev-1');
    if (found?.kind !== 'ai') throw new Error('no dev-1');
    return found;
  };
  const changes = () =>
    h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.type === 'session_permission_changed');
  const ask = (sessionId: string, command: string) =>
    h.runnerModule
      .broker()
      .decide({ sessionId, toolName: 'Bash', toolInput: { command }, raw: {} }, new AbortController().signal);

  it('restarts a session in a turn into the new mode at its next idle moment, with its conversation', async () => {
    const sessionId = await running();
    h.runner.setState(sessionId, 'working');
    const updated = await set(sessionId, { permissionMode: 'plan' });
    expect(updated).toMatchObject({ permissionModeOverride: 'plan', permissionRestartPending: true });
    // Nothing is cut off mid-turn.
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.stopped).toEqual([]);

    h.runner.setState(sessionId, 'idle');
    await flush();
    expect(h.runner.stopped).toEqual([sessionId]);
    expect(h.runner.started).toHaveLength(2);
    const restarted = h.runner.lastStarted();
    expect(restarted).toMatchObject({
      sessionId,
      resume: true,
      claudeSessionId: h.runner.started[0]!.claudeSessionId,
      permissionMode: 'plan',
      // It was idle: it waits at its prompt again instead of being told to carry on.
      initialMessage: null,
    });
    expect(restarted.policy?.permissions.claude).toBe('plan');
    const session = h.domain.sessions.get('AR', sessionId);
    expect(session.permissionRestartPending).toBeUndefined();
    expect(session.permissionGrantsLost).toBeUndefined();
    // The member keeps its own mode.
    expect((await member()).permissionMode).toBe('auto');
    expect(changes()).toMatchObject([
      {
        sessionId,
        actor: { kind: 'human', handle: 'owner' },
        data: { member: 'dev-1', field: 'mode', from: 'auto', to: 'plan', restart: true },
      },
    ]);
  });

  it('restarts an idle session at once, but not while a message is on its way into it', async () => {
    const sessionId = await running();
    h.runner.setState(sessionId, 'idle');
    h.runner.pendingInput.add(sessionId);
    await set(sessionId, { permissionMode: 'acceptEdits' });
    expect(h.runner.started).toHaveLength(1);
    expect(h.domain.sessions.get('AR', sessionId).permissionRestartPending).toBe(true);

    h.runner.pendingInput.delete(sessionId);
    h.runner.setState(sessionId, 'working');
    h.runner.setState(sessionId, 'idle');
    await flush();
    expect(h.runner.started).toHaveLength(2);
    expect(h.runner.lastStarted()).toMatchObject({ resume: true, permissionMode: 'acceptEdits' });

    // Already idle with nothing waiting: the change takes effect before the answer.
    h.runner.setState(sessionId, 'idle');
    await set(sessionId, { permissionMode: 'default' });
    expect(h.runner.started).toHaveLength(3);
    expect(h.runner.lastStarted()).toMatchObject({ resume: true, permissionMode: 'default' });
  });

  it('does not restart a session while the team is paused, and does at once after the resume (PM-219)', async () => {
    const sessionId = await running();
    h.runner.setState(sessionId, 'idle');
    h.runner.pauseOutcomes.set(sessionId, { point: 'idle', tool: null });
    const by = { userId: null, source: 'system' } as const;
    await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, by);
    await flush();

    await set(sessionId, { permissionMode: 'plan' });
    h.runner.setState(sessionId, 'working');
    h.runner.setState(sessionId, 'idle');
    await flush();
    expect(h.runner.stopped).toEqual([]);
    expect(h.runner.started).toHaveLength(1);
    expect(h.domain.sessions.get('AR', sessionId).permissionRestartPending).toBe(true);

    await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, by);
    await flush();
    expect(h.runner.stopped).toEqual([sessionId]);
    expect(h.runner.started).toHaveLength(2);
    expect(h.runner.lastStarted()).toMatchObject({ sessionId, resume: true, permissionMode: 'plan' });
  });

  it('holds messages for a session that waits for its restart, and types them in after it', async () => {
    const sessionId = await running();
    h.runner.setState(sessionId, 'working');
    await set(sessionId, { permissionMode: 'plan' });
    await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Team note', taskKey: 'AR-1' });
    await h.domain.messaging.sendToSession('AR', sessionId, 'Direct note', 'owner');
    await flush();
    expect(h.runner.messages).toEqual([]);

    h.runner.setState(sessionId, 'idle');
    await flush();
    expect(h.runner.started).toHaveLength(2);
    // A team message keeps its prefix; what a person wrote into the session is typed as written.
    expect(h.runner.messages.map((m) => m.text)).toEqual([
      expect.stringMatching(/^\[team message from owner about AR-1\].*Team note/s),
      'Direct note',
    ]);
  });

  it('does not restart when the mode goes back to the one the process runs in, and lets messages in', async () => {
    const sessionId = await running();
    h.runner.setState(sessionId, 'working');
    await set(sessionId, { permissionMode: 'plan' });
    await h.domain.messaging.sendToSession('AR', sessionId, 'Direct note', 'owner');
    await flush();
    expect(h.runner.messages).toEqual([]);
    const back = await set(sessionId, { permissionMode: null });
    expect(back.permissionModeOverride).toBeUndefined();
    expect(back.permissionRestartPending).toBeUndefined();
    await flush();
    expect(h.runner.messages.map((m) => m.text)).toEqual(['Direct note']);
    h.runner.setState(sessionId, 'idle');
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(changes().map((e) => e.data)).toEqual([
      { member: 'dev-1', field: 'mode', from: 'auto', to: 'plan', restart: true },
      { member: 'dev-1', field: 'mode', from: 'plan', to: 'auto', reset: true },
    ]);
  });

  it('gives up a restart AI work cannot make now, and lets the held messages in', async () => {
    const sessionId = await running();
    h.runner.setState(sessionId, 'working');
    await set(sessionId, { permissionMode: 'plan' });
    await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Team note', taskKey: 'AR-1' });
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.team.limits.aiEnabled = false;
      return 'Switch AI work off';
    });
    h.runner.setState(sessionId, 'idle');
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(h.domain.sessions.get('AR', sessionId).permissionRestartPending).toBeUndefined();
    expect(h.runner.messages.map((m) => m.text)).toEqual([expect.stringContaining('Team note')]);
    // The next start takes the new mode.
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.team.limits.aiEnabled = true;
      return 'Switch AI work on';
    });
    await h.domain.sessions.stop('AR', sessionId);
    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    expect(h.runner.lastStarted()).toMatchObject({ resume: true, permissionMode: 'plan' });
  });

  it('routes a question by the session’s own approver to the AI decider, or to a person', async () => {
    const sessionId = await running(withDecider);
    await set(sessionId, { approver: 'ai' });
    void ask(sessionId, 'curl https://example.com/data.json');
    await flush();
    const [delegated] = h.domain.inbox.list('AR', { kind: 'permission', state: 'open' });
    expect(delegated).toMatchObject({
      assignees: ['cr'],
      payload: { delegation: { state: 'pending_lead' } },
    });
    h.cleanup();

    // The member asks the AI decider; this session asks a person.
    const other = await running((config) => {
      withDecider(config);
      const dev = config.team.members.find((m) => m.handle === 'dev-1');
      if (dev?.kind === 'ai') dev.approver = 'ai';
    });
    await set(other, { approver: 'human' });
    void ask(other, 'curl https://example.com/data.json');
    await flush();
    const [personal] = h.domain.inbox.list('AR', { kind: 'permission', state: 'open' });
    expect(personal!.assignees).toEqual(['owner']);
    expect(personal!.payload).not.toHaveProperty('delegation');
  });

  it('says when the restart dropped what was allowed for the session', async () => {
    const sessionId = await running();
    h.runner.setState(sessionId, 'working');
    const pending = ask(sessionId, 'rm -rf dist');
    await flush();
    const [item] = h.domain.inbox.list('AR', { kind: 'permission', state: 'open' });
    await h.domain.inbox.resolve(
      'AR',
      item!.id,
      { optionId: 'allow_session' },
      { handle: 'owner', access: 'owner' },
    );
    expect(await pending).toEqual({ behavior: 'allow', rememberForSession: true });

    h.runner.setState(sessionId, 'idle');
    await set(sessionId, { permissionMode: 'plan' });
    expect(h.runner.started).toHaveLength(2);
    expect(h.domain.sessions.get('AR', sessionId).permissionGrantsLost).toBe(true);

    // The next restart had nothing to drop.
    h.runner.setState(sessionId, 'idle');
    await set(sessionId, { permissionMode: 'auto' });
    expect(h.domain.sessions.get('AR', sessionId).permissionGrantsLost).toBeUndefined();
  });

  it('applies a new approver to the next question at once, without a restart', async () => {
    const sessionId = await running();
    h.runner.setState(sessionId, 'working');
    const updated = await set(sessionId, { approver: 'none' });
    expect(updated).toMatchObject({ approverOverride: 'none' });
    expect(updated.permissionRestartPending).toBeUndefined();
    expect(h.runner.started).toHaveLength(1);
    expect(await ask(sessionId, 'curl https://example.com')).toEqual({
      behavior: 'deny',
      message: APPROVER_NONE_REFUSAL,
    });
    expect(h.domain.inbox.list('AR', {})).toEqual([]);
    expect((await member()).approver).toBeUndefined();

    await set(sessionId, { approver: null });
    void ask(sessionId, 'curl https://example.com');
    await flush();
    expect(h.domain.inbox.list('AR', { kind: 'permission', state: 'open' })).toHaveLength(1);
    expect(changes().map((e) => e.data)).toEqual([
      { member: 'dev-1', field: 'approver', from: 'human', to: 'none' },
      { member: 'dev-1', field: 'approver', from: 'none', to: 'human', reset: true },
    ]);
  });

  it('keeps the settings when the session resumes; a new session starts with the member’s', async () => {
    const sessionId = await running();
    await set(sessionId, { permissionMode: 'plan', approver: 'none' });
    await h.domain.sessions.stop('AR', sessionId);
    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    expect(h.runner.lastStarted()).toMatchObject({ sessionId, resume: true, permissionMode: 'plan' });
    expect(h.contextBuilder.inputs.at(-1)!.member).toMatchObject({
      permissionMode: 'plan',
      approver: 'none',
    });
    expect(h.domain.sessions.get('AR', sessionId)).toMatchObject({
      permissionModeOverride: 'plan',
      approverOverride: 'none',
    });

    const chat = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    expect(chat.session.permissionModeOverride).toBeUndefined();
    expect(h.runner.lastStarted()).toMatchObject({ sessionId: chat.session.id, permissionMode: 'auto' });
    expect(h.contextBuilder.inputs.at(-1)!.member).toMatchObject({
      permissionMode: 'auto',
      approver: 'human',
    });
  });

  it('records the setting of a stopped session for its next start, without starting it', async () => {
    const sessionId = await running();
    await h.domain.sessions.stop('AR', sessionId);
    const updated = await set(sessionId, { permissionMode: 'acceptEdits' });
    expect(updated.permissionRestartPending).toBeUndefined();
    expect(h.runner.started).toHaveLength(1);
    expect(changes().map((e) => e.data)).toEqual([
      { member: 'dev-1', field: 'mode', from: 'auto', to: 'acceptEdits' },
    ]);
  });

  it('offers the AI approver only with a live AI decider, as for the member', async () => {
    const sessionId = await running();
    await expect(set(sessionId, { approver: 'ai' })).rejects.toMatchObject({
      code: 'approver_unavailable',
      status: 422,
      details: { blocker: 'delegation_off' },
    });
    expect(h.domain.sessions.get('AR', sessionId).approverOverride).toBeUndefined();
    h.cleanup();

    const withAi = await running(withDecider);
    expect(await set(withAi, { approver: 'ai' })).toMatchObject({ approverOverride: 'ai' });
  });
});

describe('PATCH a session (PM-170)', () => {
  let h: AppHarness;
  afterEach(async () => h?.close());

  async function setup() {
    h = await createAppHarness();
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    await h.app.projectman.domain.tasks.create('AR', { title: 'Acme checkout' }, humanActor('owner'));
    const started = await inject(h.app, 'POST', routes.startTask('AR', 'AR-1'), cookie, {
      assignee: 'dev-1',
    });
    const session = started.json<TaskDetail>().sessions[0]!;
    const patch = (payload: object, auth: string = cookie) =>
      inject(h.app, 'PATCH', routes.session('AR', session.id), auth, payload);
    return { cookie, session, patch };
  }

  it('lets an owner set and reset the session’s own settings', async () => {
    const { patch } = await setup();
    const set = await patch({ permissionMode: 'plan', approver: 'none' });
    expect(set.statusCode).toBe(200);
    expect(set.json<Session>()).toMatchObject({ permissionModeOverride: 'plan', approverOverride: 'none' });
    const reset = await patch({ permissionMode: null, approver: null });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<Session>()).not.toHaveProperty('permissionModeOverride');
    expect(reset.json<Session>()).not.toHaveProperty('approverOverride');
  });

  it('refuses everyone who is not an owner', async () => {
    const { patch, session } = await setup();
    for (const access of ['admin', 'developer', 'viewer'] as const) {
      const auth = await addHumanAndLogin(h.app, { handle: `${access}-human`, access });
      const refused = await patch({ permissionMode: 'plan' }, auth);
      expect([refused.statusCode, refused.json().error.code], access).toEqual([403, 'insufficient_access']);
    }
    expect(h.app.projectman.domain.sessions.get('AR', session.id).permissionModeOverride).toBeUndefined();
  });

  it('refuses the "everything allowed" mode and an empty or unknown change', async () => {
    const { patch } = await setup();
    for (const body of [{ permissionMode: 'bypassPermissions' }, {}, { model: 'x' }, { approver: 'robot' }]) {
      const refused = await patch(body);
      expect([refused.statusCode, refused.json().error.code], JSON.stringify(body)).toEqual([
        400,
        'invalid_request',
      ]);
    }
  });
});
