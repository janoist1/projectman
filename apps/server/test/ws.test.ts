import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent, TaskDetail } from '@projectman/shared';
import {
  addHumanAndLogin,
  createAppHarness,
  createProject,
  OWNER_LOGIN,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

interface TestSocket {
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
}

function collectInto(ws: TestSocket, events: ServerEvent[]): void {
  ws.on('message', (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
}

async function waitFor<T extends ServerEvent>(
  events: ServerEvent[],
  predicate: (e: ServerEvent) => e is T,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`event not received; got ${events.map((e) => e.type).join(', ')}`);
}

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
