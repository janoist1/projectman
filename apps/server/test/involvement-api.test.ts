import { waitForSession } from './helpers/domain-harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { Actor } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('integrator key and involvement audit', () => {
  let h: AppHarness;
  let cookie: string;
  let now: Date;
  beforeEach(async () => {
    now = new Date();
    h = await createAppHarness({ now: () => now });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => {
    await h.close();
  });
  it('filters, counts and pages events without restarts', async () => {
    const { domain } = h.app.projectman;
    const task = await domain.tasks.create(
      'AR',
      { title: 'Involvements' },
      { kind: 'human', handle: 'owner' },
    );
    const by: Actor = { kind: 'human', handle: 'owner', via: 'integrator' };
    for (let n = 0; n < 4; n++)
      domain.timeline.append({
        projectKey: 'AR',
        taskKey: task.key,
        actor: { kind: 'ai', handle: 'dev-1' },
        type: 'session_started',
        data: { member: 'dev-1', resumed: n > 0, ...(n ? { cause: { kind: 'start_button', by } } : {}) },
        createdAt: `2026-10-08T10:00:0${n}.000Z`,
      });
    domain.timeline.append({
      projectKey: 'AR',
      taskKey: task.key,
      actor: { kind: 'ai', handle: 'dev-1' },
      type: 'session_ended',
      data: { member: 'dev-1', exitCode: null, stop: { kind: 'restart' } },
    });
    const get = async (suffix: string) =>
      (await h.app.inject({ url: routes.involvements('AR') + suffix, headers: { cookie } })).json();
    const first = await get(`?member=dev-1&task=${task.key}&limit=2&kind=started`);
    expect(first.counts).toEqual({ started: 4, stopped: 0 });
    expect(first.items).toHaveLength(2);
    const second = await get(
      `?member=dev-1&task=${task.key}&limit=2&kind=started&before=${first.nextBefore}`,
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextBefore).toBeNull();
    expect(second.counts).toEqual(first.counts);
    expect(
      new Set([...first.items, ...second.items].map((item: { event: { id: string } }) => item.event.id)).size,
    ).toBe(4);
    expect((await get('?by=integrator')).counts.started).toBe(3);
    expect((await get('?by=owner')).items).toHaveLength(0);
    expect((await get('?by=system')).items).toHaveLength(0);
    expect((await get('?kind=stopped')).items).toHaveLength(0);
    expect((await get('?since=2026-10-08T10:00:02.000Z')).counts.started).toBe(2);
  });

  it('records a note mention and its linked event as the wake-up cause', async () => {
    const { domain } = h.app.projectman;
    const task = await domain.tasks.create(
      'AR',
      { title: 'Mention audit' },
      { kind: 'human', handle: 'owner' },
    );
    await domain.tasks.addNote('AR', task.key, '@dev-1 Check attribution. Then check the link.', {
      kind: 'human',
      handle: 'owner',
    });
    await vi.waitFor(() => expect(domain.sessions.list('AR', { taskKey: task.key })).toHaveLength(1));
    const cause = (await waitForSession(domain, { taskKey: task.key })).startCause;
    expect(cause).toMatchObject({
      kind: 'mention',
      by: { kind: 'human', handle: 'owner' },
      quote: '@dev-1 Check attribution.',
    });
    expect(
      domain.timeline.list('AR', { taskKey: task.key }).find((event) => event.id === cause?.eventId)?.type,
    ).toBe('task_note');
    expect(h.app.projectman.repos.messages.get(cause!.messageId!)?.origin).toEqual({
      kind: 'note',
      eventId: cause!.eventId,
    });
  });

  it('hides private cause quotes in the overview from everyone but the owner, clients included', async () => {
    const developer = await addHumanAndLogin(h.app, { handle: 'colleague' });
    const client = await addHumanAndLogin(h.app, { handle: 'client', access: 'client' });
    const sent = await h.app.projectman.domain.messaging.send('AR', 'owner', {
      to: ['dev-1'],
      text: 'Private audit instructions.',
    });
    await vi.waitFor(() =>
      expect(
        h.app.projectman.domain.timeline.list('AR').some((event) => event.type === 'session_started'),
      ).toBe(true),
    );
    const url = routes.involvements('AR');
    const ownerView = await h.app.inject({ url, headers: { cookie } });
    expect(ownerView.body).toContain('Private audit instructions.');
    const otherView = await h.app.inject({ url, headers: { cookie: developer } });
    expect(otherView.statusCode).toBe(200);
    expect(otherView.body).not.toContain('Private audit instructions.');
    expect(otherView.body).toContain(sent.id);
    const clientView = await h.app.inject({ url, headers: { cookie: client } });
    expect(clientView.statusCode).toBe(200);
    expect(clientView.body).not.toContain('Private audit instructions.');
    expect((await h.app.inject({ url: url + '?before=invalid', headers: { cookie } })).statusCode).toBe(400);
  });
});
