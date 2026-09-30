import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes, MemberProfile, TeamMessage, TeamMessagesView } from '@projectman/shared';
import type { HumanAccess, ServerEvent } from '@projectman/shared';
import {
  addHumanAndLogin,
  createAppHarness,
  createProject,
  OWNER_LOGIN,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';

const key = 'AR';
describe('human team messages and member profiles', () => {
  let h: AppHarness;
  let owner: string;
  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });
  const actor = { kind: 'human' as const, handle: 'owner' };
  const human = (handle: string, access: HumanAccess = 'developer') =>
    addHumanAndLogin(h.app, { handle, access, email: `${handle}@acme.test` });
  async function send(to: string[], cookie = owner, extra: object = {}) {
    return h.app.inject({
      method: 'POST',
      url: routes.sendTeamMessage(key),
      headers: { cookie },
      payload: { to, text: 'Discuss the Acme webshop', ...extra },
    });
  }
  async function profile(handle: string, cookie = owner) {
    return h.app.inject({ url: routes.memberProfile(key, handle), headers: { cookie } });
  }

  it('starts an offline task recipient and delivers the queued message once', async () => {
    const domain = h.app.projectman.domain;
    await domain.tasks.create(key, { title: 'Acme checkout' }, actor);
    const response = await send(['dev-1', 'dev-1'], owner, { taskKey: 'AR-1' });
    expect(response.statusCode).toBe(202);
    const message = TeamMessage.parse(response.json());
    expect(message).toMatchObject({ from: 'owner', to: ['dev-1'] });
    expect(domain.timeline.list(key, { taskKey: 'AR-1' })).toContainEqual(
      expect.objectContaining({
        type: 'team_message',
        actor,
        data: expect.objectContaining({ messageId: message.id }),
      }),
    );
    await flush();
    const session = domain.sessions.list(key, { member: 'dev-1' })[0]!;
    expect(session.workItem).toEqual({ type: 'task', taskKey: 'AR-1' });
    expect(h.runner.messages).toEqual([
      { sessionId: session.id, text: '[team message from owner about AR-1]\nDiscuss the Acme webshop' },
    ]);
    expect(h.app.projectman.repos.messages.get(message.id)?.receipts?.[0]?.deliveredAt).toBeTruthy();
    expect(h.runner.started).toHaveLength(1);
  });

  it('responds before an idle recipient PTY starts', async () => {
    const start = h.runner.start.bind(h.runner);
    let release!: () => void;
    const called = vi.spyOn(h.runner, 'start').mockImplementation(async (spec) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return start(spec);
    });
    const response = await send(['dev-1']);
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(called).toHaveBeenCalledOnce());
    expect(h.runner.started).toHaveLength(0);
    release();
    await h.app.projectman.domain.stop();
    expect(h.runner.started).toHaveLength(1);
  });

  it('delivers to a live task session with the team prefix and retries failed delivery on resume', async () => {
    const domain = h.app.projectman.domain;
    await domain.tasks.create(key, { title: 'Acme checkout' }, actor);
    const { session } = await domain.sessions.ensureSession(key, 'dev-1', { type: 'task', taskKey: 'AR-1' });
    const failed = vi
      .spyOn(h.runner, 'sendUserMessage')
      .mockRejectedValueOnce(new Error('Session exited before paste'));
    const message = TeamMessage.parse((await send(['dev-1'], owner, { taskKey: 'AR-1' })).json());
    await flush();
    expect(h.app.projectman.repos.messages.get(message.id)?.deliveredAt).toBeNull();
    await domain.sessions.stop(key, session.id);
    await domain.sessions.ensureSession(key, 'dev-1', { type: 'task', taskKey: 'AR-1' });
    await flush();
    expect(failed).toHaveBeenCalledTimes(2);
    expect(h.runner.messages.at(-1)).toEqual({
      sessionId: session.id,
      text: '[team message from owner about AR-1]\nDiscuss the Acme webshop',
    });
    expect(h.app.projectman.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
  });

  it('waits for the runner paste before acknowledging each AI recipient', async () => {
    const domain = h.app.projectman.domain;
    await human('bence');
    await domain.sessions.ensureSession(key, 'dev-1', { type: 'general' });
    const typed: Array<() => void> = [];
    vi.spyOn(h.runner, 'sendUserMessage').mockImplementation(
      () =>
        new Promise((resolve) => {
          typed.push(resolve);
        }),
    );
    // The sender is never a recipient of their own message.
    const response = TeamMessage.parse((await send(['dev-1', 'dev-2', 'bence', 'owner'])).json());
    expect(response.to).toEqual(['dev-1', 'dev-2', 'bence']);
    await flush();
    expect(h.app.projectman.repos.messages.get(response.id)?.receipts).toMatchObject([
      { deliveredAt: null },
      { deliveredAt: null },
      { kind: 'human', deliveredAt: expect.any(String) },
    ]);
    typed[0]!();
    await flush();
    const stored = h.app.projectman.repos.messages.get(response.id)!;
    expect(stored.receipts?.[0]?.deliveredAt).toBeTruthy();
    expect(stored.receipts?.[1]?.deliveredAt).toBeNull();
    expect(stored.deliveredAt).toBeNull();
  });

  it('keeps human unread counts and read receipts independent and checks the recipient', async () => {
    const kata = await human('kata', 'client');
    const bence = await human('bence');
    const message = TeamMessage.parse((await send(['kata', 'bence'])).json());
    const view = async (cookie: string) =>
      TeamMessagesView.parse(
        (await h.app.inject({ url: routes.teamMessages(key), headers: { cookie } })).json(),
      );
    expect((await view(kata)).unreadCount).toBe(1);
    expect((await view(bence)).unreadCount).toBe(1);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: routes.readTeamMessage(key, message.id),
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: routes.readTeamMessage(key, message.id),
          headers: { cookie: kata },
        })
      ).statusCode,
    ).toBe(200);
    expect((await view(kata)).unreadCount).toBe(0);
    expect((await view(bence)).unreadCount).toBe(1);
    const receipts = h.app.projectman.repos.messages.get(message.id)!.receipts!;
    expect(receipts[0]?.readAt).toBeTruthy();
    expect(receipts[1]?.readAt).toBeNull();
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: routes.readTeamMessage('ZZ', message.id),
          headers: { cookie: kata },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('accepts developers and clients, rejects viewers, validates all recipients before recording', async () => {
    const kata = await human('kata', 'client');
    const bence = await human('bence');
    expect((await send(['dev-1'], bence)).statusCode).toBe(202);
    await h.app.projectman.domain.members.update(
      key,
      'bence',
      { access: 'viewer' },
      { actor, author: OWNER_LOGIN },
    );
    expect((await send(['dev-1'], kata)).statusCode).toBe(202);
    expect((await send(['dev-1'], bence)).statusCode).toBe(403);
    const before = h.app.projectman.repos.messages.list(key).length;
    for (const payload of [
      { to: [] },
      { text: '   ' },
      { to: ['owner', 'missing'] },
      { taskKey: 'AR-999' },
    ]) {
      expect((await send(['owner'], owner, payload)).statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(h.app.projectman.repos.messages.list(key)).toHaveLength(before);
    await h.app.projectman.domain.tasks.create(
      key,
      { title: 'Internal Acme work', visibility: 'internal' },
      actor,
    );
    expect((await send(['owner'], kata, { taskKey: 'AR-1' })).statusCode).toBe(404);
    await h.app.projectman.domain.tasks.create(
      key,
      { title: 'Shared Acme work', visibility: 'shared' },
      actor,
    );
    expect((await send(['owner'], kata, { taskKey: 'AR-2' })).statusCode).toBe(202);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: routes.startConversation(key, 'dev-1'),
          headers: { cookie: kata },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: routes.startConversation(key, 'owner'),
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('enforces member capacity, concurrency, provider usage, and reuses live conversations', async () => {
    const domain = h.app.projectman.domain;
    await domain.projects.update(key, { actor, author: OWNER_LOGIN }, (draft) => {
      draft.team.limits.maxConcurrentAi = 1;
      return 'Pause fictional work';
    });
    const busy = await domain.messageStarts.startConversation(key, 'dev-2');
    await expect(domain.messageStarts.startConversation(key, 'dev-1')).rejects.toMatchObject({
      code: 'ai_limit_reached',
    });
    await domain.sessions.stop(key, busy.id);
    await domain.projects.update(key, { actor, author: OWNER_LOGIN }, (draft) => {
      draft.team.limits.maxConcurrentAi = 3;
      return 'Resume fictional work';
    });
    h.runnerModule.planUsage.value = {
      fiveHourPercent: 99,
      weeklyPercent: 0,
      fiveHourResetsAt: null,
      weeklyResetsAt: null,
      fetchedAt: new Date().toISOString(),
    };
    await expect(domain.messageStarts.startConversation(key, 'dev-1')).rejects.toMatchObject({
      code: 'plan_usage_paused',
    });
    h.runnerModule.planUsage.value = null;
    const first = await domain.messageStarts.startConversation(key, 'dev-1');
    expect((await domain.messageStarts.startConversation(key, 'dev-1')).id).toBe(first.id);
    await domain.sessions.stop(key, first.id);
    await domain.tasks.create(key, { title: 'Acme task' }, actor);
    domain.tasks.assign(key, 'AR-1', 'dev-1', actor);
    await expect(domain.messageStarts.startConversation(key, 'dev-1')).rejects.toMatchObject({
      code: 'member_at_capacity',
    });
  });

  it('exposes AI work, timeline, sessions, duties and read-only saved memories', async () => {
    const domain = h.app.projectman.domain;
    await domain.tasks.create(key, { title: 'Acme task' }, actor);
    domain.tasks.assign(key, 'AR-1', 'dev-1', actor);
    const { session } = await domain.sessions.ensureSession(key, 'dev-1', { type: 'task', taskKey: 'AR-1' });
    await h.memory.append(key, 'dev-1', 'Acme uses fictional fixtures.');
    const data = MemberProfile.parse((await profile('dev-1')).json());
    expect(data).toMatchObject({
      capacityUsed: 1,
      capacity: 1,
      duties: expect.arrayContaining(['implementation']),
      sessions: [expect.objectContaining({ id: session.id })],
      tasks: [expect.objectContaining({ key: 'AR-1' })],
    });
    expect(data.timeline.some((e) => e.type === 'session_started')).toBe(true);
    expect(
      (await h.app.inject({ url: routes.memberMemories(key, 'dev-1'), headers: { cookie: owner } })).json(),
    ).toEqual({ memory: '- Acme uses fictional fixtures.\n' });
    const kata = await human('kata', 'client');
    const clientProfile = MemberProfile.parse((await profile('dev-1', kata)).json());
    expect(clientProfile.tasks).toEqual([]);
    expect(clientProfile.sessions).toEqual([]);
    expect(
      (await h.app.inject({ url: routes.memberMemories(key, 'dev-1'), headers: { cookie: kata } }))
        .statusCode,
    ).toBe(403);
    expect((await profile('missing')).statusCode).toBe(404);
  });

  it('exposes human pending decisions and email only to admins, edits access and removes humans', async () => {
    const bence = await human('bence');
    const kata = await human('kata', 'admin');
    const domain = h.app.projectman.domain;
    await domain.tasks.create(key, { title: 'Acme task' }, actor);
    domain.inbox.create({
      projectKey: key,
      kind: 'question',
      assignees: ['bence'],
      source: 'dev-1',
      taskKey: 'AR-1',
      title: 'Confirm Acme text',
      payload: {},
      options: [{ id: 'answer', label: 'answer', style: 'primary' }],
    });
    expect(MemberProfile.parse((await profile('bence')).json())).toMatchObject({
      email: 'bence@acme.test',
      inbox: [expect.objectContaining({ assignees: ['bence'] })],
      tasks: [expect.objectContaining({ key: 'AR-1' })],
    });
    expect(MemberProfile.parse((await profile('bence', bence)).json()).email).toBeUndefined();
    expect(
      (
        await h.app.inject({
          method: 'PATCH',
          url: routes.member(key, 'bence'),
          headers: { cookie: kata },
          payload: { access: 'client', roles: ['support'] },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.app.inject({
          method: 'PATCH',
          url: routes.member(key, 'owner'),
          headers: { cookie: kata },
          payload: { access: 'developer' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'DELETE',
          url: routes.removeHuman(key, 'bence'),
          headers: { cookie: kata },
        })
      ).statusCode,
    ).toBe(204);
    expect((await profile('bence')).statusCode).toBe(404);
    expect(domain.inbox.list(key).find((i) => i.title === 'Confirm Acme text')?.assignees).toEqual(['owner']);
  });

  it('counts unread messages and fetches a member thread beyond the latest project page', async () => {
    const domain = h.app.projectman.domain;
    const first = await domain.messaging.send(key, 'owner', {
      to: ['dev-1'],
      text: 'Older Acme thread',
    });
    for (let i = 0; i < 205; i++)
      domain.messages.record({
        projectKey: key,
        from: 'dev-2',
        to: ['owner'],
        body: 'Acme status',
        taskKey: null,
        actor: { kind: 'ai', handle: 'dev-2' },
        humanRecipients: ['owner'],
        delivered: true,
      });
    const view = TeamMessagesView.parse(
      (await h.app.inject({ url: routes.teamMessages(key), headers: { cookie: owner } })).json(),
    );
    expect(view.messages).toHaveLength(200);
    expect(view.unreadCount).toBe(205);
    for (const message of view.messages) domain.messages.markRead(key, message.id, 'owner');
    const remaining = TeamMessagesView.parse(
      (
        await h.app.inject({ url: `${routes.teamMessages(key)}?unreadOnly=true`, headers: { cookie: owner } })
      ).json(),
    );
    expect(remaining.messages).toHaveLength(5);
    expect(remaining.unreadCount).toBe(5);
    const thread = TeamMessagesView.parse(
      (
        await h.app.inject({
          url: `${routes.teamMessages(key)}?threadWith=dev-1`,
          headers: { cookie: owner },
        })
      ).json(),
    );
    expect(thread.messages.map((m) => m.id)).toEqual([first.id]);
    await domain.messageStarts.startConversation(key, 'dev-1');
    await flush();
    expect(h.runner.messages).toHaveLength(1);
  });

  it('pushes human deliveries and read receipts over websocket', async () => {
    const kata = await human('kata', 'client');
    const events: ServerEvent[] = [];
    const socket = await h.app.injectWS(
      '/ws',
      { headers: { cookie: kata } },
      {
        onInit: (ws) =>
          ws.on('message', (data: Buffer) => events.push(JSON.parse(data.toString()) as ServerEvent)),
      },
    );
    try {
      socket.send(JSON.stringify({ type: 'subscribe_project', projectKey: key }));
      socket.send('invalid');
      await vi.waitFor(() => expect(events.some((e) => e.type === 'error')).toBe(true));
      const message = TeamMessage.parse((await send(['kata'])).json());
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === 'team_message' && e.message.id === message.id)).toBe(true),
      );
      await h.app.inject({
        method: 'POST',
        url: routes.readTeamMessage(key, message.id),
        headers: { cookie: kata },
      });
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === 'team_message' && e.message.receipts?.[0]?.readAt)).toBe(true),
      );
      await send(['dev-1']);
      await flush();
      expect(events.filter((e) => e.type === 'team_message')).toHaveLength(2);
    } finally {
      socket.terminate();
    }
  });
});
