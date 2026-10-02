import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes, TeamMessagesView, TeamThreadsView } from '@projectman/shared';
import type { ServerEvent } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';

const key = 'AR';

/** The conversation list and the one-request read of a conversation (PM-78). */
describe('team message threads', () => {
  let h: AppHarness;
  let owner: string;
  let dev: string;
  const actor = { kind: 'human' as const, handle: 'owner' };
  const record = (from: string, to: string[], body: string) =>
    h.app.projectman.domain.messages.record({
      projectKey: key,
      from,
      to,
      taskKey: null,
      body,
      actor,
      humanRecipients: [from, ...to],
      delivered: true,
    });
  const threads = async (cookie: string) => {
    const response = await h.app.inject({ url: routes.teamThreads(key), headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return TeamThreadsView.parse(response.json());
  };
  const read = (ids: string[], cookie: string) =>
    h.app.inject({
      method: 'POST',
      url: routes.readTeamMessages(key),
      headers: { cookie },
      payload: { ids },
    });

  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    dev = await addHumanAndLogin(h.app, { handle: 'dev', access: 'developer', email: 'dev@acme.test' });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  it('lists a member own conversations, the latest first, with the unread counts', async () => {
    record('qa', ['owner'], 'qa 1');
    record('owner', ['designer', 'dev'], 'group');
    record('qa', ['owner'], 'qa 2');
    record('designer', ['owner'], 'designer 1');
    record('qa', ['designer'], 'not the owner');
    const view = await threads(owner);
    expect(view.threads.map((t) => [t.peer, t.lastMessage.body, t.unreadCount])).toEqual([
      ['designer', 'designer 1', 1],
      ['qa', 'qa 2', 2],
      ['dev', 'group', 0],
    ]);
    expect(view.unreadCount).toBe(3);
  });

  it('puts a group message in the sender thread with each recipient and in the recipient one with the sender only', async () => {
    record('owner', ['designer', 'dev'], 'group');
    const forDev = await threads(dev);
    expect(forDev.threads.map((t) => [t.peer, t.lastMessage.body, t.unreadCount])).toEqual([
      ['owner', 'group', 1],
    ]);
    expect((await threads(owner)).threads.map((t) => t.peer).sort()).toEqual(['designer', 'dev']);
  });

  it('keeps old conversations and unread messages beyond the latest page', async () => {
    record('qa', ['owner'], 'long ago');
    for (let i = 0; i < 520; i++) record('designer', ['owner'], `designer ${i}`);
    const view = await threads(owner);
    expect(view.threads.map((t) => [t.peer, t.unreadCount])).toEqual([
      ['designer', 520],
      ['qa', 1],
    ]);
    expect(view.unreadCount).toBe(521);
  });

  it('marks the messages of a conversation read in one request, leaving the ones not addressed to the member', async () => {
    const mine = [record('qa', ['owner'], 'a'), record('qa', ['owner', 'dev'], 'b')];
    const notMine = record('qa', ['dev'], 'c');
    const sent = record('owner', ['qa'], 'd');
    const events: ServerEvent[] = [];
    const socket = await h.app.injectWS(
      '/ws',
      { headers: { cookie: owner } },
      { onInit: (ws) => ws.on('message', (data: Buffer) => events.push(JSON.parse(data.toString()))) },
    );
    try {
      socket.send(JSON.stringify({ type: 'subscribe_project', projectKey: key }));
      await flush();
      const before = events.length;
      const response = await read([...mine.map((m) => m.id), notMine.id, sent.id, 'msg_unknown'], owner);
      expect(response.statusCode).toBe(200);
      const view = TeamMessagesView.parse(response.json());
      expect(view.messages.map((m) => m.body)).toEqual(['a', 'b']);
      expect(view.unreadCount).toBe(0);
      await vi.waitFor(() =>
        expect(events.slice(before).filter((e) => e.type === 'team_message')).toHaveLength(2),
      );
    } finally {
      socket.terminate();
    }
    const domain = h.app.projectman.domain;
    expect(domain.messages.get(mine[1]!.id)!.receipts!.map((r) => !!r.readAt)).toEqual([true, false]);
    expect(domain.messages.get(notMine.id)!.receipts![0]!.readAt).toBeNull();
    // Read again: nothing changes, nothing is sent.
    expect(TeamMessagesView.parse((await read([mine[0]!.id], owner)).json()).messages).toEqual([]);
    expect((await threads(owner)).unreadCount).toBe(0);
  });

  it('refuses an empty or oversized list of ids', async () => {
    expect((await read([], owner)).statusCode).toBe(400);
    expect(
      (
        await read(
          Array.from({ length: 501 }, (_, i) => `msg_${i}`),
          owner,
        )
      ).statusCode,
    ).toBe(400);
  });
});
