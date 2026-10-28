import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CreatedIntegratorAccessKey,
  SuperOperateResponse,
  SuperOperationDetail,
  routes,
} from '@projectman/shared';
import type { SuperCommand, SuperOperation, Task, ProjectConfig } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const PAUSE: SuperCommand = { kind: 'operate', operation: { op: 'project_pause' } };

describe('super-mode operation, status and diagnostics routes (PM-764)', () => {
  let app: AppHarness;
  let cookie: string;
  let secret: string;
  let ran: number;
  beforeEach(async () => {
    app = await createAppHarness();
    cookie = await setupOwner(app.app);
    await createProject(app, cookie);
    const created = await app.app.inject({
      method: 'POST',
      url: routes.integratorKeys(),
      headers: { cookie },
      payload: { mode: 'super' },
    });
    secret = CreatedIntegratorAccessKey.parse(created.json()).secret;
    ran = 0;
    app.app.projectman.domain.superHandoffs.registerExecutor('operate', async () => {
      ran += 1;
    });
  });
  afterEach(async () => app?.close());

  const bearer = {
    get authorization() {
      return `Bearer ${secret}`;
    },
  };
  const post = (url: string, payload: unknown, headers: Record<string, string> = bearer) =>
    app.app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> });
  const get = (url: string, headers: Record<string, string> = bearer) =>
    app.app.inject({ method: 'GET', url, headers });

  it('starts an operation with the token: 202, idempotent on the request id, readable afterwards', async () => {
    const requestId = randomUUID();
    const first = await post(routes.superOperations('AR'), { requestId, command: PAUSE });
    expect(first.statusCode, first.body).toBe(202);
    const operation = SuperOperateResponse.parse(first.json()).operation;
    expect(operation).toMatchObject({ state: 'succeeded', requestId, handoffId: null });
    const again = await post(routes.superOperations('AR'), { requestId, command: PAUSE });
    expect(again.statusCode).toBe(202);
    expect(SuperOperateResponse.parse(again.json()).operation.id).toBe(operation.id);
    expect(ran).toBe(1);

    const other = await post(routes.superOperations('AR'), {
      requestId,
      command: { kind: 'operate', operation: { op: 'project_resume' } },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('super_request_conflict');

    const read = await get(routes.superOperation('AR', operation.id));
    expect(read.statusCode).toBe(200);
    expect(SuperOperationDetail.parse(read.json())).toMatchObject({
      operation: { id: operation.id, state: 'succeeded' },
      result: null,
    });
    expect((await get(routes.superOperation('AR', 'sop_missing'))).statusCode).toBe(404);
  });

  it('refuses the owner’s plain login for a start, a bad body, and anyone but an owner', async () => {
    const url = routes.superOperations('AR');
    const plain = await post(url, { requestId: randomUUID(), command: PAUSE }, { cookie });
    expect(plain.statusCode).toBe(403);
    expect(plain.json().error.code).toBe('integrator_not_allowed');
    expect((await post(url, { requestId: 'nope', command: PAUSE })).statusCode).toBe(400);
    expect(
      (await post(url, { requestId: randomUUID(), command: { kind: 'sql', text: 'x' } })).statusCode,
    ).toBe(400);
    expect((await post(url, { requestId: randomUUID(), command: PAUSE, extra: 1 })).statusCode).toBe(400);
    const admin = await addHumanAndLogin(app.app, { handle: 'ada', access: 'admin' });
    expect((await post(url, { requestId: randomUUID(), command: PAUSE }, { cookie: admin })).statusCode).toBe(
      403,
    );
    expect((await app.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    expect(ran).toBe(0);
  });

  it('refuses the administration command here as unavailable when no executor is wired (503)', async () => {
    const response = await post(routes.superOperations('AR'), {
      requestId: randomUUID(),
      command: { kind: 'administration', request: { kind: 'deploy', releaseId: 'rel_1' } },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('super_executor_unavailable');
  });
});

describe('the wired operate executor in super mode (PM-831)', () => {
  let app: AppHarness;
  let cookie: string;
  let secret: string;
  let keyPrefix: string;
  beforeEach(async () => {
    app = await createAppHarness();
    cookie = await setupOwner(app.app);
    await createProject(app, cookie);
    const created = await app.app.inject({
      method: 'POST',
      url: routes.integratorKeys(),
      headers: { cookie },
      payload: { mode: 'super' },
    });
    const key = CreatedIntegratorAccessKey.parse(created.json());
    secret = key.secret;
    keyPrefix = key.key.prefix;
  });
  afterEach(async () => app?.close());

  const submit = async (command: SuperCommand, requestId = randomUUID(), taskKey?: string) => {
    const response = await app.app.inject({
      method: 'POST',
      url: routes.superOperations('AR'),
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        requestId,
        ...(taskKey ? { taskKey } : {}),
        command,
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    return SuperOperateResponse.parse(response.json()).operation;
  };
  const operate = (operation: Extract<SuperCommand, { kind: 'operate' }>['operation'], taskKey?: string) =>
    submit({ kind: 'operate', operation }, randomUUID(), taskKey);
  const decide = async (
    operation: SuperOperation,
    optionId: 'yes' | 'no',
    headers: Record<string, string> = { cookie },
  ) => {
    const response = await app.app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', operation.ownerQuestionId!),
      headers,
      payload: { optionId },
    });
    return response;
  };
  const config = () => app.app.projectman.domain.projects.config('AR');
  const edit = async (change: (draft: ProjectConfig) => void) => {
    const draft = structuredClone(await config());
    change(draft);
    const response = await inject(app.app, 'PUT', routes.config('AR'), cookie, draft);
    expect(response.statusCode, response.body).toBe(200);
  };
  // A step made with the super key is the holder's own, with the key behind it (decision 66).
  const operator = {
    kind: 'human',
    handle: 'owner',
    via: 'integrator',
    through: { holder: 'owner' },
  } as const;

  it('sends a message as the Operator, about a card', async () => {
    const task = (
      await inject(app.app, 'POST', routes.tasks('AR'), cookie, { title: 'A card' })
    ).json<Task>();
    const operation = await operate(
      { op: 'message_send', to: ['dev-1'], text: 'Please look at this', taskKey: task.key },
      task.key,
    );
    expect(operation).toMatchObject({ state: 'succeeded', errorCode: null });
    const [message] = app.app.projectman.domain.messages.list('AR', { taskKey: task.key });
    expect(message).toMatchObject({
      from: 'owner',
      to: ['dev-1'],
      body: 'Please look at this',
      actor: { ...operator, through: { holder: 'owner', credential: { prefix: keyPrefix } } },
    });
  });

  it('fails an unknown recipient and a card the operation does not name, without sending', async () => {
    const task = (
      await inject(app.app, 'POST', routes.tasks('AR'), cookie, { title: 'A card' })
    ).json<Task>();
    expect(await operate({ op: 'message_send', to: ['nobody'], text: 'Hello' })).toMatchObject({
      state: 'failed',
      errorCode: 'not_found',
    });
    expect(
      await operate({ op: 'message_send', to: ['dev-1'], text: 'Hello', taskKey: 'AR-99' }, task.key),
    ).toMatchObject({ state: 'failed', errorCode: 'invalid_request' });
    expect(app.app.projectman.domain.messages.list('AR')).toEqual([]);
  });

  it('pauses and resumes the project as the Operator with the key’s data', async () => {
    expect(await operate({ op: 'project_pause', reason: 'Deploy preview' })).toMatchObject({
      state: 'succeeded',
    });
    expect(app.app.projectman.domain.pauses.projectView('AR').project?.reason).toBe('Deploy preview');
    expect(await operate({ op: 'project_resume' })).toMatchObject({ state: 'succeeded' });
    const events = app.app.projectman.domain.timeline
      .list('AR')
      .filter((event) => event.type === 'team_paused' || event.type === 'team_resumed');
    expect(events.map((event) => event.type).sort()).toEqual(['team_paused', 'team_resumed']);
    for (const event of events)
      expect(event.actor).toMatchObject({
        ...operator,
        through: { holder: 'owner', credential: { prefix: keyPrefix } },
      });
  });

  it('refuses to stop the Operator’s own session and an unknown one', async () => {
    const now = new Date().toISOString();
    app.app.projectman.repos.sessions.insert({
      id: 'ses_operator',
      projectKey: 'AR',
      member: 'operator',
      workItem: { type: 'general' },
      claudeSessionId: 'claude-ses_operator',
      cwd: '/tmp/work',
      branch: null,
      transcriptPath: null,
      state: 'exited',
      activity: null,
      startedAt: now,
      lastActivityAt: now,
      endedAt: now,
    });
    expect(await operate({ op: 'session_stop', sessionId: 'ses_operator' })).toMatchObject({
      state: 'failed',
      errorCode: 'operator_never',
    });
    expect(await operate({ op: 'session_stop', sessionId: 'ses_missing' })).toMatchObject({
      state: 'failed',
      errorCode: 'not_found',
    });
  });

  describe('workspace_release (PM-935)', () => {
    const scopeId = 'scp_0123456789abcdef';
    const release = (id = scopeId, reason = 'The processes are gone; checked by hand') =>
      ({ kind: 'workspace_release', scopeId: id, reason }) satisfies SuperCommand;
    /** A failed cleanup of an ended session that still holds its member's workspace. */
    async function failedCleanup() {
      const { domain, repos } = app.app.projectman;
      const task = await domain.tasks.create(
        'AR',
        { title: 'Held workspace', repo: 'web' },
        {
          kind: 'human',
          handle: 'owner',
        },
      );
      const now = new Date().toISOString();
      repos.sessions.insert({
        id: 'ses_held',
        projectKey: 'AR',
        member: 'dev-1',
        workItem: { type: 'task', taskKey: task.key },
        claudeSessionId: 'claude-ses_held',
        cwd: '/tmp/work',
        branch: null,
        transcriptPath: null,
        state: 'exited',
        activity: null,
        startedAt: now,
        lastActivityAt: now,
        endedAt: now,
      });
      repos.memberWorkspaces.insert({
        id: 'mws_held',
        projectKey: 'AR',
        member: 'dev-1',
        repo: 'web',
        path: '/tmp/work',
        generation: 1,
        createdAt: now,
      });
      repos.memberWorkspaces.hold('mws_held', {
        sessionId: 'ses_held',
        taskKey: task.key,
        pid: 4242,
        since: now,
        scopeId,
        cleanupFailed: true,
      });
      repos.sessionCleanups.failed({
        scopeId,
        sessionId: 'ses_held',
        projectKey: 'AR',
        taskKey: task.key,
        kind: 'process_group',
        survivors: 1,
        failedAt: now,
        lastAttemptAt: null,
        attempts: 0,
      });
      return task;
    }

    it('closes the record, frees the workspace and writes the timeline event', async () => {
      const { domain, repos } = app.app.projectman;
      const task = await failedCleanup();
      expect(await submit(release())).toMatchObject({ state: 'succeeded', errorCode: null });
      expect(repos.sessionCleanups.get(scopeId)).toBeNull();
      expect(repos.memberWorkspaces.heldBy('ses_held')).toEqual([]);
      expect(
        domain.timeline
          .list('AR', { taskKey: task.key })
          .find((event) => event.type === 'workspace_released'),
      ).toMatchObject({
        actor: operator,
        data: {
          scopeId,
          sessionId: 'ses_held',
          workspaceIds: ['mws_held'],
          reason: 'The processes are gone; checked by hand',
        },
      });
    });

    it('fails with not_found for a scope that has no record', async () => {
      expect(await submit(release('scp_missing'))).toMatchObject({ state: 'failed', errorCode: 'not_found' });
    });

    it('is refused for a login that is not the integrator’s key and for a member', async () => {
      const { repos } = app.app.projectman;
      await failedCleanup();
      const admin = await addHumanAndLogin(app.app, { handle: 'ada', access: 'admin' });
      for (const headers of [{ cookie }, { cookie: admin }]) {
        const response = await app.app.inject({
          method: 'POST',
          url: routes.superOperations('AR'),
          headers,
          payload: { requestId: randomUUID(), command: release() },
        });
        expect(response.statusCode).toBe(403);
      }
      expect(repos.sessionCleanups.get(scopeId)).not.toBeNull();
      expect(repos.memberWorkspaces.heldBy('ses_held')).toHaveLength(1);
    });
  });

  it('executes a config revert through the shared configuration path', async () => {
    const before = (await app.app.projectman.domain.projects.load('AR')).version;
    expect(await operate({ op: 'config_revert', version: before })).toMatchObject({
      state: 'succeeded',
      errorCode: null,
    });
    expect((await app.app.projectman.domain.projects.load('AR')).version).toBe(before);
  });

  it('creates a labeled card once, binds the result key and records the Operator', async () => {
    const command: SuperCommand = {
      kind: 'task_create',
      request: { title: 'A refined card', labels: ['refine'] },
    };
    const requestId = randomUUID();
    const [first, concurrent] = await Promise.all([submit(command, requestId), submit(command, requestId)]);
    expect(concurrent.id).toBe(first.id);
    expect(first).toMatchObject({ state: 'succeeded', taskKey: 'AR-1' });
    expect(await submit(command, requestId)).toEqual(first);
    expect(app.app.projectman.domain.tasks.list('AR')).toHaveLength(1);
    expect(app.app.projectman.domain.tasks.get('AR', first.taskKey!).labels).toContain('refine');
    const events = app.app.projectman.domain.timeline.list('AR', { taskKey: first.taskKey! });
    expect(events.find((event) => event.type === 'task_created')?.actor).toMatchObject(operator);
    expect(events.find((event) => event.type === 'super_operation_changed')?.actor).toMatchObject(operator);
    const conflict = await app.app.inject({
      method: 'POST',
      url: routes.superOperations('AR'),
      headers: { authorization: `Bearer ${secret}` },
      payload: { requestId, command: { ...command, request: { title: 'Different card' } } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('super_request_conflict');
  });

  it('updates a card and shares it without a question, with an idempotent retry', async () => {
    const created = await submit({ kind: 'task_create', request: { title: 'A card' } });
    const command: SuperCommand = {
      kind: 'task_update',
      taskKey: created.taskKey!,
      request: { title: 'Shared card' },
    };
    const requestId = randomUUID();
    const operation = await submit(command, requestId);
    expect(operation.state).toBe('succeeded');
    expect(await submit(command, requestId)).toEqual(operation);
    expect(app.app.projectman.domain.tasks.get('AR', created.taskKey!)).toMatchObject({
      title: 'Shared card',
    });
    const event = app.app.projectman.domain.timeline
      .list('AR', { taskKey: created.taskKey! })
      .find((event) => event.type === 'task_updated');
    expect(event?.actor).toMatchObject(operator);
  });

  it('clears the assignee and moves a card back in one update', async () => {
    const created = await submit({ kind: 'task_create', request: { title: 'A card' } });
    const taskKey = created.taskKey!;
    await submit({ kind: 'task_start', taskKey, request: { assignee: 'dev-1' } });
    const operation = await submit({
      kind: 'task_update',
      taskKey,
      request: { assignee: null, stageId: 'backlog' },
    });
    expect(operation.state).toBe('succeeded');
    expect(app.app.projectman.domain.tasks.get('AR', taskKey)).toMatchObject({
      assignee: null,
      stageId: 'backlog',
    });
  });

  it('moves a hand-on stage directly when the holder is not the card mover', async () => {
    await edit((draft) => {
      draft.team.members.push({
        kind: 'human',
        handle: 'ada',
        displayName: 'Ada',
        access: 'admin',
        roles: [],
        email: 'ada@example.invalid',
      });
      draft.team.cardMover = { kind: 'human', handle: 'ada' };
    });
    const created = await submit({ kind: 'task_create', request: { title: 'A card' } });
    const taskKey = created.taskKey!;
    await submit({ kind: 'task_start', taskKey, request: { assignee: 'dev-1' } });
    // The holder's own instruction is a person's move (decision 66): it needs no hand-on request.
    const operation = await submit({ kind: 'task_update', taskKey, request: { stageId: 'code_review' } });
    expect(operation).toMatchObject({ state: 'succeeded' });
    expect(app.app.projectman.domain.tasks.get('AR', taskKey).stageId).toBe('code_review');
  });

  it('sets a scope label and an approval label on the owner’s delegated authority', async () => {
    await edit((draft) =>
      draft.pipeline.labels.push({
        id: 'scope-ok',
        name: 'Scope ready',
        setBy: { members: ['owner'], humansOnly: true },
      }),
    );
    const created = await submit({ kind: 'task_create', request: { title: 'A card' } });
    const operation = await submit({
      kind: 'task_labels',
      taskKey: created.taskKey!,
      request: { add: ['scope-ok', 'merge-ok'] },
    });
    expect(operation.state).toBe('succeeded');
    expect(app.app.projectman.domain.tasks.get('AR', created.taskKey!).labels).toEqual([
      'scope-ok',
      'merge-ok',
    ]);
    const event = app.app.projectman.domain.timeline
      .list('AR', { taskKey: created.taskKey! })
      .find((event) => event.type === 'task_labels_changed');
    expect(event?.actor).toMatchObject(operator);
  });

  it('starts a card as the Operator through task admission', async () => {
    const created = await submit({ kind: 'task_create', request: { title: 'A card' } });
    expect(
      await submit({ kind: 'task_start', taskKey: created.taskKey!, request: { assignee: 'dev-1' } }),
    ).toMatchObject({ state: 'succeeded' });
    expect(app.app.projectman.domain.tasks.get('AR', created.taskKey!)).toMatchObject({
      assignee: 'dev-1',
      stageId: 'development',
    });
    const event = app.app.projectman.domain.timeline
      .list('AR', { taskKey: created.taskKey! })
      .find((event) => event.type === 'task_assigned');
    expect(event?.actor).toMatchObject(operator);
  });

  it('cancels a card as the Operator without an owner question', async () => {
    const created = await submit({ kind: 'task_create', request: { title: 'A card' } });
    expect(await submit({ kind: 'task_cancel', taskKey: created.taskKey!, request: {} })).toMatchObject({
      state: 'succeeded',
    });
    expect(app.app.projectman.domain.tasks.get('AR', created.taskKey!).status).toBe('cancelled');
    const event = app.app.projectman.domain.timeline
      .list('AR', { taskKey: created.taskKey! })
      .find((event) => event.type === 'task_updated' && event.data.action === 'cancelled');
    expect(event?.actor).toMatchObject(operator);
  });

  it('patches routine configuration immediately with super commit provenance', async () => {
    expect(
      await operate({
        op: 'config_patch',
        patch: {
          repoReviewTest: [
            { repo: 'web', reviewTest: { command: 'npm test', maxWorkers: 2, timeoutMinutes: 10 } },
          ],
        },
      }),
    ).toMatchObject({ state: 'succeeded', errorCode: null });
    expect((await config()).project.repos[0]?.reviewTest?.maxWorkers).toBe(2);
    const event = app.app.projectman.domain.timeline
      .list('AR')
      .filter((event) => event.type === 'config_changed')
      .at(-1);
    expect(event?.actor).toMatchObject(operator);
    const history = await app.app.projectman.domain.projects.history('AR', 1);
    expect(history[0]?.actor).toMatchObject(operator);
  });

  it('updates another member without an approval and hires a subscription member', async () => {
    expect(
      await submit({ kind: 'member_update', handle: 'dev-1', request: { displayName: 'Updated developer' } }),
    ).toMatchObject({ state: 'succeeded' });
    expect((await config()).team.members.find((m) => m.handle === 'dev-1')?.displayName).toBe(
      'Updated developer',
    );
    expect(
      await operate({ op: 'member_hire', request: { role: 'developer', handle: 'new-dev' } }),
    ).toMatchObject({ state: 'succeeded' });
    const event = app.app.projectman.domain.timeline
      .list('AR')
      .find((event) => event.type === 'member_hired');
    expect(event?.actor).toMatchObject(operator);
  });

  it('creates a routine invitation with the live principal’s user', async () => {
    expect(
      await submit({
        kind: 'invite_create',
        request: { email: 'invited@example.com', access: 'developer', roles: ['developer'] },
      }),
    ).toMatchObject({ state: 'succeeded' });
    const invitations = app.app.projectman.domain.invitations.list('AR');
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.invitedBy).toBe(
      app.app.projectman.repos.users.findByEmail('owner@example.com')?.id,
    );
  });

  const reserved: { name: string; command: SuperCommand; verify: (config: ProjectConfig) => void }[] = [
    {
      name: 'member retirement',
      command: { kind: 'operate', operation: { op: 'member_retire', handle: 'dev-2' } },
      verify: (config) => expect(config.team.members.some((m) => m.handle === 'dev-2')).toBe(false),
    },
    {
      name: 'human access',
      command: { kind: 'member_update', handle: 'access-target', request: { access: 'admin' } },
      verify: (config) =>
        expect(config.team.members.find((m) => m.handle === 'access-target')).toMatchObject({
          access: 'admin',
        }),
    },
    {
      name: 'paid member',
      command: {
        kind: 'operate',
        operation: {
          op: 'member_hire',
          request: { role: 'developer', provider: 'nanogpt', handle: 'paid-dev' },
        },
      },
      verify: (config) =>
        expect(config.team.members.find((m) => m.handle === 'paid-dev')).toMatchObject({
          provider: 'nanogpt',
        }),
    },
    {
      name: 'boundary role assignment',
      command: {
        kind: 'operate',
        operation: { op: 'member_update', handle: 'dev-1', changes: { role: 'lead_developer' } },
      },
      verify: (config) =>
        expect(config.team.members.find((m) => m.handle === 'dev-1')).toMatchObject({
          role: 'lead_developer',
        }),
    },
    {
      name: 'Operator model',
      command: { kind: 'member_update', handle: 'operator', request: { model: 'sonnet' } },
      verify: (config) =>
        expect(config.team.members.find((m) => m.handle === 'operator')).toMatchObject({ model: 'sonnet' }),
    },
  ];

  it.each(reserved)('waits for the owner and resumes $name once', async ({ command, verify }) => {
    if (command.kind === 'member_update' && command.handle === 'access-target')
      await addHumanAndLogin(app.app, { handle: 'access-target', access: 'developer' });
    const before = await config();
    const requestId = randomUUID();
    const waiting = await submit(command, requestId);
    expect(waiting).toMatchObject({ state: 'waiting_owner' });
    expect(await config()).toEqual(before);
    expect(await submit(command, requestId)).toEqual(waiting);
    const delegated = await decide(waiting, 'yes', { authorization: `Bearer ${secret}` });
    expect(delegated.statusCode).toBe(403);
    const decision = await decide(waiting, 'yes');
    expect(decision.statusCode, decision.body).toBe(200);
    const resumed = await submit(command, requestId);
    expect(resumed).toMatchObject({ id: waiting.id, state: 'succeeded', errorCode: null });
    verify(await config());
  });

  it('revokes another credential only after the owner’s own yes', async () => {
    const key = CreatedIntegratorAccessKey.parse(
      (await inject(app.app, 'POST', routes.integratorKeys(), cookie, { mode: 'read' })).json(),
    );
    const command: SuperCommand = { kind: 'credential_revoke', keyId: key.key.id };
    const requestId = randomUUID();
    const waiting = await submit(command, requestId);
    expect(waiting.state).toBe('waiting_owner');
    const read = () =>
      app.app.inject({
        method: 'GET',
        url: routes.tasks('AR'),
        headers: { authorization: `Bearer ${key.secret}` },
      });
    expect((await read()).statusCode).toBe(200);
    expect((await decide(waiting, 'yes')).statusCode).toBe(200);
    expect((await submit(command, requestId)).state).toBe('succeeded');
    expect((await read()).statusCode).toBe(401);
    expect((await submit(command, requestId)).state).toBe('succeeded');
  });

  it('cancels a reserved command after no and never executes it on retry', async () => {
    const command: SuperCommand = { kind: 'operate', operation: { op: 'member_retire', handle: 'dev-2' } };
    const requestId = randomUUID();
    const waiting = await submit(command, requestId);
    expect((await decide(waiting, 'no')).statusCode).toBe(200);
    expect((await submit(command, requestId)).state).toBe('cancelled');
    expect((await config()).team.members.some((m) => m.handle === 'dev-2')).toBe(true);
  });

  it('asks before a revert removes a repository and attributes the commit to the Operator', async () => {
    const target = (await app.app.projectman.domain.projects.load('AR')).version;
    await edit((draft) =>
      draft.project.repos.push({ name: 'extra', path: '.', defaultBranch: 'main', requireMerge: false }),
    );
    const command: SuperCommand = { kind: 'operate', operation: { op: 'config_revert', version: target } };
    const requestId = randomUUID();
    const waiting = await submit(command, requestId);
    expect(waiting.state).toBe('waiting_owner');
    expect((await config()).project.repos).toHaveLength(2);
    expect((await decide(waiting, 'yes')).statusCode).toBe(200);
    expect((await submit(command, requestId)).state).toBe('succeeded');
    expect((await config()).project.repos).toHaveLength(1);
    expect((await app.app.projectman.domain.projects.history('AR', 1))[0]?.actor).toMatchObject(operator);
  });

  it('refuses direct self modification outside an owner-approved operation', async () => {
    const before = (await config()).team.members.find((m) => m.handle === 'operator');
    const response = await app.app.inject({
      method: 'PATCH',
      url: routes.member('AR', 'operator'),
      headers: { authorization: `Bearer ${secret}` },
      payload: { model: 'sonnet' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('owner_approval_required');
    expect((await config()).team.members.find((m) => m.handle === 'operator')).toEqual(before);
  });

  it('waits for a boundary duty config patch instead of failing in the executor', async () => {
    const command: SuperCommand = {
      kind: 'operate',
      operation: {
        op: 'config_patch',
        patch: {
          roleOverrides: {
            developer: { duties: ['implementation', 'boundary_authorization'], instructions: '' },
          },
        },
      },
    };
    const requestId = randomUUID();
    const waiting = await submit(command, requestId);
    expect(waiting.state).toBe('waiting_owner');
    expect((await decide(waiting, 'yes')).statusCode).toBe(200);
    expect((await submit(command, requestId)).state).toBe('succeeded');
    expect((await config()).team.roleOverrides?.developer?.duties).toContain('boundary_authorization');
  });

  it.each<SuperCommand>([
    { kind: 'member_update', handle: 'operator', request: { instructions: 'Rewrite myself' } },
    {
      kind: 'operate',
      operation: {
        op: 'config_patch',
        patch: {
          roleOverrides: { ai_operator: { duties: ['project_operation'], instructions: 'Rewrite my role' } },
        },
      },
    },
    { kind: 'operate', operation: { op: 'member_retire', handle: 'operator' } },
    {
      kind: 'operate',
      operation: { op: 'member_hire', request: { role: 'ai_operator', handle: 'another-operator' } },
    },
  ])('refuses a fixed Operator change before creating an owner question: %j', async (command) => {
    const before = await config();
    const questions = app.app.projectman.repos.inbox.listOpen('question').length;
    const response = await app.app.inject({
      method: 'POST',
      url: routes.superOperations('AR'),
      headers: { authorization: `Bearer ${secret}` },
      payload: { requestId: randomUUID(), command },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe('operator_fixed');
    expect(app.app.projectman.repos.inbox.listOpen('question')).toHaveLength(questions);
    expect(await config()).toEqual(before);
  });
});
