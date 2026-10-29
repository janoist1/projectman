import { afterEach, describe, expect, it } from 'vitest';
import { routes, questionPayloadOf } from '@projectman/shared';
import type { InboxView } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';

describe('shared owner question visibility', () => {
  let h: AppHarness;
  afterEach(async () => h?.close());

  it('lists one answerable primary, gives the linked drawer only a pointer, and shows both to a client who cannot answer', async () => {
    h = await createAppHarness();
    const owner = await setupOwner(h.app);
    await createProject(h, owner);
    const client = await addHumanAndLogin(h.app, {
      handle: 'guest',
      access: 'client',
      adjust: (config) => {
        const pm = config.team.members.find((member) => member.handle === 'pm')!;
        if (pm.kind === 'ai') pm.onLeave = false;
      },
    });
    const { domain } = h.app.projectman;
    await domain.tasks.create('AR', { title: 'Internal source' }, OWNER_ACTOR);
    await domain.tasks.create('AR', { title: 'Shared source' }, OWNER_ACTOR);
    const questions = ['AR-1', 'AR-2'].map((taskKey, index) =>
      domain.inbox.create({
        projectKey: 'AR',
        taskKey,
        kind: 'question',
        source: index ? 'dev-2' : 'dev-1',
        assignees: ['owner'],
        title: `Source ${index}`,
        state: 'screening',
        payload: {
          question: `Source ${index}`,
          screening: { until: new Date(Date.now() + 600_000).toISOString() },
        },
        options: [{ id: 'yes', label: 'Yes', style: 'primary' }],
      }),
    );
    const group = await domain.inbox.combineQuestions(
      'AR',
      {
        itemIds: questions.map((q) => q.id),
        question: 'Internal combined question?',
        note: 'Internal explanation',
      },
      'pm',
    );
    await domain.inbox.releaseScreened(group.primaryItemId, { outcome: 'decision', by: 'pm' });
    const get = (cookie: string, query: string) =>
      h.app.inject({ url: `${routes.inbox('AR')}${query}`, headers: { cookie } });
    const open = (await get(owner, '')).json<InboxView>();
    expect(open.items.map((item) => item.id)).toEqual([group.primaryItemId]);
    expect(questionPayloadOf(open.items[0]!)?.group?.sources).toHaveLength(2);
    const all = (await get(owner, '?state=all')).json<InboxView>();
    const linked = all.items.find((item) => item.id === group.linkedItemIds[0])!;
    expect(linked.state).toBe('open');
    expect(questionPayloadOf(linked)?.group).toMatchObject({ itemIds: [], combinedQuestion: '' });
    expect(questionPayloadOf(linked)?.group?.sources).toBeUndefined();
    expect(domain.inbox.countOpenFor('AR', 'owner')).toBe(1);
    expect(
      (await h.app.inject({ url: '/api/projects/AR/tasks/AR-2', headers: { cookie: client } })).statusCode,
    ).toBe(200);
    // A client reads the questions like a viewer (PM-79) but cannot answer another person's.
    expect((await get(client, '?state=all')).json<InboxView>().items.map((item) => item.id)).toEqual(
      all.items.map((item) => item.id),
    );
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: routes.resolveInbox('AR', linked.id),
          headers: { cookie: client },
          payload: { optionId: 'yes' },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('the open inbox and its history (PM-1109)', () => {
  let h: AppHarness;
  afterEach(async () => h?.close());

  it('keeps an old open item listed and counted behind more than 500 resolved ones, and cuts only a history', async () => {
    h = await createAppHarness();
    const owner = await setupOwner(h.app);
    await createProject(h, owner);
    const { domain, repos } = h.app.projectman;
    const old = domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
      assignees: ['owner'],
      title: 'Old open question',
      payload: { question: 'Old open question' },
      options: [{ id: 'yes', label: 'Yes', style: 'primary' }],
    });
    for (let index = 0; index < 505; index++)
      repos.inbox.insert({
        ...old,
        id: `inb_done_${index}`,
        state: 'resolved',
        createdAt: new Date().toISOString(),
      });
    const get = async (query: string) =>
      (
        await h.app.inject({ url: `${routes.inbox('AR')}${query}`, headers: { cookie: owner } })
      ).json<InboxView>();
    expect((await get('')).items.map((item) => item.id)).toEqual([old.id]);
    expect(domain.inbox.countOpenFor('AR', 'owner')).toBe(1);
    repos.inbox.insert({ ...old, id: 'inb_screening', state: 'screening' });
    expect((await get('')).items.map((item) => item.id)).toEqual([old.id]);
    expect((await get('?state=active')).items.map((item) => item.id)).toEqual([old.id, 'inb_screening']);
    expect((await get('?state=closed')).items).toHaveLength(500);
    expect((await get('?state=closed&limit=7')).items).toHaveLength(7);
  });
});
