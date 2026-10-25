import { waitForSession } from './helpers/domain-harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { ServerEvent, Task, TaskDetail } from '@projectman/shared';
import {
  addHumanAndLogin,
  createAppHarness,
  createProject,
  OWNER_LOGIN,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { waitFor as waitForCondition } from './helpers/wait';

interface TestSocket {
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
}

function collectInto(ws: TestSocket, events: ServerEvent[]): void {
  ws.on('message', (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
}

/** The first collected event the predicate accepts; the failure lists what did arrive. */
const waitFor = <T extends ServerEvent>(events: ServerEvent[], predicate: (e: ServerEvent) => e is T) =>
  waitForCondition(() => events.find(predicate), {
    timeoutMs: 2000,
    intervalMs: 5,
    what: () => `an event; got ${events.map((e) => e.type).join(', ')}`,
  });

const ofType =
  <K extends ServerEvent['type']>(type: K) =>
  (e: ServerEvent): e is Extract<ServerEvent, { type: K }> =>
    e.type === type;

describe('websocket', () => {
  let h: AppHarness;
  let cookie: string;
  const sockets: TestSocket[] = [];
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const ws of sockets.splice(0)) ws.terminate();
    await h.close();
  });

  /** Connects and collects every event from the first frame on (listeners attach before "open"). */
  async function connect(
    headers: Record<string, string> = { cookie },
  ): Promise<{ ws: TestSocket; events: ServerEvent[] }> {
    const events: ServerEvent[] = [];
    const ws = (await h.app.injectWS(
      '/ws',
      { headers },
      { onInit: (socket) => collectInto(socket as unknown as TestSocket, events) },
    )) as unknown as TestSocket;
    sockets.push(ws);
    return { ws, events };
  }

  it('rejects connections without a login cookie', async () => {
    await expect(h.app.injectWS('/ws', { headers: {} })).rejects.toThrow('401');
  });

  it('tracks visible connections and removes them on disconnect', async () => {
    const first = await connect();
    const second = await connect();
    first.ws.send(JSON.stringify({ type: 'visibility', visible: true }));
    second.ws.send(JSON.stringify({ type: 'visibility', visible: true }));
    await vi.waitFor(() => expect(h.app.projectman.domain.presence.isViewing(OWNER_LOGIN.email)).toBe(true));
    first.ws.terminate();
    second.ws.send(JSON.stringify({ type: 'visibility', visible: false }));
    await vi.waitFor(() => expect(h.app.projectman.domain.presence.isViewing(OWNER_LOGIN.email)).toBe(false));
    second.ws.send(JSON.stringify({ type: 'visibility', visible: true }));
    await vi.waitFor(() => expect(h.app.projectman.domain.presence.isViewing(OWNER_LOGIN.email)).toBe(true));
    second.ws.terminate();
    await vi.waitFor(() => expect(h.app.projectman.domain.presence.isViewing(OWNER_LOGIN.email)).toBe(false));
  });

  it('streams project events to subscribers and terminal data to attached clients', async () => {
    const { ws, events } = await connect();
    await waitFor(events, ofType('hello'));

    ws.send(JSON.stringify({ type: 'subscribe_project', projectKey: 'AR' }));
    ws.send('not json');
    await waitFor(
      events,
      (e): e is Extract<ServerEvent, { type: 'error' }> =>
        e.type === 'error' && e.message === 'invalid_command',
    );
    ws.send(JSON.stringify({ type: 'subscribe_project', projectKey: 'ZZ' }));
    await waitFor(
      events,
      (e): e is Extract<ServerEvent, { type: 'error' }> => e.type === 'error' && e.message === 'not_a_member',
    );

    await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks',
      headers: { cookie },
      payload: { title: 'Login page' },
    });
    const upserted = await waitFor(events, ofType('task_upserted'));
    expect(upserted.task.key).toBe('AR-1');
    await waitFor(events, ofType('timeline_appended'));

    const started = await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks/AR-1/start',
      headers: { cookie },
      payload: {},
    });
    const sessionId = started.json<TaskDetail>().sessions[0]!.id;
    await waitFor(events, ofType('session_upserted'));

    // Terminal data only reaches attached clients.
    h.runner.emit({ type: 'terminal_data', sessionId, data: 'before attach' });
    ws.send(JSON.stringify({ type: 'terminal_attach', sessionId }));
    const snapshot = await waitFor(events, ofType('terminal_snapshot'));
    expect(snapshot).toEqual({
      type: 'terminal_snapshot',
      sessionId,
      data: `screen of ${sessionId}`,
      cols: 120,
      rows: 40,
    });
    h.runner.emit({ type: 'terminal_data', sessionId, data: 'after attach' });
    const data = await waitFor(events, ofType('terminal_data'));
    expect(data.data).toBe('after attach');
    expect(events.filter((e) => e.type === 'terminal_data')).toHaveLength(1);

    ws.send(JSON.stringify({ type: 'terminal_input', sessionId, data: 'y\r' }));
    ws.send(JSON.stringify({ type: 'terminal_resize', sessionId, cols: 100, rows: 30 }));
    const deadline = Date.now() + 1000;
    while (h.runner.resized.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(h.runner.input).toEqual([{ sessionId, data: 'y\r' }]);
    expect(h.runner.resized).toEqual([{ sessionId, cols: 100, rows: 30 }]);

    // Member state follows the session (starting counts as working; then the activity arrives).
    h.runner.setState(sessionId, 'working', 'Edit: src/login.tsx');
    const state = await waitFor(
      events,
      (e): e is Extract<ServerEvent, { type: 'member_state' }> =>
        e.type === 'member_state' && e.handle === 'dev-1' && e.activity !== null,
    );
    expect(state).toMatchObject({ status: 'working', activity: 'Edit: src/login.tsx' });
  });

  it('revokes existing terminal streams and commands after membership removal or logout', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks',
      headers: { cookie },
      payload: { title: 'Example' },
    });
    const started = await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks/AR-1/start',
      headers: { cookie },
      payload: {},
    });
    const sessionId = started.json<TaskDetail>().sessions[0]!.id;
    const viewerCookie = await addHumanAndLogin(h.app, {
      handle: 'viewer',
      name: 'Viewer',
      access: 'viewer',
    });
    const { ws, events } = await connect({ cookie: viewerCookie });
    await waitFor(events, ofType('hello'));
    ws.send(JSON.stringify({ type: 'terminal_attach', sessionId }));
    await waitFor(events, ofType('terminal_snapshot'));
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
      (draft) => {
        draft.team.members = draft.team.members.filter((m) => m.handle !== 'viewer');
        return 'Remove viewer';
      },
    );
    h.runner.emit({ type: 'terminal_data', sessionId, data: 'private after removal' });
    ws.send(JSON.stringify({ type: 'terminal_input', sessionId, data: 'x' }));
    await waitFor(events, ofType('error'));
    expect(events.some((e) => e.type === 'terminal_data')).toBe(false);
    expect(h.runner.input).toEqual([]);

    const owner = await connect();
    await waitFor(owner.events, ofType('hello'));
    owner.ws.send(JSON.stringify({ type: 'terminal_attach', sessionId }));
    await waitFor(owner.events, ofType('terminal_snapshot'));
    await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    h.runner.emit({ type: 'terminal_data', sessionId, data: 'private after logout' });
    owner.ws.send(JSON.stringify({ type: 'terminal_input', sessionId, data: 'y' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(owner.events.some((e) => e.type === 'terminal_data')).toBe(false);
    expect(h.runner.input).toEqual([]);
  });

  it('lets a client watch a terminal like a viewer, but not type into it (PM-79)', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks',
      headers: { cookie },
      payload: { title: 'Example' },
    });
    const started = await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks/AR-1/start',
      headers: { cookie },
      payload: {},
    });
    const sessionId = started.json<TaskDetail>().sessions[0]!.id;
    const clientCookie = await addHumanAndLogin(h.app, { handle: 'cecil', name: 'Cecil', access: 'client' });
    const { ws, events } = await connect({ cookie: clientCookie });
    await waitFor(events, ofType('hello'));
    ws.send(JSON.stringify({ type: 'terminal_attach', sessionId }));
    await waitFor(events, ofType('terminal_snapshot'));
    h.runner.emit({ type: 'terminal_data', sessionId, data: 'visible output' });
    await waitFor(events, ofType('terminal_data'));
    ws.send(JSON.stringify({ type: 'terminal_input', sessionId, data: 'x' }));
    await waitFor(events, ofType('error'));
    expect(h.runner.input).toEqual([]);
  });

  it('lets an admin watch the Operator’s terminal but only the owner type into it (PM-475)', async () => {
    const sent = await h.app.inject({
      method: 'POST',
      url: routes.sendTeamMessage('AR'),
      headers: { cookie },
      payload: { to: ['operator'], text: 'Hello' },
    });
    expect(sent.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    const session = await waitForSession(h.app.projectman.domain, { member: 'operator' });
    const adminCookie = await addHumanAndLogin(h.app, { handle: 'ada', name: 'Ada', access: 'admin' });

    const admin = await connect({ cookie: adminCookie });
    await waitFor(admin.events, ofType('hello'));
    admin.ws.send(JSON.stringify({ type: 'terminal_attach', sessionId: session.id }));
    await waitFor(admin.events, ofType('terminal_snapshot'));
    admin.ws.send(JSON.stringify({ type: 'terminal_input', sessionId: session.id, data: 'rm -rf' }));
    await waitFor(admin.events, ofType('error'));
    expect(h.runner.input).toEqual([]);

    const owner = await connect();
    await waitFor(owner.events, ofType('hello'));
    owner.ws.send(JSON.stringify({ type: 'terminal_attach', sessionId: session.id }));
    await waitFor(owner.events, ofType('terminal_snapshot'));
    owner.ws.send(JSON.stringify({ type: 'terminal_input', sessionId: session.id, data: 'y\r' }));
    const deadline = Date.now() + 1000;
    while (h.runner.input.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(h.runner.input).toEqual([{ sessionId: session.id, data: 'y\r' }]);
  });

  it('tells the runner a terminal has no viewer left only when the last viewer leaves (PM-312)', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks',
      headers: { cookie },
      payload: { title: 'Example' },
    });
    const started = await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks/AR-1/start',
      headers: { cookie },
      payload: {},
    });
    const sessionId = started.json<TaskDetail>().sessions[0]!.id;
    const attach = JSON.stringify({ type: 'terminal_attach', sessionId });
    const detach = JSON.stringify({ type: 'terminal_detach', sessionId });
    const first = await connect();
    const second = await connect();
    await waitFor(first.events, ofType('hello'));
    await waitFor(second.events, ofType('hello'));

    // The screen comes from the runner's attach, for each viewer.
    first.ws.send(attach);
    await waitFor(first.events, ofType('terminal_snapshot'));
    second.ws.send(attach);
    await waitFor(second.events, ofType('terminal_snapshot'));
    expect(h.runner.attached).toEqual([sessionId, sessionId]);

    // With two viewers the first one's departure is not the last.
    first.ws.send(detach);
    second.ws.send(JSON.stringify({ type: 'terminal_input', sessionId, data: 'still here' }));
    await vi.waitFor(() => expect(h.runner.input).toEqual([{ sessionId, data: 'still here' }]));
    expect(h.runner.detached).toEqual([]);

    // The second one's is: a detach, and a repeated detach says nothing more.
    second.ws.send(detach);
    second.ws.send(detach);
    await vi.waitFor(() => expect(h.runner.detached).toEqual([sessionId]));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.runner.detached).toEqual([sessionId]);

    // A viewer that only closes its socket counts as leaving too.
    first.ws.send(attach);
    await vi.waitFor(() => expect(h.runner.attached).toHaveLength(3));
    first.ws.terminate();
    await vi.waitFor(() => expect(h.runner.detached).toEqual([sessionId, sessionId]));
  });

  it('looks up the login only for deliveries to subscribers, once per delivery', async () => {
    const { ws, events } = await connect();
    await waitFor(events, ofType('hello'));
    const resolve = vi.spyOn(h.app.projectman.auth, 'resolve');
    const publish = async (version: string) => {
      h.app.projectman.domain.bus.publish({ type: 'config_changed', projectKey: 'AR', version });
      await new Promise((settled) => setTimeout(settled, 20));
    };
    await publish('v1');
    expect(resolve).not.toHaveBeenCalled();
    ws.send(JSON.stringify({ type: 'subscribe_project', projectKey: 'AR' }));
    ws.send('not json');
    await waitFor(events, ofType('error'));
    resolve.mockClear();
    await publish('v2');
    expect(events.filter((e) => e.type === 'config_changed')).toEqual([
      { type: 'config_changed', projectKey: 'AR', version: 'v2' },
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('streams fetched provider usage and changed members to project subscribers', async () => {
    const { ws, events } = await connect();
    await waitFor(events, ofType('hello'));
    ws.send(JSON.stringify({ type: 'subscribe_project', projectKey: 'AR' }));
    // Wait for a command processed after subscription so no event can race the setup.
    ws.send('not json');
    await waitFor(events, ofType('error'));
    const hired = await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/members',
      headers: { cookie },
      payload: { role: 'qa', provider: 'codex' },
    });
    const changed = await waitFor(events, ofType('member_changed'));
    expect(changed).toMatchObject({ handle: hired.json().handle, member: { provider: 'codex', kind: 'ai' } });
    await h.app.inject({ method: 'GET', url: '/api/projects/AR/board', headers: { cookie } });
    await waitFor(
      events,
      (e): e is Extract<ServerEvent, { type: 'plan_usage' }> =>
        e.type === 'plan_usage' && e.provider === 'codex',
    );
    expect(events.filter((e) => e.type === 'plan_usage')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectKey: 'AR', provider: 'claude', usage: null }),
        expect.objectContaining({ projectKey: 'AR', provider: 'codex', usage: null }),
      ]),
    );
  });

  it('sends a client the same task events as any member, without a read per connection', async () => {
    const clientCookie = await addHumanAndLogin(h.app, {
      handle: 'client',
      name: 'Client',
      access: 'client',
    });
    const created = await h.app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers: { cookie },
      payload: { title: 'Shared' },
    });
    const task = created.json<Task>();
    const connections = await Promise.all([
      connect({ cookie: clientCookie }),
      connect({ cookie: clientCookie }),
      connect(),
    ]);
    for (const { ws, events } of connections) {
      ws.send(JSON.stringify({ type: 'subscribe_project', projectKey: 'AR' }));
      ws.send('not json');
      await waitFor(events, ofType('error'));
    }
    const find = vi.spyOn(h.app.projectman.domain.tasks, 'find');
    const event = {
      type: 'task_upserted' as const,
      projectKey: 'AR',
      task: {
        ...task,
        links: [
          { kind: 'prerequisite' as const, ref: task.key },
          { kind: 'prerequisite' as const, ref: 'AR-999' },
        ],
      },
    };
    h.app.projectman.domain.bus.publish(event);
    for (const { events } of connections) await waitFor(events, ofType('task_upserted'));
    // A client gets the event as the owner does: nothing is read or cut per connection (PM-79).
    expect(find).not.toHaveBeenCalled();
    for (const { events } of connections) expect(events.find(ofType('task_upserted'))).toEqual(event);
    h.app.projectman.domain.bus.publish({
      type: 'task_attachments_changed',
      projectKey: 'AR',
      taskKey: task.key,
    });
    for (const { events } of connections) await waitFor(events, ofType('task_attachments_changed'));
    expect(find).not.toHaveBeenCalled();
  });

  it.each(['https://evil.example', 'http://localhost:5173', 'https://localhost:4700'])(
    'closes foreign-origin sockets (%s) and sends nothing for unsubscribed projects',
    async (origin) => {
      let closeCode = 0;
      const closed = new Promise<void>((resolve) => {
        void h.app.injectWS(
          '/ws',
          { headers: { cookie, origin, host: 'localhost:4700' } },
          {
            onInit: (socket) =>
              socket.on('close', (code: number) => {
                closeCode = code;
                resolve();
              }),
          },
        );
      });
      await closed;
      expect(closeCode).toBe(1008);

      const { events } = await connect({ cookie, origin: 'http://localhost:5173', host: 'localhost:5173' });
      await waitFor(events, ofType('hello'));
      await h.app.inject({
        method: 'POST',
        url: '/api/projects/AR/tasks',
        headers: { cookie },
        payload: { title: 'Quiet' },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(events.some((e) => e.type === 'task_upserted')).toBe(false);
    },
  );
});
