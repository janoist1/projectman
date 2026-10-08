import { messageRoute } from '@projectman/shared';
import type { Session, WorkItemRef } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * Where a message goes (PM-182): a member has no second session on the same subject because
 * its parent card and a subtask both write to them, and a closed card's message goes to the
 * recipient's general chat instead of waiting forever.
 *
 * Cards: AR-1 is the parent of the subtasks AR-2 and AR-3 (siblings), AR-4 stands alone and is
 * closed (cancelled) where a test says so, AR-5 is another subtask of AR-1.
 */
const task = (taskKey: string): WorkItemRef => ({ type: 'task', taskKey });
const general: WorkItemRef = { type: 'general' };

describe('routing a message to a running session of the same family', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
    const parent = await h.domain.tasks.create('AR', { title: 'Parent' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Child', parentKey: parent.key }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Sibling', parentKey: parent.key }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Alone' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Other child', parentKey: parent.key }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  const run = async (member: string, workItem: WorkItemRef): Promise<Session> =>
    (await h.domain.sessions.ensureSession('AR', member, workItem)).session;
  const send = async (taskKey: string | null, to = 'dev-2', text = 'Fictional news.') => {
    const message = await h.domain.messaging.send('AR', 'owner', { to: [to], text, taskKey });
    await flush();
    return h.repos.messages.get(message.id)!;
  };
  const typedInto = (session: Session) => h.runner.messages.filter((m) => m.sessionId === session.id);

  it('types a parent card message into the running session on its subtask, without a new session', async () => {
    const child = await run('dev-2', task('AR-2'));
    const started = h.runner.started.length;

    const message = await send('AR-1');

    expect(h.runner.started).toHaveLength(started);
    // The prefix names the message's own card, not the card of the session it reaches.
    expect(typedInto(child).map((m) => m.text)).toEqual([
      '[team message from owner about AR-1]\nFictional news.',
    ]);
    expect(message.receipts?.[0]).toMatchObject({ handle: 'dev-2', route: task('AR-2') });
    expect(message.receipts?.[0]?.deliveredAt).toBeTruthy();
    expect(h.repos.messages.pending('AR', 'dev-2')).toEqual([]);
  });

  it('types a subtask message into the running session on its parent card', async () => {
    const parent = await run('dev-2', task('AR-1'));
    const started = h.runner.started.length;

    const message = await send('AR-2');

    expect(h.runner.started).toHaveLength(started);
    expect(typedInto(parent).map((m) => m.text)).toEqual([
      '[team message from owner about AR-2]\nFictional news.',
    ]);
    expect(message.receipts?.[0]).toMatchObject({ route: task('AR-1') });
  });

  it('gives it to the most recently active session of the family', async () => {
    const first = await run('dev-2', task('AR-2'));
    const second = await run('dev-2', task('AR-5'));
    h.repos.sessions.update(first.id, { lastActivityAt: '2099-01-01T00:00:00.000Z' });
    await send('AR-1');
    expect(typedInto(first)).toHaveLength(1);
    expect(typedInto(second)).toEqual([]);

    h.repos.sessions.update(second.id, { lastActivityAt: '2099-02-01T00:00:00.000Z' });
    await send('AR-1', 'dev-2', 'Later news.');
    expect(typedInto(first)).toHaveLength(1);
    expect(typedInto(second)).toHaveLength(1);
  });

  it('does not count a sibling as family: the message is for its own card, not typed into the sibling', async () => {
    const sibling = await run('dev-2', task('AR-3'));

    const message = await send('AR-2');

    expect(typedInto(sibling)).toEqual([]);
    expect(message.receipts?.[0]?.route).toBeUndefined();
    // dev-2 is at capacity with the sibling, so the start on AR-2 waits (the message with it).
    expect(h.repos.messages.pending('AR', 'dev-2').map((m) => m.id)).toEqual([message.id]);
    expect(messageRoute(message, 'dev-2')).toEqual(task('AR-2'));
  });

  it('does not count a closed family card', async () => {
    await run('dev-2', task('AR-2'));
    await h.domain.tasks.cancel('AR', 'AR-2', {}, OWNER_ACTOR);
    const parent = await send('AR-1');
    // The session on the closed subtask is not the parent's: a new one starts on AR-1.
    expect(parent.receipts?.[0]?.route).toBeUndefined();
    expect(h.runner.lastStarted().initialMessage).toContain('about AR-1');
  });

  it('starts a session on the message card, as before, when no family card has one running', async () => {
    const started = h.runner.started.length;
    const message = await send('AR-1');
    expect(h.runner.started).toHaveLength(started + 1);
    expect(h.runner.lastStarted().initialMessage).toContain('[team message from owner about AR-1]');
    expect(message.receipts?.[0]?.route).toBeUndefined();
  });

  it('prefers the own running session on the card to one on a family card', async () => {
    const own = await run('dev-2', task('AR-1'));
    const child = await run('dev-2', task('AR-2'));
    await send('AR-1');
    expect(typedInto(own)).toHaveLength(1);
    expect(typedInto(child)).toEqual([]);
  });

  it('leaves it to the owner of the current stage to get it on the card', async () => {
    // Moving AR-2 to code review starts its owner, cr, on it; that session then ends.
    await h.domain.tasks.moveToStage('AR', 'AR-2', 'code_review', OWNER_ACTOR);
    await flush();
    const review = h.domain.sessions.list('AR', { member: 'cr', taskKey: 'AR-2' })[0]!;
    await h.domain.sessions.stop('AR', review.id);
    const parent = await run('cr', task('AR-1'));

    const message = await send('AR-2', 'cr');

    // cr has work on AR-2 (review), so the message is for that card and not typed into AR-1's session.
    expect(typedInto(parent)).toEqual([]);
    expect(message.receipts?.[0]?.route).toBeUndefined();
    expect(h.repos.messages.pending('AR', 'cr').map((m) => m.id)).toEqual([message.id]);
  });

  it('does not route what a human typed into a session', async () => {
    const child = await run('dev-2', task('AR-2'));
    await run('dev-2', task('AR-1'));
    const message = await h.domain.messaging.sendToSession('AR', child.id, 'Plain words.', 'owner');
    expect(messageRoute(message, 'dev-2')).toEqual(task('AR-2'));
  });
});

describe('a message about a closed card', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Parent' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Closed', parentKey: 'AR-1' }, OWNER_ACTOR);
    await h.domain.tasks.cancel('AR', 'AR-2', {}, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Open child', parentKey: 'AR-1' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  const send = async (to = 'dev-2') => {
    const message = await h.domain.messaging.send('AR', 'owner', {
      to: [to],
      text: 'Fictional late news.',
      taskKey: 'AR-2',
    });
    await flush();
    return h.repos.messages.get(message.id)!;
  };

  it('is typed into the recipient general chat when it runs', async () => {
    const chat = (await h.domain.sessions.ensureSession('AR', 'dev-2', general)).session;
    const started = h.runner.started.length;

    const message = await send();

    expect(h.runner.started).toHaveLength(started);
    expect(h.runner.messages).toEqual([
      { sessionId: chat.id, text: '[team message from owner about AR-2]\nFictional late news.' },
    ]);
    expect(message.receipts?.[0]).toMatchObject({ route: general });
    expect(message.receipts?.[0]?.deliveredAt).toBeTruthy();
  });

  it('starts the general chat with it when that does not run, and no session on the closed card', async () => {
    const message = await send();

    expect(h.runner.started).toHaveLength(1);
    expect(h.domain.sessions.list('AR', { member: 'dev-2' }).map((s) => s.workItem)).toEqual([general]);
    expect(h.runner.lastStarted().initialMessage).toContain('Fictional late news.');
    expect(message.receipts?.[0]).toMatchObject({ route: general });
    expect(h.repos.messages.pending('AR', 'dev-2')).toEqual([]);
  });

  it('goes to a session that still runs on the closed card', async () => {
    const own = (await h.domain.sessions.ensureSession('AR', 'dev-2', task('AR-2'))).session;
    const message = await send();
    expect(h.runner.messages.map((m) => m.sessionId)).toEqual([own.id]);
    expect(message.receipts?.[0]?.route).toBeUndefined();
  });

  it('delivers an unknown-version human message even after its card closed', async () => {
    // Written before routes existed: no route on its receipt, so it waits on its card.
    const old = h.domain.messages.record({
      projectKey: 'AR',
      from: 'owner',
      to: ['dev-2'],
      taskKey: 'AR-2',
      body: 'Fictional old news.',
      actor: OWNER_ACTOR,
    });
    await h.domain.messageStarts.wake('AR', 'dev-2', task('AR-2'));
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.lastStarted().initialMessage).toContain('Fictional old news.');

    // A general chat that starts later does not take it either.
    const chat = (await h.domain.sessions.ensureSession('AR', 'dev-2', general)).session;
    await flush();
    expect(h.runner.messages.filter((m) => m.sessionId === chat.id)).toEqual([]);
    expect(h.repos.messages.get(old.id)?.deliveredAt).toBeTruthy();
  });

  it('tells the sender where each recipient gets it (send_message)', async () => {
    const chat = (await h.domain.sessions.ensureSession('AR', 'dev-1', general)).session;
    const context = { projectKey: 'AR', member: 'dev-1', sessionId: chat.id, taskKey: null };
    await h.domain.sessions.ensureSession('AR', 'cr', task('AR-3'));

    const closed = await h.domain.teamTools.sendMessage(context, {
      kind: 'action',
      to: ['cr', 'dev-2'],
      text: 'News.',
      taskKey: 'AR-2',
    });
    expect(closed.routed).toEqual([
      { handle: 'cr', workItem: general },
      { handle: 'dev-2', workItem: general },
    ]);
    const family = await h.domain.teamTools.sendMessage(context, {
      kind: 'action',
      to: ['cr', 'dev-2'],
      text: 'More.',
      taskKey: 'AR-1',
    });
    // Only the recipient that does not get it on its own card is named.
    expect(family.routed).toEqual([{ handle: 'cr', workItem: task('AR-3') }]);
  });
});

describe('waiting messages of the chats that are not about a task', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Task' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  it('finds an answer routed to a schedule run for that run and for the general chat, never for a task', () => {
    const run: WorkItemRef = { type: 'schedule', runId: 'run_1' };
    const message = h.domain.messages.record({
      projectKey: 'AR',
      from: 'owner',
      to: ['dev-2'],
      taskKey: 'AR-1',
      body: 'Fictional answer.',
      actor: OWNER_ACTOR,
      routes: { 'dev-2': run },
    });
    const ids = (workItem: WorkItemRef) =>
      h.domain.messages.waiting('AR', 'dev-2', workItem).map((m) => m.id);
    expect(ids(run)).toEqual([message.id]);
    expect(ids(general)).toEqual([message.id]);
    expect(ids(task('AR-1'))).toEqual([]);
  });
});
