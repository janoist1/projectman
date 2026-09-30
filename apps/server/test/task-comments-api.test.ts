import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes, TaskDetail } from '@projectman/shared';
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
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.messages[0]?.text).toBe(`[team message from owner about AR-1]\n${text}`);
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
    expect(
      h.runner.messages.some((message) => message.text === `[team message from dev-1 about AR-1]\n${text}`),
    ).toBe(true);
  });

  it.each(['viewer', 'client'] as const)('refuses %s access', async (access) => {
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: OWNER_ACTOR, author: OWNER_LOGIN },
      (draft) => {
        const member = draft.team.members.find((member) => member.handle === 'robin')!;
        if (member.kind === 'human') member.access = access;
        return 'Change access';
      },
    );
    expect((await comment({ text: 'Comment' }, developer)).statusCode).toBe(403);
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
    { text: 'x'.repeat(10001) },
    { text: 'Valid', importedAuthor: 'x'.repeat(81) },
    { text: 'Valid', importedAuthor: ' ' },
    { text: 'Valid', importedAt: 'yesterday' },
  ])('validates %j', async (body) => {
    expect((await comment(body)).statusCode).toBe(400);
    expect(h.app.projectman.domain.messages.list('AR')).toHaveLength(0);
  });

  it('accepts the maximum comment length', async () => {
    expect((await comment({ text: 'x'.repeat(10000) })).statusCode).toBe(201);
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
});
