import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_REQUEST_OPEN_LIMIT, routes } from '@projectman/shared';
import type { HostRequestListResponse, HostRequestView } from '@projectman/shared';
import { humanActor } from '../src/kernel';
import {
  createAppHarness,
  createForeignProject,
  createProject,
  inject,
  OWNER_LOGIN,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

/**
 * The requests the project manager of another owner's project opens to the instance host (PM-1064): the
 * service's rules, then the host's side over REST with a login and with a super key.
 */
describe('requests to the host', () => {
  let h: AppHarness;
  let host: string;
  const ask = (title = 'Need a right', projectKey = 'BR', handle = 'pm', extra: { taskKey?: string } = {}) =>
    h.app.projectman.domain.hostRequests.open(projectKey, handle, {
      title,
      body: 'Please grant it.',
      ...extra,
    });
  const errorOf = async (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { code: string; status: number }) => ({ code: error.code, status: error.status }),
    );
  const hostKey = (mode: 'super' | 'read') => {
    const { auth, repos } = h.app.projectman;
    const user = repos.users.list()[0]!;
    return {
      authorization: `Bearer ${auth.createIntegratorAccessKey(user.id, { mode, expiresInDays: 7 }).secret}`,
    };
  };
  const timelineTypes = () => h.app.projectman.repos.timeline.list('BR').map((event) => event.type);

  beforeEach(async () => {
    h = await createAppHarness();
    host = await setupOwner(h.app);
    await createProject(h, host, 'AR');
    await createForeignProject(h, host, 'BR');
    // The template's project manager is on leave; a request needs the selected, available one.
    for (const key of ['AR', 'BR'])
      await h.app.projectman.domain.projects.update(
        key,
        { actor: humanActor('owner'), author: OWNER_LOGIN },
        (draft) => {
          for (const member of draft.team.members)
            if (member.kind === 'ai' && member.handle === 'pm') member.onLeave = false;
          return 'Put the project manager on duty';
        },
      );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  describe('opening one', () => {
    it('stores it, writes the timeline event and tells the host once', async () => {
      const notify = vi.spyOn(h.app.projectman.domain.webPush, 'notifyHost').mockResolvedValue();
      const opened = await ask();
      expect(opened).toEqual({ id: expect.any(String), state: 'open' });
      expect(h.app.projectman.repos.hostRequests.get(opened.id)).toMatchObject({
        projectKey: 'BR',
        openedBy: 'pm',
        state: 'open',
      });
      expect(timelineTypes()).toContain('host_request_opened');
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('is refused to a member who is not the project manager', async () => {
      expect(await errorOf(ask('x', 'BR', 'dev-1'))).toEqual({ code: 'project_manager_only', status: 403 });
    });

    it('is refused in a project the host is an owner of', async () => {
      expect(await errorOf(ask('x', 'AR'))).toEqual({ code: 'host_request_not_needed', status: 409 });
    });

    it('is refused for a card that is not in the project', async () => {
      expect(await errorOf(ask('x', 'BR', 'pm', { taskKey: 'BR-99' }))).toMatchObject({ code: 'not_found' });
    });

    it('stops at the open limit, and a closed request frees a place', async () => {
      const opened = [];
      for (let i = 0; i < HOST_REQUEST_OPEN_LIMIT; i += 1) opened.push(await ask(`Request ${i}`));
      expect(await errorOf(ask('One too many'))).toEqual({ code: 'host_request_limit', status: 409 });
      await h.app.projectman.domain.hostRequests.withdraw('BR', 'pm', opened[0]!.id);
      expect(await ask('Fits now')).toMatchObject({ state: 'open' });
    });
  });

  describe('withdrawing one', () => {
    it('closes it and writes the timeline event', async () => {
      const { id } = await ask();
      expect(await h.app.projectman.domain.hostRequests.withdraw('BR', 'pm', id)).toEqual({
        id,
        state: 'withdrawn',
      });
      expect(timelineTypes()).toContain('host_request_withdrawn');
    });

    it('is refused for a closed request', async () => {
      const { id } = await ask();
      await h.app.projectman.domain.hostRequests.withdraw('BR', 'pm', id);
      expect(await errorOf(h.app.projectman.domain.hostRequests.withdraw('BR', 'pm', id))).toMatchObject({
        code: 'host_request_closed',
      });
    });

    it('does not see another project’s request', async () => {
      const { id } = await ask();
      expect(await errorOf(h.app.projectman.domain.hostRequests.withdraw('AR', 'pm', id))).toMatchObject({
        code: 'not_found',
      });
    });
  });

  describe('the host’s side over REST', () => {
    const list = async (headers: Record<string, string>) =>
      (await h.app.inject({ url: routes.hostRequests(), headers })).json<HostRequestListResponse>();
    const answer = (headers: Record<string, string>, id: string, body: unknown) =>
      h.app.inject({ method: 'POST', url: routes.answerHostRequest(id), headers, payload: body as object });

    it('lists the requests with their project and owners, and without any card', async () => {
      await ask('Need a right', 'BR', 'pm', {});
      const { requests } = await list({ cookie: host });
      expect(requests).toEqual([
        expect.objectContaining({ projectKey: 'BR', openedBy: 'pm', title: 'Need a right', state: 'open' }),
      ]);
      expect(requests[0]).not.toHaveProperty('taskKey');
      expect(requests[0]!.owners.length).toBeGreaterThan(0);
    });

    it('answers it as the host: the manager gets a system message, the owners an alert, the timeline an event', async () => {
      const { id } = await ask();
      const res = await answer({ cookie: host }, id, { outcome: 'answered', answer: 'Done.' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<HostRequestView>()).toMatchObject({
        state: 'answered',
        answer: 'Done.',
        answeredVia: 'web',
      });
      const { repos, domain } = h.app.projectman;
      expect(repos.messages.list('BR').find((m) => m.from === 'system')).toMatchObject({ to: ['pm'] });
      expect(domain.inbox.list('BR', { kind: 'alert' })).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ alert: 'host_request_answered' }) }),
      ]);
      expect(timelineTypes()).toContain('host_request_answered');
    });

    it('refuses a second answer', async () => {
      const { id } = await ask();
      await answer({ cookie: host }, id, { outcome: 'declined', answer: 'No.' });
      const again = await answer({ cookie: host }, id, { outcome: 'answered', answer: 'Yes.' });
      expect([again.statusCode, again.json().error.code]).toEqual([409, 'host_request_closed']);
    });

    it('refuses an invalid answer body', async () => {
      const { id } = await ask();
      expect((await answer({ cookie: host }, id, { outcome: 'answered', answer: '' })).statusCode).toBe(400);
    });

    it('answers with the host’s super key even though the project belongs to another owner', async () => {
      const { id } = await ask();
      const res = await answer(hostKey('super'), id, { outcome: 'answered', answer: 'Via the key.' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<HostRequestView>()).toMatchObject({ state: 'answered', answeredVia: 'super' });
      expect(timelineTypes()).toContain('host_request_answered');
      expect(h.app.projectman.repos.messages.list('BR').some((m) => m.from === 'system')).toBe(true);
    });

    it('lets a read key list but not answer', async () => {
      const { id } = await ask();
      expect((await list(hostKey('read'))).requests).toHaveLength(1);
      const res = await answer(hostKey('read'), id, { outcome: 'answered', answer: 'x' });
      expect([res.statusCode, res.json().error.code]).toEqual([403, 'integrator_read_only']);
    });

    it('is the host’s alone: an owner account gets host_only', async () => {
      const { id } = await ask();
      const { repos } = h.app.projectman;
      repos.users.insert({
        id: 'usr_other',
        name: 'Other',
        email: 'other@example.test',
        passwordHash: repos.users.list()[0]!.passwordHash,
        createdAt: new Date().toISOString(),
        language: 'hu',
      });
      const login = await inject(h.app, 'POST', '/api/auth/login', null, {
        email: 'other@example.test',
        password: 'correct horse battery',
      });
      const cookie = login.headers['set-cookie'] as string;
      const res = await answer({ cookie: cookie.split(';')[0]! }, id, { outcome: 'answered', answer: 'x' });
      expect([res.statusCode, res.json().error.code]).toEqual([403, 'host_only']);
    });
  });
});
