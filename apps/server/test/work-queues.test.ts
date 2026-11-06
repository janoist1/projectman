import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemberQueueView, WorkQueueDetail, WorkQueuesView, routes } from '@projectman/shared';
import type { HumanAccess, InboxItem, ServerEvent, WorkQueueGroup } from '@projectman/shared';
import { canSeeProjectEvent } from '../src/core/projects';
import type { ProjectEvent } from '../src/core/projects';
import { resolveIntegratorTodo } from '../src/services/super-operator';
import {
  addHumanAndLogin,
  asSuperIntegrator,
  createAppHarness,
  createForeignProject,
  createProject,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const START = '2026-11-06T10:00:00.000Z';
const OWNER = { kind: 'human' as const, handle: 'owner' };

/** The work queues (PM-1294): what each role reads of them, and that a hidden item leaves no trace. */
describe('work queues', () => {
  let h: AppHarness;
  let cookie: string;
  let userId: string;
  const cookies: Record<string, string> = {};

  beforeEach(async () => {
    h = await createAppHarness({ now: () => new Date(START) });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    userId = h.app.projectman.repos.users.list()[0]!.id;
    cookies.admin = await addHumanAndLogin(h.app, { handle: 'ada', access: 'admin' });
    cookies.developer = await addHumanAndLogin(h.app, { handle: 'coder', access: 'developer' });
    cookies.client = await addHumanAndLogin(h.app, { handle: 'visitor', access: 'client' });
    cookies.viewer = await addHumanAndLogin(h.app, { handle: 'reader', access: 'viewer' });
  });
  afterEach(async () => h.close());

  const domain = () => h.app.projectman.domain;
  const auth = () => h.app.projectman.auth;
  const get = (url: string, as = 'owner') =>
    h.app.inject({ url, headers: { cookie: as === 'owner' ? cookie : cookies[as]! } });
  const send = (from: string, to: string[], body = 'Please look at the login page.') =>
    domain().messages.record({
      projectKey: 'AR',
      from,
      to,
      taskKey: null,
      body,
      actor: from === 'owner' ? OWNER : { kind: 'human', handle: from },
      humanRecipients: to.filter((handle) => ['owner', 'coder'].includes(handle)),
    });
  const groupOf = (view: WorkQueuesView, member: string): WorkQueueGroup =>
    view.groups.find((g) => g.queue.type === 'member' && g.queue.member === member)!;
  const readView = async (as = 'owner') =>
    WorkQueuesView.parse((await get(routes.workQueues('AR'), as)).json());

  describe('who reads which queue', () => {
    it('gives the owner every queue, the integrator’s with its items', async () => {
      send('owner', ['pm']);
      const view = await readView();
      expect(view.scope).toBe('all');
      expect(view.groups.at(-1)).toMatchObject({ queue: { type: 'integrator' }, restricted: false });
      expect(groupOf(view, 'pm')).toMatchObject({ queued: 1, processing: 0, everQueued: true });
    });

    it('gives the admin every queue but the integrator’s items and counts', async () => {
      send('owner', ['pm']);
      const view = await readView('admin');
      expect(view.scope).toBe('all');
      expect(groupOf(view, 'pm').queued).toBe(1);
      expect(view.groups.at(-1)).toMatchObject({
        queue: { type: 'integrator' },
        restricted: true,
        items: [],
        queued: null,
        processing: null,
        everQueued: false,
      });
    });

    it('gives a developer the project manager’s queue alone', async () => {
      const view = await readView('developer');
      expect(view.scope).toBe('project_manager');
      expect(view.groups.map((g) => g.queue)).toEqual([{ type: 'member', member: 'pm' }]);
    });

    it.each(['client', 'viewer'])('refuses a %s with work_queues_forbidden', async (access) => {
      for (const url of [
        routes.workQueues('AR'),
        routes.workQueueMember('AR', 'pm'),
        routes.workQueueIntegrator('AR'),
      ]) {
        const response = await get(url, access);
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('work_queues_forbidden');
      }
    });

    it('keeps a developer out of every other member’s queue and the integrator’s', async () => {
      expect((await get(routes.workQueueMember('AR', 'pm'), 'developer')).statusCode).toBe(200);
      for (const url of [routes.workQueueMember('AR', 'dev-1'), routes.workQueueIntegrator('AR')])
        expect((await get(url, 'developer')).statusCode).toBe(403);
    });

    it('answers 404 unknown_member for a handle that is no AI member', async () => {
      const response = await get(routes.workQueueMember('AR', 'nobody'));
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('unknown_member');
    });

    it('reads nothing of a project the person is no member of', async () => {
      await createForeignProject(h, cookie, 'BR');
      const response = await get(routes.workQueues('BR'));
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('not_a_member');
    });

    it('gives the admin the integrator’s detail restricted, with no closed items', async () => {
      const detail = WorkQueueDetail.parse((await get(routes.workQueueIntegrator('AR'), 'admin')).json());
      expect(detail).toMatchObject({ restricted: true, items: [], closed: [], queued: null });
    });
  });

  describe('a hidden item', () => {
    it('is absent from the developer’s list, counts and everQueued', async () => {
      send('owner', ['pm'], 'Private to the owner');
      const hidden = groupOf(await readView('developer'), 'pm');
      expect(hidden).toMatchObject({ items: [], queued: 0, processing: 0, everQueued: false });
      send('coder', ['pm'], 'The developer’s own message');
      const shown = groupOf(await readView('developer'), 'pm');
      expect(shown.queued).toBe(1);
      expect(shown.items.map((item) => item.title)).toEqual(['The developer’s own message']);
      // The owner reads both.
      expect(groupOf(await readView(), 'pm').queued).toBe(2);
    });

    it('leaves no trace in everQueued once it is closed either', async () => {
      const message = send('owner', ['pm']);
      domain().messages.markRecipientDelivered(message.id, 'pm');
      expect(groupOf(await readView('developer'), 'pm').everQueued).toBe(false);
      expect(groupOf(await readView(), 'pm').everQueued).toBe(true);
    });

    it('is hidden from the detail’s closed items too', async () => {
      const hidden = send('owner', ['pm']);
      const own = send('coder', ['pm']);
      for (const message of [hidden, own]) domain().messages.markRecipientDelivered(message.id, 'pm');
      const detail = WorkQueueDetail.parse(
        (await get(routes.workQueueMember('AR', 'pm'), 'developer')).json(),
      );
      expect(detail.closed.map((item) => item.source)).toEqual([{ type: 'message', messageId: own.id }]);
    });

    it('is filtered the same way on the project manager’s old queue route', async () => {
      send('owner', ['pm']);
      const url = routes.projectManagerQueue('AR');
      const none = MemberQueueView.parse((await get(url, 'developer')).json());
      expect(none).toMatchObject({ items: [], closed: [], everQueued: false });
      const own = send('coder', ['pm']);
      const some = MemberQueueView.parse((await get(url, 'developer')).json());
      expect(some.items.map((item) => item.source)).toEqual([{ type: 'message', messageId: own.id }]);
      expect(MemberQueueView.parse((await get(url)).json()).items).toHaveLength(2);
    });
  });

  describe('the integrator queue', () => {
    const openTodo = async (): Promise<InboxItem> => {
      const item = domain().inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source: 'pm',
        assignees: ['owner'],
        title: 'Measure the hub',
        payload: {
          question: 'Measure the hub',
          requestedRecipient: 'owner',
          recipient: 'owner',
          screening: { until: START },
        },
        state: 'screening',
        options: [{ id: 'answer', label: 'Answer', style: 'primary' }],
      });
      return (await domain().inbox.releaseScreened(item.id, {
        outcome: 'todo',
        by: 'pm',
        note: 'External technical work',
        todo: { what: 'Measure the hub', where: 'Hub', expected: 'Latency report', recipient: 'integrator' },
      }))!;
    };

    it('lists the open todo for the owner, and its resolution as closed history', async () => {
      const todo = await openTodo();
      const open = WorkQueueDetail.parse((await get(routes.workQueueIntegrator('AR'))).json());
      expect(open).toMatchObject({ queued: 1, processing: 0, everQueued: true, connections: [] });
      expect(open.items[0]).toMatchObject({ id: todo.id, kind: 'todo', reason: 'human', reasonCode: null });
      const secret = auth().createIntegratorAccessKey(userId, { mode: 'super', expiresInDays: 7 }).secret;
      await asSuperIntegrator(h, secret, (access) =>
        resolveIntegratorTodo(domain(), 'AR', todo.id, { optionId: 'todo_done' }, access),
      );
      const closed = WorkQueueDetail.parse((await get(routes.workQueueIntegrator('AR'))).json());
      expect(closed).toMatchObject({ queued: 0, items: [] });
      expect(closed.closed[0]).toMatchObject({ id: todo.id, state: 'done', closeReason: 'resolved' });
    });

    it('shows the live connection to the owner and the admin, and waits for its next session', async () => {
      const todo = await openTodo();
      const key = auth().createIntegratorAccessKey(userId, { mode: 'super', expiresInDays: 7 });
      const owner = WorkQueueDetail.parse((await get(routes.workQueueIntegrator('AR'))).json());
      const admin = WorkQueueDetail.parse((await get(routes.workQueueIntegrator('AR'), 'admin')).json());
      expect(owner.items.find((item) => item.id === todo.id)?.reason).toBe('next_session');
      expect(owner.connections).toEqual([
        expect.objectContaining({ owner: 'owner', connectionId: key.key.id, lastUsedAt: null }),
      ]);
      expect(admin.connections).toEqual(owner.connections);
      // The token and its prefix never leave the server.
      expect(JSON.stringify(owner)).not.toContain(key.secret);
      expect(JSON.stringify(owner)).not.toContain(key.secret.slice(0, 12));
    });
  });

  describe('live updates', () => {
    const events = (): ServerEvent[] => {
      const seen: ServerEvent[] = [];
      domain().bus.subscribe((event) => seen.push(event as ServerEvent));
      return seen;
    };

    it('tells that the connections changed when a key is created and when it is revoked', () => {
      const seen = events();
      const key = auth().createIntegratorAccessKey(userId, { mode: 'super', expiresInDays: 7 });
      auth().revokeIntegratorAccessKey(userId, key.key.id);
      expect(seen.filter((event) => event.type === 'integrator_connections_changed')).toEqual([
        { type: 'integrator_connections_changed', projectKey: 'AR' },
        { type: 'integrator_connections_changed', projectKey: 'AR' },
      ]);
    });

    it.each<[HumanAccess, boolean, boolean]>([
      ['owner', true, true],
      ['admin', true, true],
      ['developer', false, true],
      ['client', false, false],
      ['viewer', false, false],
    ])(
      'tells a %s of the integrator connections: %s; of the manager’s queue: %s',
      (access, connections, managerQueue) => {
        const viewer = { handle: access, access };
        const isPm = (handle: string) => handle === 'pm';
        const queueEvent = (member: string): ProjectEvent => ({
          type: 'member_queue_changed',
          projectKey: 'AR',
          member,
        });
        expect(canSeeProjectEvent(viewer, { type: 'integrator_connections_changed', projectKey: 'AR' })).toBe(
          connections,
        );
        expect(canSeeProjectEvent(viewer, queueEvent('pm'), undefined, isPm)).toBe(managerQueue);
        // No other member’s queue reaches a developer, and without the manager check nobody below `all`.
        expect(canSeeProjectEvent(viewer, queueEvent('dev-1'), undefined, isPm)).toBe(connections);
        expect(canSeeProjectEvent(viewer, queueEvent('pm'))).toBe(connections);
      },
    );
  });

  describe('the project manager’s corner', () => {
    it.each<[HumanAccess]>([['owner'], ['developer']])(
      'counts for a %s what the work queues view counts for them',
      async (access) => {
        send('owner', ['pm']);
        send('coder', ['pm']);
        send('owner', ['dev-1']);
        const handle = access === 'owner' ? 'owner' : 'coder';
        const viewer = { handle, access };
        const group = groupOf(await domain().workQueues.view('AR', viewer), 'pm');
        const corner = await domain().projectManagerChannels.view('AR', viewer);
        expect(corner.queue.open).toBe((group.queued ?? 0) + (group.processing ?? 0));
        expect(corner.queue.open).toBe(access === 'owner' ? 2 : 1);
      },
    );
  });
});
