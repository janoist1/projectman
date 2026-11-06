import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes, TASK_COMMENT_MAX, TaskDetail } from '@projectman/shared';
import {
  addHumanAndLogin,
  createAppHarness,
  createProject,
  OWNER_LOGIN,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

describe('task comments API', () => {
  let h: AppHarness;
  let owner: string;
  let developer: string;
  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    developer = await addHumanAndLogin(h.app, { handle: 'robin', name: 'Robin', roles: ['developer'] });
    await h.app.projectman.domain.tasks.create('AR', { title: 'Fictional checkout' }, OWNER_ACTOR);
  });
  afterEach(async () => h.close());
  const comment = (body: unknown, cookie = owner, taskKey = 'AR-1') =>
    h.app.inject({
      method: 'POST',
      url: routes.taskComments('AR', taskKey),
      headers: { cookie },
      payload: body as object,
    });

  it('records trimmed comments, canonical handles and unread human notifications', async () => {
    const text = '@ROBIN @robin @DEV-1 @owner x@cr.test word@cr @missing';
    const response = await comment({ text: `  ${text}  ` });
    expect(response.statusCode).toBe(201);
    const event = TaskDetail.parse(response.json()).timeline.find((event) => event.type === 'task_note')!;
    expect(event).toMatchObject({ actor: OWNER_ACTOR, data: { text, mentions: ['robin', 'dev-1'] } });
    const messages = h.app.projectman.domain.messages.list('AR', { unreadFor: 'robin' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      from: 'owner',
      taskKey: 'AR-1',
      body: text,
      receipts: expect.arrayContaining([
        expect.objectContaining({ handle: 'robin', kind: 'human', readAt: null }),
      ]),
    });
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    await flush();
    expect(h.runner.lastStarted().initialMessage).toContain('[team message from owner about AR-1]');
    expect(h.runner.lastStarted().initialMessage).toContain(text);
    // The mention of a comment tells the reader how to answer it (PM-1290).
    expect(h.runner.lastStarted().initialMessage).toContain('reply_to');
    expect(h.runner.messages).toEqual([]);
  });

  it('admits AI mentions and leaves refused work queued', async () => {
    h.runnerModule.planUsage.value = {
      fiveHourPercent: 99,
      weeklyPercent: null,
      fiveHourResetsAt: null,
      weeklyResetsAt: null,
      fetchedAt: new Date().toISOString(),
    };
    expect((await comment({ text: '@cr please review' }, developer)).statusCode).toBe(201);
    await flush();
    expect(h.runner.started).toHaveLength(0);
    expect(h.app.projectman.repos.messages.pending('AR', 'cr')).toHaveLength(1);
  });

  it('AI update_task notes notify humans and AI with the AI author', async () => {
    const { domain } = h.app.projectman;
    const { session } = await domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' });
    const text = '@OWNER @cr @dev-1 please review';
    await domain.teamTools.updateTask(
      { projectKey: 'AR', taskKey: 'AR-1', member: 'dev-1', sessionId: session.id },
      { taskKey: 'AR-1', note: text },
    );
    await flush();
    expect(domain.messages.list('AR', { unreadFor: 'owner' })[0]).toMatchObject({
      from: 'dev-1',
      to: ['owner', 'cr'],
      body: text,
    });
    expect(domain.timeline.list('AR').find((event) => event.type === 'task_note')).toMatchObject({
      actor: { kind: 'ai', handle: 'dev-1' },
      sessionId: session.id,
      data: { mentions: ['owner', 'cr'] },
    });
    // The reviewer starts for it and takes the whole message in its first input.
    expect(h.runner.started.find((spec) => spec.member === 'cr')?.initialMessage).toContain(text);
    // An AI's process note is no comment: its mention carries no reply instruction.
    expect(h.runner.started.find((spec) => spec.member === 'cr')?.initialMessage).not.toContain('reply_to');
  });

  /** Robin's access, and the project's contacts, as the owner sets them. */
  const setRobin = (access: 'viewer' | 'client', contacts: string[] = []) =>
    h.app.projectman.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER_LOGIN }, (draft) => {
      const member = draft.team.members.find((member) => member.handle === 'robin')!;
      if (member.kind === 'human') member.access = access;
      draft.team.contacts = contacts;
      return 'Change access';
    });

  it('refuses a viewer', async () => {
    await setRobin('viewer');
    const response = await comment({ text: 'Comment' }, developer);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('insufficient_access');
  });

  it('lets a client comment on any card (PM-985)', async () => {
    await setRobin('client');
    const response = await comment({ text: 'Looks good' }, developer);
    expect(response.statusCode).toBe(201);
    expect(
      TaskDetail.parse(response.json()).timeline.find((event) => event.type === 'task_note'),
    ).toMatchObject({ actor: { kind: 'human', handle: 'robin' }, data: { text: 'Looks good' } });
    // The response is the card as the client's own GET shows it (PM-1275).
    const read = await h.app.inject({
      method: 'GET',
      url: routes.task('AR', 'AR-1'),
      headers: { cookie: developer },
    });
    expect(response.json()).toEqual(read.json());
  });

  it('keeps a client mention of a non-contact in the comment without a notification', async () => {
    await setRobin('client', ['cr']);
    const response = await comment({ text: '@owner @cr please look' }, developer);
    expect(response.statusCode).toBe(201);
    expect(
      TaskDetail.parse(response.json()).timeline.find((event) => event.type === 'task_note'),
    ).toMatchObject({ data: { mentions: ['owner', 'cr'] } });
    await flush();
    const messages = h.app.projectman.domain.messages.list('AR');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from: 'robin', to: ['cr'] });
  });

  it('notifies nobody when a client has no contacts, and still records the comment', async () => {
    await setRobin('client');
    expect((await comment({ text: '@owner @cr hello' }, developer)).statusCode).toBe(201);
    await flush();
    expect(h.app.projectman.domain.messages.list('AR')).toHaveLength(0);
    expect(h.runner.started).toHaveLength(0);
  });

  it('refuses imported history from a client', async () => {
    await setRobin('client');
    expect((await comment({ text: 'History', importedAuthor: 'Morgan' }, developer)).statusCode).toBe(403);
  });

  it('requires login and membership and resolves tasks within the project', async () => {
    expect((await comment({ text: 'Comment' }, '')).statusCode).toBe(401);
    expect((await comment({ text: 'Comment' }, owner, 'AR-999')).statusCode).toBe(404);
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: OWNER_ACTOR, author: OWNER_LOGIN },
      (draft) => {
        draft.team.members = draft.team.members.filter((member) => member.handle !== 'robin');
        return 'Remove fictional member';
      },
    );
    expect((await comment({ text: 'Comment' }, developer)).statusCode).toBe(403);
  });

  it.each([
    {},
    { text: '' },
    { text: '   ' },
    { text: 1 },
    { text: 'x'.repeat(TASK_COMMENT_MAX + 1) },
    { text: 'Valid', importedAuthor: 'x'.repeat(81) },
    { text: 'Valid', importedAuthor: ' ' },
    { text: 'Valid', importedAt: 'yesterday' },
  ])('validates %j', async (body) => {
    expect((await comment(body)).statusCode).toBe(400);
    expect(h.app.projectman.domain.messages.list('AR')).toHaveLength(0);
  });

  it('accepts the maximum comment length', async () => {
    expect((await comment({ text: 'x'.repeat(TASK_COMMENT_MAX) })).statusCode).toBe(201);
  });

  it.each([
    { importedAuthor: 'Morgan' },
    { importedAt: '2024-01-02T03:04:05Z' },
    { importedAuthor: 'Morgan', importedAt: '2024-01-02T03:04:05+01:00' },
  ])('imports history only for owners without notifying %j', async (metadata) => {
    const body = { text: '@robin @cr historical comment', ...metadata };
    expect((await comment(body, developer)).statusCode).toBe(403);
    const response = await comment(body);
    expect(response.statusCode).toBe(201);
    expect(
      TaskDetail.parse(response.json()).timeline.find((event) => event.type === 'task_note'),
    ).toMatchObject({ actor: OWNER_ACTOR, data: { ...body, mentions: ['robin', 'cr'] } });
    await flush();
    expect(h.app.projectman.domain.messages.list('AR')).toHaveLength(0);
    expect(h.runner.started).toHaveLength(0);
  });

  it('also refuses imported history for admins', async () => {
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: OWNER_ACTOR, author: OWNER_LOGIN },
      (draft) => {
        const member = draft.team.members.find((member) => member.handle === 'robin')!;
        if (member.kind === 'human') member.access = 'admin';
        return 'Set admin access';
      },
    );
    expect((await comment({ text: 'History', importedAuthor: 'Morgan' }, developer)).statusCode).toBe(403);
  });

  it('raises the note event for a comment without mentions but not for an imported one (PM-1271)', async () => {
    const raised: Array<{ mentions: string[]; taskKey: string }> = [];
    h.app.projectman.domain.ctx.events.on('task_note_added', (note) => {
      raised.push({ mentions: note.mentions, taskKey: note.task.key });
    });
    expect((await comment({ text: 'No one mentioned' })).statusCode).toBe(201);
    expect((await comment({ text: 'History', importedAuthor: 'Morgan' })).statusCode).toBe(201);
    expect(raised).toEqual([{ mentions: [], taskKey: 'AR-1' }]);
  });

  describe('threads (PM-1290)', () => {
    const notes = () =>
      h.app.projectman.domain.timeline.list('AR').filter((event) => event.type === 'task_note');
    /** Posts a comment and returns the id of the note it recorded. */
    const post = async (body: Record<string, unknown>, cookie = owner) => {
      const response = await comment(body, cookie);
      expect(response.statusCode).toBe(201);
      return notes().at(-1)!.id;
    };
    const page = (query = '', cookie = owner) =>
      h.app.inject({
        method: 'GET',
        url: `${routes.taskComments('AR', 'AR-1')}${query}`,
        headers: { cookie },
      });

    it('marks a posted comment and keeps a process note out of the comment list', async () => {
      const { domain } = h.app.projectman;
      const { session } = await domain.sessions.ensureSession('AR', 'dev-1', {
        type: 'task',
        taskKey: 'AR-1',
      });
      const ctx = { projectKey: 'AR', taskKey: 'AR-1', member: 'dev-1', sessionId: session.id };
      await domain.teamTools.updateTask(ctx, { taskKey: 'AR-1', note: 'Working on it' });
      const top = await post({ text: 'Question' });
      expect(notes()[0]).toMatchObject({ data: { comment: false } });
      expect(notes()[1]).toMatchObject({ data: { comment: true } });
      const body = (await page()).json();
      expect(body.threads.map((thread: { comment: { id: string } }) => thread.comment.id)).toEqual([top]);
    });

    it('lands a reply to a reply on the parent comment', async () => {
      const top = await post({ text: 'Question' });
      const reply = await post({ text: 'Answer', replyTo: top });
      const deeper = await post({ text: 'Follow-up', replyTo: reply });
      expect(notes().find((event) => event.id === reply)?.data).toMatchObject({
        comment: true,
        replyTo: top,
      });
      expect(notes().find((event) => event.id === deeper)?.data).toMatchObject({ replyTo: top });
      const [thread] = (await page()).json().threads;
      expect(thread.replies.map((event: { id: string }) => event.id)).toEqual([reply, deeper]);
    });

    it('lets an AI member reply through update_task and records a comment', async () => {
      const { domain } = h.app.projectman;
      const top = await post({ text: 'Question' });
      const { session } = await domain.sessions.ensureSession('AR', 'dev-1', {
        type: 'task',
        taskKey: 'AR-1',
      });
      await domain.teamTools.updateTask(
        { projectKey: 'AR', taskKey: 'AR-1', member: 'dev-1', sessionId: session.id },
        { taskKey: 'AR-1', note: 'Done', replyTo: top },
      );
      expect(notes().at(-1)).toMatchObject({
        actor: { kind: 'ai', handle: 'dev-1' },
        data: { comment: true, replyTo: top },
      });
    });

    it('refuses a reply to a process note, to another card and to nothing', async () => {
      const { domain } = h.app.projectman;
      await domain.tasks.create('AR', { title: 'Other card' }, OWNER_ACTOR);
      const other = await comment({ text: 'Elsewhere' }, owner, 'AR-2');
      expect(other.statusCode).toBe(201);
      const otherId = notes().at(-1)!.id;
      const { session } = await domain.sessions.ensureSession('AR', 'dev-1', {
        type: 'task',
        taskKey: 'AR-1',
      });
      await domain.teamTools.updateTask(
        { projectKey: 'AR', taskKey: 'AR-1', member: 'dev-1', sessionId: session.id },
        { taskKey: 'AR-1', note: 'Process' },
      );
      const processId = notes().at(-1)!.id;
      for (const replyTo of [processId, otherId, 'evt_missing']) {
        const response = await comment({ text: 'Answer', replyTo });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('reply_target_invalid');
      }
    });

    it('runs the import call sequence: owners only, ids from the response, one thread, no repeat, no notice (PM-1275)', async () => {
      const raised: string[] = [];
      h.app.projectman.domain.ctx.events.on('task_note_added', (note) => {
        raised.push(note.event.id);
      });
      /** Posts one imported item as the import script does and finds its id by its clientRequestId. */
      const importItem = async (body: Record<string, unknown>) => {
        const response = await comment(body);
        expect(response.statusCode).toBe(201);
        return TaskDetail.parse(response.json()).timeline.find(
          (event) => event.data.clientRequestId === body.clientRequestId,
        )!.id;
      };
      const imported = (minute: number, clientRequestId: string) => ({
        importedAuthor: 'Morgan',
        importedAt: `2024-01-02T03:0${minute}:00Z`,
        clientRequestId,
      });
      const question = {
        text: '@robin @cr old question',
        ...imported(1, '6f1c2d4e-8a3b-4c5d-9e7f-0a1b2c3d4e51'),
      };
      expect((await comment(question, developer)).statusCode).toBe(403);
      const top = await importItem(question);
      const answer = {
        text: 'Old answer',
        replyTo: top,
        ...imported(2, '6f1c2d4e-8a3b-4c5d-9e7f-0a1b2c3d4e52'),
      };
      const reply = await importItem(answer);
      // A ClickUp reply to a reply names its direct target; the server lands it on the top comment.
      const followUp = {
        text: 'Old follow-up',
        replyTo: reply,
        ...imported(3, '6f1c2d4e-8a3b-4c5d-9e7f-0a1b2c3d4e53'),
      };
      const deeper = await importItem(followUp);
      // A run started again after an interruption posts the same items.
      expect([await importItem(question), await importItem(answer), await importItem(followUp)]).toEqual([
        top,
        reply,
        deeper,
      ]);
      expect(notes()).toHaveLength(3);
      const { threads } = (await page()).json();
      expect(threads).toHaveLength(1);
      expect(threads[0].comment.id).toBe(top);
      expect(
        threads[0].replies.map((event: { id: string; data: { replyTo: string } }) => [
          event.id,
          event.data.replyTo,
        ]),
      ).toEqual([
        [reply, top],
        [deeper, top],
      ]);
      await flush();
      expect(raised).toEqual([]);
      expect(h.app.projectman.domain.messages.list('AR')).toHaveLength(0);
      expect(h.runner.started).toHaveLength(0);
    });

    it('records a repeated clientRequestId of the same author once', async () => {
      const clientRequestId = '6f1c2d4e-8a3b-4c5d-9e7f-0a1b2c3d4e5f';
      const raised: string[] = [];
      h.app.projectman.domain.ctx.events.on('task_note_added', (note) => {
        raised.push(note.event.id);
      });
      const first = await post({ text: 'Once', clientRequestId });
      const again = await comment({ text: 'Once', clientRequestId });
      expect(again.statusCode).toBe(201);
      expect(notes()).toHaveLength(1);
      expect(notes()[0]!.id).toBe(first);
      // The repeat returns before the append: no second note event and no second mention notice.
      expect(raised).toEqual([first]);
      // Another author with the same id is a different submission.
      await post({ text: 'Once', clientRequestId }, developer);
      expect(notes()).toHaveLength(2);
    });

    it('pages by top-level comment on a card of more than 100 events with no orphaned reply', async () => {
      const tops: string[] = [];
      for (let index = 0; index < 40; index += 1) {
        const top = await post({ text: `Comment ${index}` });
        await post({ text: `Reply ${index}a`, replyTo: top });
        await post({ text: `Reply ${index}b`, replyTo: top });
        tops.push(top);
      }
      expect(h.app.projectman.domain.timeline.list('AR').length).toBeGreaterThan(100);
      const newest = (await page('?limit=15')).json();
      expect(newest.threads.map((thread: { comment: { id: string } }) => thread.comment.id)).toEqual(
        tops.slice(25),
      );
      expect(newest.threads.every((thread: { replies: unknown[] }) => thread.replies.length === 2)).toBe(
        true,
      );
      expect(newest.nextBefore).toBe(tops[25]);
      const older = (await page(`?limit=15&before=${newest.nextBefore}`)).json();
      expect(older.threads.map((thread: { comment: { id: string } }) => thread.comment.id)).toEqual(
        tops.slice(10, 25),
      );
      const reply = notes().find((event) => event.data.replyTo === tops[3])!;
      const around = (await page(`?limit=5&around=${reply.id}`)).json();
      expect(around.threads.map((thread: { comment: { id: string } }) => thread.comment.id)).toEqual(
        tops.slice(1, 6),
      );
      expect((await page('?before=evt_missing')).statusCode).toBe(404);
      expect((await page('?limit=51')).statusCode).toBe(400);
    });
  });
});
