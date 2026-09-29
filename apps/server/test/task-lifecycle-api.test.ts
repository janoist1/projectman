import { hash } from '@node-rs/argon2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancelTaskRequest, ReopenTaskRequest, routes, UpdateTaskRequest } from '@projectman/shared';
import type { Task, TaskDetail } from '@projectman/shared';
import { cookieOf, createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';

describe('task lifecycle API', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    await h.app.projectman.domain.tasks.create('AR', { title: 'Acme webshop checkout' }, OWNER_ACTOR);
  });
  afterEach(async () => h.close());

  const call = (method: 'POST' | 'PATCH', url: string, payload?: object, auth: string | null = cookie) =>
    h.app.inject({ method, url, headers: auth ? { cookie: auth } : {}, ...(payload ? { payload } : {}) });

  it('exports additive lifecycle schemas and routes', () => {
    expect(CancelTaskRequest.parse({})).toEqual({});
    expect(CancelTaskRequest.parse({ reason: 'Scope changed' })).toEqual({ reason: 'Scope changed' });
    expect(ReopenTaskRequest.parse({})).toEqual({});
    expect(UpdateTaskRequest.parse({ assignee: null })).toEqual({ assignee: null });
    expect(UpdateTaskRequest.parse({ assignee: 'dev-2' })).toEqual({ assignee: 'dev-2' });
    expect(routes.cancelTask('AR', 'AR-1')).toBe('/api/projects/AR/tasks/AR-1/cancel');
    expect(routes.reopenTask('AR', 'AR-1')).toBe('/api/projects/AR/tasks/AR-1/reopen');
  });

  it('cancels a live task and reopens without a body or automatic start', async () => {
    const started = await call('POST', routes.startTask('AR', 'AR-1'), { assignee: 'dev-1' });
    expect(started.statusCode).toBe(200);
    const session = started.json<TaskDetail>().sessions[0]!;
    const cancelled = await call('POST', routes.cancelTask('AR', 'AR-1'), { reason: 'Scope changed' });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<Task>()).toMatchObject({
      status: 'cancelled',
      assignee: 'dev-1',
      closedAt: expect.any(String),
    });
    expect(h.runner.isRunning(session.id)).toBe(false);
    const reopened = await call('POST', routes.reopenTask('AR', 'AR-1'));
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json<Task>()).toMatchObject({
      status: 'active',
      closedAt: null,
      assignee: null,
      stageId: 'development',
    });
    expect(h.runner.started).toHaveLength(1);
  });

  it('assigns, preserves omitted assignment and clears it with null', async () => {
    const assigned = await call('PATCH', routes.task('AR', 'AR-1'), { assignee: 'dev-2' });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json<Task>().assignee).toBe('dev-2');
    const edited = await call('PATCH', routes.task('AR', 'AR-1'), { title: 'Acme checkout' });
    expect(edited.json<Task>().assignee).toBe('dev-2');
    const cleared = await call('PATCH', routes.task('AR', 'AR-1'), { assignee: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<Task>().assignee).toBeNull();
    expect(h.runner.started).toEqual([]);
  });

  it('returns all lifecycle conflict and membership errors without changing the task', async () => {
    const notCancelled = await call('POST', routes.reopenTask('AR', 'AR-1'));
    expect([notCancelled.statusCode, notCancelled.json().error.code]).toEqual([409, 'task_not_cancelled']);
    const unknown = await call('PATCH', routes.task('AR', 'AR-1'), { assignee: 'absent', title: 'Changed' });
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([400, 'unknown_member']);
    const started = (
      await call('POST', routes.startTask('AR', 'AR-1'), { assignee: 'dev-1' })
    ).json<TaskDetail>();
    const live = await call('PATCH', routes.task('AR', 'AR-1'), { assignee: null, title: 'Changed' });
    expect([live.statusCode, live.json().error.code, live.json().error.details]).toEqual([
      409,
      'task_session_live',
      { sessionId: started.sessions[0]!.id },
    ]);
    expect(h.app.projectman.domain.tasks.get('AR', 'AR-1').title).toBe('Acme webshop checkout');
    expect((await call('POST', routes.cancelTask('AR', 'AR-1'))).statusCode).toBe(200);
    const closed = await call('POST', routes.cancelTask('AR', 'AR-1'));
    expect([closed.statusCode, closed.json().error.code]).toEqual([409, 'task_closed']);
  });

  it.each([
    ['POST', routes.cancelTask('AR', 'AR-1'), { reason: 123 }],
    ['POST', routes.reopenTask('AR', 'AR-1'), []],
    ['PATCH', routes.task('AR', 'AR-1'), { assignee: 123 }],
    ['PATCH', routes.task('AR', 'AR-1'), { assignee: '' }],
  ] as const)('rejects malformed %s %s bodies', async (method, url, payload) => {
    const response = await call(method, url, payload);
    expect([response.statusCode, response.json().error.code]).toEqual([400, 'invalid_request']);
  });

  it.each(['cancel', 'reopen', 'reassign'] as const)(
    'requires login and project membership for %s',
    async (operation) => {
      const method = operation === 'reassign' ? 'PATCH' : 'POST';
      const url =
        operation === 'reassign'
          ? routes.task('AR', 'AR-1')
          : operation === 'cancel'
            ? routes.cancelTask('AR', 'AR-1')
            : routes.reopenTask('AR', 'AR-1');
      const payload = operation === 'reassign' ? { assignee: null } : {};
      const anonymous = await call(method, url, payload, null);
      expect([anonymous.statusCode, anonymous.json().error.code]).toEqual([401, 'unauthorized']);
      await h.app.projectman.domain.projects.update(
        'AR',
        { actor: OWNER_ACTOR, author: OWNER_LOGIN },
        (draft) => {
          const owner = draft.team.members.find((m) => m.handle === 'owner');
          if (owner?.kind === 'human') owner.email = 'bence@example.com';
          return 'Link owner to Bence';
        },
      );
      const nonMember = await call(method, url, payload);
      expect([nonMember.statusCode, nonMember.json().error.code]).toEqual([403, 'not_a_member']);
    },
  );

  it.each(['viewer', 'client', 'developer', 'admin'] as const)(
    'checks %s access for all lifecycle actions',
    async (access) => {
      const { domain, repos } = h.app.projectman;
      repos.users.insert({
        id: 'usr_kata',
        name: 'Kata',
        email: 'kata@example.com',
        passwordHash: await hash('another password'),
        createdAt: new Date().toISOString(),
      });
      await domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER_LOGIN }, (draft) => {
        draft.team.members.push({
          kind: 'human',
          handle: 'kata',
          displayName: 'Kata',
          email: 'kata@example.com',
          roles: [],
          access,
        });
        return 'Add Kata';
      });
      const login = await h.app.inject({
        method: 'POST',
        url: routes.login(),
        payload: { email: 'kata@example.com', password: 'another password' },
      });
      const kataCookie = cookieOf(login);
      const assigned = await call(
        'PATCH',
        routes.task('AR', 'AR-1'),
        { assignee: 'dev-2', title: 'Changed' },
        kataCookie,
      );
      expect(assigned.statusCode).toBe(access === 'admin' ? 200 : 403);
      if (access === 'developer') {
        expect(
          (await call('PATCH', routes.task('AR', 'AR-1'), { title: 'Acme checkout' }, kataCookie)).statusCode,
        ).toBe(200);
      }
      const cancelled = await call('POST', routes.cancelTask('AR', 'AR-1'), {}, kataCookie);
      expect(cancelled.statusCode).toBe(access === 'admin' ? 200 : 403);
      if (access !== 'admin') {
        expect(assigned.json().error.code).toBe('insufficient_access');
        expect(cancelled.json().error.code).toBe('insufficient_access');
        await domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
      }
      const reopened = await call('POST', routes.reopenTask('AR', 'AR-1'), {}, kataCookie);
      expect(reopened.statusCode).toBe(access === 'admin' ? 200 : 403);
      if (access !== 'admin') expect(reopened.json().error.code).toBe('insufficient_access');
    },
  );

  it.each(['cancel', 'reopen', 'reassign'] as const)(
    'returns 404 for a missing task on %s',
    async (operation) => {
      const response =
        operation === 'cancel'
          ? await call('POST', routes.cancelTask('AR', 'AR-999'))
          : operation === 'reopen'
            ? await call('POST', routes.reopenTask('AR', 'AR-999'))
            : await call('PATCH', routes.task('AR', 'AR-999'), { assignee: null });
      expect(response.statusCode).toBe(404);
    },
  );
});
