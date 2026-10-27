import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MEMBER_QUEUE_CLOSED_LIMIT,
  MEMBER_QUEUE_ITEM_KINDS,
  memberQueueUrgency,
  MemberQueueView,
  pendingRecipientsOf,
  routes,
} from '@projectman/shared';
import type { InboxItem, ServerEvent } from '@projectman/shared';
import { resolveIntegratorTodo } from '../src/services/super-operator';
import {
  addHumanAndLogin,
  createAppHarness,
  createProject,
  setupOwner,
  asSuperIntegrator,
} from './helpers/app-harness';
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

  beforeEach(async () => {
    now = new Date(START);
    h = await createAppHarness({ now: () => now });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const { auth, repos } = h.app.projectman;
    const userId = repos.users.list()[0]!.id;
    superSecret = auth.createIntegratorAccessKey(userId, { mode: 'super', expiresInDays: 7 }).secret;
    readSecret = auth.createIntegratorAccessKey(userId, { mode: 'read', expiresInDays: 7 }).secret;
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
  /** The AI recipients every message is still pending for, from the receipts. */
  const pendingRows = () =>
    repos()
      .messages.list('AR', { limit: 1000 })
      .flatMap((message) =>
        pendingRecipientsOf(message)
          .filter((handle) => handle !== 'owner')
          .map((handle) => `${message.id}:${handle}`),
      )
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

  it('orders the open items in SQL as memberQueueUrgency does, then by queue time', () => {
    for (const kind of [...MEMBER_QUEUE_ITEM_KINDS].reverse())
      repos().memberQueue.insert({
        id: `mqi_${kind}`,
        projectKey: 'AR',
        member: 'dev-1',
        kind,
        source: { type: 'message', id: `msg_${kind}` },
        place: { type: 'general' },
        taskKey: null,
        wake: true,
        title: kind,
        from: null,
        queuedAt: START,
      });
    const expected = [...MEMBER_QUEUE_ITEM_KINDS]
      .reverse()
      .sort((a, b) => memberQueueUrgency(a) - memberQueueUrgency(b));
    expect(
      repos()
        .memberQueue.listOpenByUrgency('AR', 'dev-1')
        .map((item) => item.kind),
    ).toEqual(expected);
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
      // The message was delivered behind the queue's back: its receipts say nobody is left.
      repos()
        .db.prepare("UPDATE team_messages SET delivered_at = ?, receipts = '[]' WHERE id = ?")
        .run(START, stale.id);
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
      // The project manager has machine access by role (decision 66); a developer does not.
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
      await asSuperIntegrator(h, superSecret, (access) =>
        resolveIntegratorTodo(domain(), 'AR', todo.id, { optionId: 'todo_done' }, access),
      );
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

    it('shows the Operator’s queue and limits the closed items by closedSince', async () => {
      await openedTodo();
      const view = MemberQueueView.parse((await get(routes.operatorQueue('AR'))).json());
      expect(view.member).toBe('operator');
      expect(view.items).toHaveLength(1);
      const later = new Date(Date.parse(START) + 3_600_000).toISOString();
      const recent = MemberQueueView.parse(
        (await get(`${routes.operatorQueue('AR')}?closedSince=${encodeURIComponent(later)}`)).json(),
      );
      expect(recent.closed).toHaveLength(0);
      expect(recent.everQueued).toBe(true);
    });

    it('answers 400 invalid_request for a bad closedSince', async () => {
      const response = await get(`${routes.operatorQueue('AR')}?closedSince=yesterday`);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_request');
    });

    it('refuses a client and answers a developer', async () => {
      const client = await addHumanAndLogin(h.app, { handle: 'visitor', access: 'client' });
      const developer = await addHumanAndLogin(h.app, { handle: 'coder', access: 'developer' });
      const url = routes.operatorQueue('AR');
      expect((await get(url, { cookie: client })).statusCode).toBe(403);
      expect((await get(url, { cookie: developer })).statusCode).toBe(200);
    });

    it('lets the read and super keys read', async () => {
      for (const secret of [readSecret, superSecret])
        expect(
          (await get(routes.operatorQueue('AR'), { authorization: `Bearer ${secret}` })).statusCode,
        ).toBe(200);
    });

    it('lists at most MEMBER_QUEUE_CLOSED_LIMIT closed items by the service, the newest first', () => {
      const ids: string[] = [];
      for (let i = 0; i <= MEMBER_QUEUE_CLOSED_LIMIT; i++) {
        now = new Date(Date.parse(START) + i * 1000);
        const message = send(['dev-1'], `Message ${i}`);
        domain().messages.markRecipientDelivered(message.id, 'dev-1');
        ids.push(message.id);
      }
      const view = domain().memberQueue.view('AR', 'dev-1');
      expect(view.closed).toHaveLength(MEMBER_QUEUE_CLOSED_LIMIT);
      expect(view.closed[0]!.source).toEqual({ type: 'message', messageId: ids.at(-1) });
    });
  });
});
