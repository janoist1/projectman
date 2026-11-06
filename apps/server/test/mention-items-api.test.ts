import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPushableItem, mentionPayloadOf, routes } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

describe('mention items in Rád vár (PM-1307)', () => {
  let h: AppHarness;
  let owner: string;
  let robin: string;
  let tick: number;
  beforeEach(async () => {
    tick = Date.now();
    // Every read of the clock moves it on, so an item is always older than the reply that closes it.
    await start();
  });
  const start = async (expectedErrors: RegExp[] = []) => {
    h = await createAppHarness({ now: () => new Date((tick += 5)), expectedErrors });
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    robin = await addHumanAndLogin(h.app, { handle: 'robin', name: 'Robin', roles: ['developer'] });
    await h.app.projectman.domain.tasks.create('AR', { title: 'Fictional checkout' }, OWNER_ACTOR);
  };
  afterEach(async () => h.close());

  const mentions = (handle?: string): InboxItem[] =>
    h.app.projectman.domain.inbox
      .list('AR', { kind: 'mention' })
      .filter((item) => !handle || item.assignees.includes(handle));
  const notes = () =>
    h.app.projectman.domain.timeline.list('AR').filter((event) => event.type === 'task_note');
  const comment = async (body: Record<string, unknown>, cookie = owner) => {
    const response = await h.app.inject({
      method: 'POST',
      url: routes.taskComments('AR', 'AR-1'),
      headers: { cookie },
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    return notes().at(-1)!.id;
  };

  it('opens one item per mentioned human in the unit of the comment, and an AI member still gets the message', async () => {
    const top = await comment({ text: '@robin @dev-1 @owner @robin please look' });
    expect(mentions()).toHaveLength(1);
    const [item] = mentions('robin');
    expect(item).toMatchObject({
      kind: 'mention',
      assignees: ['robin'],
      source: 'owner',
      taskKey: 'AR-1',
      state: 'open',
      options: [{ id: 'seen' }],
      body: '@robin @dev-1 @owner @robin please look',
    });
    expect(mentionPayloadOf(item!)).toEqual({ eventId: top, place: 'comment', threadId: top });
    await flush();
    const { messages } = h.app.projectman.domain;
    expect(messages.list('AR', { unreadFor: 'robin' })).toEqual([]);
    expect(messages.list('AR', { unreadFor: 'dev-1' })).toHaveLength(1);
    // The item sends no push of its own: the note does (PM-1271).
    expect(isPushableItem(item!, 'robin')).toBe(false);
  });

  it('opens an item for a reply with its thread, and for an AI process note without one', async () => {
    const top = await comment({ text: 'Question' });
    const reply = await comment({ text: '@robin your turn', replyTo: top });
    const { domain } = h.app.projectman;
    const { session } = await domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' });
    await domain.teamTools.updateTask(
      { projectKey: 'AR', taskKey: 'AR-1', member: 'dev-1', sessionId: session.id },
      { taskKey: 'AR-1', note: '@robin progress' },
    );
    const [first, second] = mentions('robin');
    expect(mentionPayloadOf(first!)).toEqual({ eventId: reply, place: 'reply', threadId: top });
    expect(mentionPayloadOf(second!)).toEqual({ eventId: notes().at(-1)!.id, place: 'note', threadId: null });
    expect(second).toMatchObject({ source: 'dev-1', sessionId: session.id });
  });

  it('opens nothing for an imported comment', async () => {
    await comment({ text: '@robin old', importedAuthor: 'Morgan' });
    expect(mentions()).toEqual([]);
  });

  it('closes only the replier’s own items of the same thread, in the reply’s unit', async () => {
    const t1 = await comment({ text: '@robin first' });
    const t2 = await comment({ text: '@robin second' });
    await comment({ text: 'standalone answer' }, robin);
    await comment({ text: 'not for me', replyTo: t1 });
    expect(mentions().map((item) => item.state)).toEqual(['open', 'open']);
    const answer = await comment({ text: 'on it', replyTo: t2 }, robin);
    const [one, two] = mentions();
    expect(one!.state).toBe('open');
    expect(two).toMatchObject({
      state: 'resolved',
      resolution: { optionId: 'replied', by: 'robin', rule: 'mention_replied' },
    });
    expect(two!.resolution!.at).toBe(notes().find((event) => event.id === answer)!.createdAt);
  });

  it('keeps the note and the items together when opening them fails', async () => {
    await h.close();
    await start([/request failed/]);
    const spy = vi.spyOn(h.app.projectman.domain.inbox, 'openMentions').mockImplementation(() => {
      throw new Error('boom');
    });
    const response = await h.app.inject({
      method: 'POST',
      url: routes.taskComments('AR', 'AR-1'),
      headers: { cookie: owner },
      payload: { text: '@robin hi' },
    });
    expect(response.statusCode).toBe(500);
    spy.mockRestore();
    expect(notes()).toEqual([]);
    expect(mentions()).toEqual([]);
  });

  it('a repeated clientRequestId opens no second item, closes nothing and raises the note once', async () => {
    const raised: string[] = [];
    h.app.projectman.domain.ctx.events.on('task_note_added', (note) => {
      raised.push(note.event.id);
    });
    const clientRequestId = '6f1c2d4e-8a3b-4c5d-9e7f-0a1b2c3d4e5f';
    const top = await comment({ text: '@robin one' });
    const first = await comment({ text: 'on it', replyTo: top, clientRequestId }, robin);
    await comment({ text: '@robin two', replyTo: top });
    await comment({ text: 'on it', replyTo: top, clientRequestId }, robin);
    await comment({ text: '@robin three', clientRequestId: '7a2d3e5f-9b4c-4d6e-8f0a-1b2c3d4e5f60' });
    expect(mentions().map((item) => item.state)).toEqual(['resolved', 'open', 'open']);
    expect(
      notes().filter((event) => event.data.replyTo === top && event.actor.handle === 'robin'),
    ).toHaveLength(1);
    expect(raised.filter((id) => id === first)).toHaveLength(1);
  });

  describe('seen', () => {
    const resolve = (item: InboxItem, cookie: string) =>
      h.app.inject({
        method: 'POST',
        url: routes.resolveInbox('AR', item.id),
        headers: { cookie },
        payload: { optionId: 'seen' },
      });

    it('is allowed to the assignee only, not to the owner', async () => {
      await comment({ text: '@robin look' });
      const [item] = mentions('robin');
      const refused = await resolve(item!, owner);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('not_an_assignee');
      expect((await resolve(item!, robin)).statusCode).toBe(200);
      expect(mentions('robin')[0]).toMatchObject({ state: 'resolved', resolution: { optionId: 'seen' } });
    });
  });

  describe('card and team', () => {
    it('stays out of the owners’ open items the project manager urges', async () => {
      await comment({ text: '@owner look' }, robin);
      expect(mentions('owner')).toHaveLength(1);
      const overview = await h.app.projectman.domain.projectState.overview('AR');
      expect(overview.openOwnerItems).toEqual([]);
    });

    it('survives its author’s retirement and is cancelled when its assignee leaves', async () => {
      await comment({ text: '@robin look' });
      const { inbox } = h.app.projectman.domain;
      await inbox.cancelOpenFromSource('AR', 'owner');
      expect(mentions('robin')[0]!.state).toBe('open');
      inbox.reassignRemovedHuman('AR', 'robin', ['owner']);
      expect(mentions('robin')[0]!.state).toBe('cancelled');
      expect(mentions('owner')).toEqual([]);
    });
  });
});
