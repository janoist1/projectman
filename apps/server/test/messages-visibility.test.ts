import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes, TeamMessagesView } from '@projectman/shared';
import type { HumanAccess, ServerEvent } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';

const key = 'AR';

/** Who may see which team messages of a project (PM-78): an owner and an admin all, everyone else their own. */
describe('team message visibility over REST and websocket', () => {
  let h: AppHarness;
  let cookies: Record<string, string>;
  const actor = { kind: 'human' as const, handle: 'owner' };
  const record = (from: string, to: string[], taskKey: string | null = null, body = `${from} to ${to}`) =>
    h.app.projectman.domain.messages.record({
      projectKey: key,
      from,
      to,
      taskKey,
      body,
      actor,
      humanRecipients: [from, ...to],
      delivered: true,
    });
  const human = (handle: string, access: HumanAccess) =>
    addHumanAndLogin(h.app, { handle, access, email: `${handle}@acme.test` });
  async function list(handle: string, query = ''): Promise<string[]> {
    const response = await h.app.inject({
      url: `${routes.teamMessages(key)}${query}`,
      headers: { cookie: cookies[handle]! },
    });
    expect(response.statusCode).toBe(200);
    return TeamMessagesView.parse(response.json()).messages.map((m) => m.body);
  }

  beforeEach(async () => {
    h = await createAppHarness();
    cookies = { owner: await setupOwner(h.app) };
    await createProject(h, cookies.owner!);
    cookies.admin = await human('admin', 'admin');
    cookies.dev = await human('dev', 'developer');
    cookies.reader = await human('reader', 'viewer');
    cookies.acme = await human('acme', 'client');
    await h.app.projectman.domain.tasks.create(key, { title: 'Acme checkout' }, actor);
    record('qa', ['designer'], 'AR-1', 'qa-designer task');
    record('qa', ['designer', 'dev'], null, 'qa-designer-dev');
    record('dev', ['qa'], 'AR-1', 'dev-qa task');
    record('owner', ['acme'], null, 'owner-acme');
    record('acme', ['owner', 'reader'], null, 'acme-owner-reader');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  const all = ['qa-designer task', 'qa-designer-dev', 'dev-qa task', 'owner-acme', 'acme-owner-reader'];

  it('gives an owner and an admin every message, with and without filters', async () => {
    for (const handle of ['owner', 'admin']) {
      expect(await list(handle)).toEqual(all);
      expect(await list(handle, '?member=qa')).toEqual([
        'qa-designer task',
        'qa-designer-dev',
        'dev-qa task',
      ]);
      expect(await list(handle, '?taskKey=AR-1')).toEqual(['qa-designer task', 'dev-qa task']);
    }
    // Unread is the viewer's own unread: an owner is a recipient of one message, an admin of none.
    expect(await list('owner', '?unreadOnly=true')).toEqual(['acme-owner-reader']);
    expect(await list('admin', '?unreadOnly=true')).toEqual([]);
    expect(await list('admin', '?threadWith=admin')).toEqual([]);
  });

  it('gives a developer only what they sent or got, whatever the filter', async () => {
    expect(await list('dev')).toEqual(['qa-designer-dev', 'dev-qa task']);
    expect(await list('dev', '?member=designer')).toEqual(['qa-designer-dev']);
    expect(await list('dev', '?member=owner')).toEqual([]);
    expect(await list('dev', '?taskKey=AR-1')).toEqual(['dev-qa task']);
    expect(await list('dev', '?threadWith=qa')).toEqual(['qa-designer-dev', 'dev-qa task']);
    expect(await list('dev', '?threadWith=designer')).toEqual([]);
    expect(await list('dev', '?unreadOnly=true')).toEqual(['qa-designer-dev']);
  });

  it('gives a viewer and a client only their own messages, whatever the filter', async () => {
    expect(await list('reader')).toEqual(['acme-owner-reader']);
    expect(await list('reader', '?member=qa')).toEqual([]);
    expect(await list('reader', '?member=acme')).toEqual(['acme-owner-reader']);
    expect(await list('reader', '?taskKey=AR-1')).toEqual([]);
    expect(await list('acme')).toEqual(['owner-acme', 'acme-owner-reader']);
    expect(await list('acme', '?member=dev')).toEqual([]);
    expect(await list('acme', '?threadWith=owner')).toEqual(['owner-acme', 'acme-owner-reader']);
    expect(await list('acme', '?unreadOnly=true')).toEqual(['owner-acme']);
  });

  it('pushes a message only to those it concerns, an owner and an admin', async () => {
    const received: Record<string, ServerEvent[]> = {};
    const sockets = await Promise.all(
      Object.entries(cookies).map(async ([handle, cookie]) => {
        received[handle] = [];
        const socket = await h.app.injectWS(
          '/ws',
          { headers: { cookie } },
          {
            onInit: (ws) =>
              ws.on('message', (data: Buffer) =>
                received[handle]!.push(JSON.parse(data.toString()) as ServerEvent),
              ),
          },
        );
        socket.send(JSON.stringify({ type: 'subscribe_project', projectKey: key }));
        return socket;
      }),
    );
    try {
      await flush();
      const message = record('qa', ['dev', 'designer'], null, 'for dev');
      const seen = (handle: string) =>
        received[handle]!.some((e) => e.type === 'team_message' && e.message.id === message.id);
      await vi.waitFor(() => expect(seen('owner') && seen('admin') && seen('dev')).toBe(true));
      await flush();
      expect(seen('reader')).toBe(false);
      expect(seen('acme')).toBe(false);
      // A read receipt is an event of the same message: the outsiders do not get it either.
      h.app.projectman.domain.messages.markRead(key, message.id, 'dev');
      await vi.waitFor(() =>
        expect(
          received.owner!.some((e) => e.type === 'team_message' && e.message.receipts?.[0]?.readAt),
        ).toBe(true),
      );
      await flush();
      for (const handle of ['reader', 'acme'])
        expect(received[handle]!.filter((e) => e.type === 'team_message')).toEqual([]);
    } finally {
      for (const socket of sockets) socket.terminate();
    }
  });
});
