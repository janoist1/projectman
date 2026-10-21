import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemberQueuesView, MemberQueueView, routes, TODO_DONE_OPTION } from '@projectman/shared';
import type { InboxItem, ServerEvent } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const START = '2026-10-18T10:00:00.000Z';
const OWNER = { kind: 'human' as const, handle: 'owner' };
const step = {
  what: 'Measure the hub',
  where: 'Hub',
  expected: 'Latency report',
  recipient: 'integrator' as const,
};

/** The queue rows of slice A (PM-894): they follow the pending message receipts and the Operator's integrator items. */
describe('member queue', () => {
  let h: AppHarness;
  let now: Date;
  let cookie: string;
  let superSecret: string;
  let readSecret: string;
  let legacySecret: string;

  beforeEach(async () => {
    now = new Date(START);
    h = await createAppHarness({ now: () => now });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const { auth, repos } = h.app.projectman;
    const userId = repos.users.list()[0]!.id;
    superSecret = auth.createIntegratorAccessKey(userId, { mode: 'super', expiresInDays: 7 }).secret;
    readSecret = auth.createIntegratorAccessKey(userId, { mode: 'read', expiresInDays: 7 }).secret;
    legacySecret = (
      await h.app.inject({ method: 'POST', url: routes.integratorKey(), headers: { cookie }, payload: {} })
    ).json().secret;
  });
  afterEach(async () => h.close());

  const domain = () => h.app.projectman.domain;
  const repos = () => h.app.projectman.repos;
  const send = (to: string[], body = 'Please look at the login page.\nSecond line.', from = 'owner') =>
    domain().messages.record({
      projectKey: 'AR',
      from,
      to,
      taskKey: null,
      body,
      actor: OWNER,
      humanRecipients: to.filter((handle) => handle === 'owner'),
    });
  const view = (member: string, since?: string) =>
    domain().memberQueue.view('AR', member, since ? new Date(since) : undefined);
  const pendingRows = () =>
    (
      repos().db.prepare('SELECT message_id AS id, handle FROM team_message_pending').all() as Array<{
        id: string;
        handle: string;
      }>
    )
      .map((row) => `${row.id}:${row.handle}`)
      .sort();
  const openMessageItems = () =>
    (
      repos()
        .db.prepare(
          "SELECT source_id AS id, member FROM member_queue_items WHERE source_type = 'message' AND state IN ('queued','processing')",
        )
        .all() as Array<{ id: string; member: string }>
    )
      .map((row) => `${row.id}:${row.member}`)
      .sort();

  it('queues a message item for each AI recipient and none for a human', () => {
    const message = send(['dev-1', 'dev-2', 'owner']);
    expect(view('dev-1').items).toEqual([
      expect.objectContaining({
        kind: 'message',
        source: { type: 'message', messageId: message.id },
        state: 'queued',
        title: 'Please look at the login page.',
        from: 'owner',
        taskKey: null,
        place: { type: 'general' },
        queuedAt: message.createdAt,
        closeReason: null,
      }),
    ]);
    expect(typeof view('dev-1').items[0]!.wake).toBe('boolean');
    expect(view('dev-2').items).toHaveLength(1);
    expect(view('owner').items).toHaveLength(0);
    expect(view('dev-1').everQueued).toBe(true);
    expect(view('cr').everQueued).toBe(false);
    expect(openMessageItems()).toEqual(pendingRows());
  });

  it('closes the item as delivered when the message is delivered, and keeps the other recipient waiting', () => {
    const message = send(['dev-1', 'dev-2']);
    now = new Date(Date.parse(START) + 60_000);
    domain().messages.markRecipientDelivered(message.id, 'dev-1');
    expect(view('dev-1').items).toHaveLength(0);
    expect(view('dev-1').closed).toEqual([
      expect.objectContaining({
        state: 'done',
        closeReason: 'delivered',
        closedAt: now.toISOString(),
      }),
    ]);
    expect(view('dev-2').items).toHaveLength(1);
    expect(openMessageItems()).toEqual(pendingRows());
  });

  it('closes the item as cancelled when the pending receipt is taken away without a delivery', () => {
    const message = send(['dev-1']);
    domain().messages.markRecipientForwarded(message.id, 'dev-1', 'dev-2');
    expect(view('dev-1').items).toHaveLength(0);
    expect(view('dev-1').closed[0]).toMatchObject({ state: 'cancelled', closeReason: 'source_closed' });
    expect(openMessageItems()).toEqual(pendingRows());
  });

  it('does not queue an item twice for the same message', () => {
    const message = send(['dev-1']);
    domain().memberQueue.syncMessage(repos().messages.get(message.id)!);
    expect(view('dev-1').items).toHaveLength(1);
  });

  describe('recover', () => {
    it('fills in a missing item, closes a stale one and is idempotent', async () => {
      const missing = send(['dev-1']);
      const stale = send(['dev-2']);
      repos().db.prepare('DELETE FROM member_queue_items WHERE source_id = ?').run(missing.id);
      repos().db.prepare('DELETE FROM team_message_pending WHERE message_id = ?').run(stale.id);
      await domain().memberQueue.recover();
      expect(view('dev-1').items).toHaveLength(1);
      expect(view('dev-2').items).toHaveLength(0);
      expect(view('dev-2').closed[0]).toMatchObject({ state: 'cancelled', closeReason: 'source_closed' });
      expect(openMessageItems()).toEqual(pendingRows());
      const before = repos().db.prepare('SELECT * FROM member_queue_items ORDER BY id').all();
      await domain().memberQueue.recover();
      expect(repos().db.prepare('SELECT * FROM member_queue_items ORDER BY id').all()).toEqual(before);
    });

    it('queues an open integrator todo that has no item yet', async () => {
      const todo = await openedTodo();
      repos().db.prepare('DELETE FROM member_queue_items').run();
      await domain().memberQueue.recover();
      expect(view('operator').items).toEqual([expect.objectContaining({ kind: 'todo', title: todo.title })]);
    });
  });

  async function openedTodo(): Promise<InboxItem> {
    const item = domain().inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
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
      todo: step,
    }))!;
  }

  describe('the Operator items', () => {
    it('queues an integrator todo with a wake and closes it as resolved when the integrator answers', async () => {
      const todo = await openedTodo();
      expect(view('operator').items).toEqual([
        expect.objectContaining({
          kind: 'todo',
          source: { type: 'inbox', inboxItemId: todo.id },
          place: { type: 'general' },
          wake: true,
          from: null,
        }),
      ]);
      const response = await h.app.inject({
        method: 'POST',
        url: routes.resolveIntegratorTodo('AR', todo.id),
        headers: { authorization: `Bearer ${superSecret}` },
        payload: { optionId: TODO_DONE_OPTION.id },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(view('operator').items).toHaveLength(0);
      expect(view('operator').closed[0]).toMatchObject({ state: 'done', closeReason: 'resolved' });
    });

    it('closes the todo as cancelled when it goes to the owner after the deadline', async () => {
      const todo = await openedTodo();
      repos().inbox.updatePayload(
        todo.id,
        { ...todo.payload, recipient: 'owner', integratorEscalatedAt: START },
        START,
      );
      expect(view('operator').items).toHaveLength(0);
      expect(view('operator').closed[0]).toMatchObject({ state: 'cancelled', closeReason: 'source_closed' });
    });

    it('queues an integrator fix limit decision as a fix_limit item and closes it when the owner takes it', () => {
      const item = domain().inbox.create({
        projectKey: 'AR',
        kind: 'decision',
        source: 'system',
        taskKey: 'AR-1',
        assignees: ['owner'],
        title: 'Fix round limit',
        payload: {
          fixLimit: {
            taskKey: 'AR-1',
            rounds: 2,
            limit: 2,
            changeRequests: 2,
            designChangeRequests: 0,
            sendBacks: 0,
            reason: 'no_ai_decider',
            decider: null,
            note: null,
          },
          recipient: 'integrator',
          integratorOpenedAt: START,
        },
        options: [{ id: 'another_round', label: 'another_round', style: 'primary' }],
      });
      expect(view('operator').items).toEqual([
        expect.objectContaining({
          kind: 'fix_limit',
          taskKey: 'AR-1',
          wake: true,
          source: { type: 'inbox', inboxItemId: item.id },
        }),
      ]);
      repos().inbox.updatePayload(
        item.id,
        { ...item.payload, recipient: 'owner', integratorEscalatedAt: START },
        START,
      );
      expect(view('operator').items).toHaveLength(0);
      expect(view('operator').closed[0]).toMatchObject({ state: 'cancelled', closeReason: 'source_closed' });
    });

    it('queues nothing for an ordinary owner question', () => {
      domain().inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source: 'dev-1',
        assignees: ['owner'],
        title: 'Which colour?',
        payload: { question: 'Which colour?', recipient: 'owner' },
        options: [{ id: 'answer', label: 'Answer', style: 'primary' }],
      });
      expect(view('operator').everQueued).toBe(false);
    });
  });

  describe('events', () => {
    it('publishes one member_queue_changed for each member whose queue changed', () => {
      const events: ServerEvent[] = [];
      domain().bus.subscribe((event) => events.push(event as ServerEvent));
      send(['dev-1', 'dev-2', 'owner']);
      const changed = events.filter((event) => event.type === 'member_queue_changed');
      expect(changed).toEqual([
        { type: 'member_queue_changed', projectKey: 'AR', member: 'dev-1' },
        { type: 'member_queue_changed', projectKey: 'AR', member: 'dev-2' },
      ]);
    });
  });

  describe('API', () => {
    const get = (url: string, headers: Record<string, string> = { cookie }) => h.app.inject({ url, headers });

    it('lists every AI member in configuration order with zeros', async () => {
      send(['dev-2']);
      send(['dev-2']);
      const response = await get(routes.memberQueues('AR'));
      expect(response.statusCode, response.body).toBe(200);
      const { members } = MemberQueuesView.parse(response.json());
      const ai = (await domain().projects.config('AR')).team.members.filter((m) => m.kind === 'ai');
      expect(members.map((m) => m.member)).toEqual(ai.map((m) => m.handle));
      expect(members.find((m) => m.member === 'dev-2')).toMatchObject({
        queued: 2,
        processing: 0,
        oldestQueuedAt: START,
      });
      expect(members.find((m) => m.member === 'dev-1')).toMatchObject({
        queued: 0,
        waking: 0,
        oldestQueuedAt: null,
      });
    });

    it('shows one member’s queue and limits the closed items by closedSince', async () => {
      const first = send(['dev-1']);
      now = new Date(Date.parse(START) + 3_600_000);
      domain().messages.markRecipientDelivered(first.id, 'dev-1');
      send(['dev-1'], 'Second message');
      const later = new Date(now.getTime() + 60_000).toISOString();
      const all = MemberQueueView.parse((await get(routes.memberQueue('AR', 'dev-1'))).json());
      expect(all.items.map((i) => i.title)).toEqual(['Second message']);
      expect(all.closed).toHaveLength(1);
      const recent = MemberQueueView.parse(
        (await get(`${routes.memberQueue('AR', 'dev-1')}?closedSince=${encodeURIComponent(later)}`)).json(),
      );
      expect(recent.closed).toHaveLength(0);
      expect(recent.everQueued).toBe(true);
    });

    it('answers 404 unknown_member for a handle that is not an AI member', async () => {
      for (const handle of ['owner', 'nobody']) {
        const response = await get(routes.memberQueue('AR', handle));
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe('unknown_member');
      }
    });

    it('answers 400 invalid_request for a bad closedSince', async () => {
      const response = await get(`${routes.memberQueue('AR', 'dev-1')}?closedSince=yesterday`);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_request');
    });

    it('shows the Operator’s queue', async () => {
      await openedTodo();
      const view = MemberQueueView.parse((await get(routes.operatorQueue('AR'))).json());
      expect(view.member).toBe('operator');
      expect(view.items).toHaveLength(1);
    });

    it('refuses a client and answers a developer', async () => {
      const client = await addHumanAndLogin(h.app, { handle: 'visitor', access: 'client' });
      const developer = await addHumanAndLogin(h.app, { handle: 'coder', access: 'developer' });
      for (const url of [
        routes.memberQueues('AR'),
        routes.memberQueue('AR', 'dev-1'),
        routes.operatorQueue('AR'),
      ]) {
        expect((await get(url, { cookie: client })).statusCode, url).toBe(403);
        expect((await get(url, { cookie: developer })).statusCode, url).toBe(200);
      }
    });

    it('lets the read and super keys read and refuses the legacy key', async () => {
      for (const secret of [readSecret, superSecret]) {
        for (const url of [
          routes.memberQueues('AR'),
          routes.memberQueue('AR', 'dev-1'),
          routes.operatorQueue('AR'),
        ])
          expect((await get(url, { authorization: `Bearer ${secret}` })).statusCode, url).toBe(200);
      }
      const legacy = { authorization: `Bearer ${legacySecret}` };
      for (const url of [routes.memberQueues('AR'), routes.memberQueue('AR', 'dev-1')]) {
        const response = await get(url, legacy);
        expect(response.statusCode, url).toBe(403);
        expect(response.json().error.code).toBe('insufficient_access');
      }
      const operator = await get(routes.operatorQueue('AR'), legacy);
      expect(operator.statusCode).toBe(403);
      expect(operator.json().error.code).toBe('operator_owner_only');
    });
  });
});
