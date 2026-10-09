import type { IncomingHttpHeaders } from 'node:http';
import type { Socket as NetSocket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateEngineResponse } from '@projectman/shared';
import { routes } from '@projectman/shared';
import { decodeFrame, encodeFrame } from '../src/engine-link';
import type { EngineFrame, Hello } from '../src/engine-link';
import { createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER, OWNER_ACTOR } from './helpers/domain-harness';

/**
 * The whole cloud composition (PM-315, `PROJECTMAN_MODE=cloud`) over a fake engine on the real link
 * endpoint: nothing of the machine runs in this process, so a card runs, the agent's team tools come back
 * through the link, and an engine that drops and comes back is reconciled. The real engine process and the
 * fake CLIs in one process are the `*.integration.test.ts` kind and need a pseudo-terminal.
 */

interface Socket {
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'close', listener: (code: number) => void): void;
}

const WORKSPACE = '/fictional/engine/workspaces/AR';
const helloOf = (over: Partial<Hello> = {}): Hello => ({
  t: 'hello',
  protocol: 1,
  version: 'test-version',
  hostname: 'fake-engine',
  platform: 'darwin',
  paths: {
    userHome: '/fictional/user',
    home: '/fictional/engine',
    worktreesRoot: '/fictional/engine/worktrees',
    workspacesRoot: null,
    installDir: null,
    sessionFoldersRoot: '/fictional/engine/folders',
    sessionTmpRoot: null,
    claudeTmpRoots: [],
    browsersDir: null,
    heavyLockDir: null,
    gitExcludesFile: null,
  },
  projects: [{ project: 'AR', workspacePath: WORKSPACE }],
  repos: [{ project: 'AR', repo: 'web', fullTest: false }],
  providers: [{ provider: 'claude', available: true, version: '1' }],
  running: [],
  nextSeq: 1,
  instanceTag: '0123456789abcdef',
  pid: 42,
  uid: 501,
  bootId: 'aaaaaaaaaaaaaaaa',
  ...over,
});

const upgradeContext = (headers: IncomingHttpHeaders = {}) => ({
  socket: { remoteAddress: '127.0.0.1' } as NetSocket,
  headers: { host: 'localhost', ...headers },
});

type Answer = (params: any) => unknown;

const workspaceOf = (key: { member: string; repoName: string }) => {
  const path = `/fictional/engine/members/${key.member}/${key.repoName}`;
  return { path, gitDir: `${path}/.git`, cacheDir: `${path}/.cache`, tempDir: `${path}/.tmp` };
};

describe('the cloud composition with a fake engine', () => {
  let h: AppHarness;
  let cookie: string;
  let key: string;
  let engineId: string;
  const sockets: Socket[] = [];

  /** The engine's answers by method; the engine's `running` list is what it reports on connect. */
  const answers = new Map<string, Answer>();
  const asked: Array<{ method: string; params: any }> = [];
  const running: Array<{ sessionId: string; pid: number; state: 'idle'; cols: number; rows: number }> = [];

  beforeEach(async () => {
    answers.clear();
    asked.length = 0;
    running.length = 0;
    const defaults: Record<string, Answer> = {
      'host.is_directory': () => true,
      'host.free_disk': () => null,
      'host.prepare_member_sandbox_dir': () => null,
      'host.prepare_portable_paths': () => null,
      'host.realpath': ([]) => null,
      'worktree.find': () => null,
      'worktree.head': () => null,
      'worktree.status': () => ({ dirty: false, unpushedCommits: 0 }),
      'worktree.refreshDependencies': () => ({ status: 'skipped', reason: 'disabled' }),
      'worktree.ensureForTask': ([input]) => ({
        path: `/fictional/engine/worktrees/AR/${input.taskKey}/${input.repoName}`,
        branch: `task/${input.taskKey}`,
        repo: input.repoName,
      }),
      'workspace.location': ([key]) => workspaceOf(key),
      'workspace.ensure': ([key]) => ({ ...workspaceOf(key), created: false }),
      'workspace.home': ([input]) => `/fictional/engine/members/${input.member}`,
      'workspace.status': () => ({
        dirty: false,
        operation: null,
        checkout: { branch: 'main', head: 'c0ffee' },
      }),
      'workspace.sourceHead': () => null,
      'workspace.fetchBase': () => ({ branch: 'main', commit: 'c0ffee' }),
      'workspace.findTaskBranch': () => null,
      'workspace.resolveSource': () => null,
      'workspace.checkoutTaskBranch': ([, input]) => ({ branch: input.branch, head: 'c0ffee' }),
      'workspace.checkoutReview': () => ({ branch: null, head: 'c0ffee' }),
      'provider.status': ({ provider }) => ({
        provider,
        loggedIn: true,
        method: 'subscription',
        checkedAt: new Date().toISOString(),
      }),
      'session.assert_workspace_config': () => null,
      'folders.make': () => null,
      'folders.remove': () => null,
      'folders.sweep': () => [],
      'folders.release_tmp_root': () => null,
      'session.start': (spec) => {
        const info = {
          sessionId: spec.sessionId,
          pid: 100 + running.length,
          state: 'idle' as const,
          cols: 80,
          rows: 24,
        };
        running.push(info);
        return info;
      },
      'session.stop': (params) => {
        const at = running.findIndex((item) => item.sessionId === params.sessionId);
        if (at >= 0) running.splice(at, 1);
        return null;
      },
    };
    for (const [method, answer] of Object.entries(defaults)) answers.set(method, answer);
    h = await createAppHarness({
      now: () => new Date(),
      real: { mcp: true },
      app: { engineMode: 'cloud', appVersion: 'test-version', claudeTmpRoots: [] },
    });
    cookie = await setupOwner(h.app);
    const created = await inject(h.app, 'POST', routes.engines(), cookie, { name: 'Office' });
    key = (created.json() as CreateEngineResponse).key;
    engineId = (created.json() as CreateEngineResponse).engine.id;
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await h.close();
    vi.restoreAllMocks();
  });

  /** A connected engine: answers every request from `answers`, records them, and can send frames. */
  const connect = async (greeting: Hello = helloOf({ running: [...running] })) => {
    const frames: EngineFrame[] = [];
    let closed: number | undefined;
    const ws = (await h.app.injectWS(
      routes.engineLink(),
      upgradeContext({ authorization: `Bearer ${key}` }),
      {
        onInit: (raw) => {
          const socket = raw as unknown as Socket;
          socket.on('message', (data) => {
            const frame = decodeFrame(data);
            frames.push(frame);
            if (frame.t !== 'req') return;
            asked.push({ method: frame.method, params: frame.params });
            const answer = answers.get(frame.method);
            if (!answer) {
              socket.send(
                encodeFrame({
                  t: 'res',
                  id: frame.id,
                  ok: false,
                  error: {
                    code: 'unknown_method',
                    message: `The fake engine has no answer for ${frame.method}`,
                  },
                }),
              );
              return;
            }
            Promise.resolve(answer(frame.params)).then(
              (result) => socket.send(encodeFrame({ t: 'res', id: frame.id, ok: true, result })),
              (err: Error) =>
                socket.send(
                  encodeFrame({
                    t: 'res',
                    id: frame.id,
                    ok: false,
                    error: { code: 'internal', message: err.message },
                  }),
                ),
            );
          });
          socket.on('close', (code) => {
            closed = code;
          });
        },
      },
    )) as unknown as Socket;
    sockets.push(ws);
    ws.send(encodeFrame(greeting));
    await vi.waitFor(() => expect(frames.some((frame) => frame.t === 'welcome')).toBe(true));
    let seq = greeting.nextSeq;
    let calls = 0;
    const call = async (method: string, params: unknown) => {
      const id = `fake-${++calls}`;
      ws.send(encodeFrame({ t: 'req', id, method, params }));
      await vi.waitFor(() => expect(frames.some((frame) => frame.t === 'res' && frame.id === id)).toBe(true));
      const reply = frames.find((frame) => frame.t === 'res' && frame.id === id);
      if (reply?.t !== 'res') throw new Error('no reply');
      return reply;
    };
    return {
      ws,
      frames,
      closed: () => closed,
      call,
      emit: (event: Extract<EngineFrame, { t: 'evt' }>['event']) =>
        ws.send(encodeFrame({ t: 'evt', seq: seq++, event })),
    };
  };

  const createProjectThroughEngine = async () => {
    const engine = await connect();
    await createProject(h, cookie);
    return engine;
  };
  const startCard = async () => {
    await h.app.projectman.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.app.projectman.domain.taskStarts.start('AR', 'AR-1', {
      assignee: 'dev-1',
      actor: OWNER_ACTOR,
      author: OWNER,
    });
  };
  const started = () => asked.filter((item) => item.method === 'session.start');

  it('starts a card on the engine, with the agent token and the engine’s own paths', async () => {
    await createProjectThroughEngine();
    await startCard();
    expect(started()).toHaveLength(1);
    const spec = started()[0]!.params;
    expect(spec.mcpToken).toMatch(/\S+/);
    expect(spec).not.toHaveProperty('mcpUrl');
    expect(spec.cwd.startsWith('/fictional/engine/')).toBe(true);
    const session = h.app.projectman.domain.sessions.list('AR')[0]!;
    expect(session).toMatchObject({ member: 'dev-1', engineId: expect.stringMatching(/^eng_/) });
    expect(h.app.projectman.domain.engineCounters(session.engineId!).runningSessions).toBe(1);
  });

  it('answers the agent’s team tool request relayed by the engine, and refuses it for another token', async () => {
    const engine = await createProjectThroughEngine();
    await startCard();
    const token = started()[0]!.params.mcpToken as string;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const relayed = await engine.call('mcp.relay', {
      token,
      contentType: 'application/json',
      accept: 'application/json, text/event-stream',
      body,
    });
    expect(relayed).toMatchObject({ ok: true, result: { status: 200 } });
    const refused = await engine.call('mcp.relay', {
      token: 'not-a-token',
      contentType: 'application/json',
      accept: 'application/json, text/event-stream',
      body,
    });
    expect(refused).toMatchObject({ ok: true, result: { status: 404 } });
  });

  it('shows the live session of an engine that dropped as ended after it comes back without it', async () => {
    const engine = await createProjectThroughEngine();
    await startCard();
    const { domain } = h.app.projectman;
    const session = domain.sessions.list('AR')[0]!;
    engine.ws.terminate();
    await vi.waitFor(() => expect(engine.closed()).toBeDefined());

    // The engine restarted meanwhile: it reports nothing running.
    running.length = 0;
    await connect(helloOf({ running: [], bootId: 'bbbbbbbbbbbbbbbb' }));
    await vi.waitFor(() => expect(domain.sessions.get('AR', session.id).state).toBe('exited'));
    expect(domain.engineCounters(session.engineId!).runningSessions).toBe(0);
  });

  it('shows the machine display of the default engine, and says there is none without one', async () => {
    answers.set('machine.snapshot', () => ({
      cpu: null,
      cores: 8,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      memoryPressure: null,
      loadAverage: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
      uptimeSeconds: null,
    }));
    answers.set('machine.processes', () => null);
    await createProjectThroughEngine();
    const shown = await inject(h.app, 'GET', routes.machine(), cookie);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(asked.some((item) => item.method === 'machine.snapshot')).toBe(true);

    // The only engine is revoked: there is no machine to show.
    await inject(h.app, 'POST', routes.revokeEngine(engineId), cookie);
    const without = await inject(h.app, 'GET', routes.machine(), cookie);
    expect(without.statusCode).toBe(409);
    expect(without.json()).toMatchObject({ error: { code: 'engine_offline' } });
  });

  it('keeps a start waiting while no engine is there and starts it when an engine connects', async () => {
    const first = await createProjectThroughEngine();
    const { domain } = h.app.projectman;
    await domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    first.ws.terminate();
    await vi.waitFor(() => expect(first.closed()).toBeDefined());
    await inject(h.app, 'POST', routes.revokeEngine(engineId), cookie);

    // The developer's engine is not there: the start waits, and says why.
    await domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await vi.waitFor(() =>
      expect(domain.tasks.get('AR', 'AR-1').startWaiting).toMatchObject({ reason: 'engine_offline' }),
    );
    expect(started()).toHaveLength(0);

    // Another engine connects with its own key: the start goes on without anyone asking again.
    const created = await inject(h.app, 'POST', routes.engines(), cookie, { name: 'Laptop' });
    const { engine: second } = created.json() as CreateEngineResponse;
    key = (created.json() as CreateEngineResponse).key;
    await inject(h.app, 'POST', routes.defaultEngine(second.id), cookie);
    await connect(helloOf({ bootId: 'cccccccccccccccc' }));
    await vi.waitFor(() => expect(started()).toHaveLength(1));
    await vi.waitFor(() => expect(domain.tasks.get('AR', 'AR-1').startWaiting).toBeUndefined());
    expect(domain.tasks.get('AR', 'AR-1').assignee).not.toBeNull();
  });

  it('keeps a session that the reconnected engine still runs', async () => {
    const engine = await createProjectThroughEngine();
    await startCard();
    const { domain } = h.app.projectman;
    const session = domain.sessions.list('AR')[0]!;
    engine.ws.terminate();
    await vi.waitFor(() => expect(engine.closed()).toBeDefined());

    await connect(helloOf({ running: [...running], bootId: 'bbbbbbbbbbbbbbbb' }));
    await vi.waitFor(() =>
      expect(h.app.projectman.engineRegistry!.status().some((item) => item.online)).toBe(true),
    );
    expect(domain.sessions.get('AR', session.id).state).not.toBe('exited');
  });
});
