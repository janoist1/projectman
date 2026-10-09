import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EngineId as EngineIdSchema, LOCAL_ENGINE_ID } from '@projectman/shared';
import type { EngineId, MemberHandle, Session } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db';
import { MEMBER_SANDBOX_DIRS, SANDBOX_GIT_CONFIG, SANDBOX_GIT_CONFIG_FILE } from '../src/contracts';
import type {
  EngineDirectory,
  EngineHost,
  EngineSessionFolders,
  FullTestExecutor,
  ScreenshotExecutor,
  ScreenshotRunSpec,
} from '../src/contracts';
import { DomainError } from '../src/domain/errors';
import { createLocalEngine, engineIdOf, engineOption, LocalEngineDirectory } from '../src/domain/engines';
import { memberSandboxDir } from '../src/domain/session-policy';
import { waitFor } from '../src/runner/test-helpers';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { capturingLogger, FakeWorktreeManager, settle } from './helpers/fakes';

/**
 * PM-311: the engine, the machine a session runs on. One engine (`local`) changes nothing; a second
 * engine is a test double here, as PM-310 will make real ones.
 */

const GB = 1024 ** 3;
const REMOTE: EngineId = 'eng_abcdefghijkl';
const task = { type: 'task', taskKey: 'AR-1' } as const;

describe('the engine id', () => {
  it('is `local` or `eng_` and twelve lowercase letters or digits', () => {
    expect(LOCAL_ENGINE_ID).toBe('local');
    for (const ok of ['local', 'eng_abcdefghijkl', 'eng_0123456789ab'])
      expect(EngineIdSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', 'Local', 'eng_short', 'eng_ABCDEFGHIJKL', 'eng_abcdefghijklm', 'remote'])
      expect(EngineIdSchema.safeParse(bad).success, bad).toBe(false);
  });

  it('is `local` for a session from before engines, and left out of a runner call for the local engine', () => {
    expect(engineIdOf({})).toBe(LOCAL_ENGINE_ID);
    expect(engineIdOf({ engineId: REMOTE })).toBe(REMOTE);
    expect(engineOption(LOCAL_ENGINE_ID)).toEqual({});
    expect(engineOption(REMOTE)).toEqual({ engineId: REMOTE });
  });
});

describe('the local engine', () => {
  const logger = capturingLogger().logger;
  const worktrees = new FakeWorktreeManager('/tmp/fictional-worktrees');

  it('is the one engine of a single-machine installation, always connected', () => {
    const engine = createLocalEngine({ worktrees, workspacePath: (key) => `/work/${key}` }, logger);
    const directory = new LocalEngineDirectory(engine);

    expect(directory.get(LOCAL_ENGINE_ID)).toBe(engine);
    expect(directory.get(REMOTE)).toBeNull();
    expect(directory.ids()).toEqual([LOCAL_ENGINE_ID]);
    expect(directory.engineFor('AR', 'dev-1')).toBe(LOCAL_ENGINE_ID);
    expect(engine.workspacePath('AR')).toBe('/work/AR');
    expect(directory.onChange(() => {})()).toBeUndefined();
  });

  it('answers with the places it was given, and none for what it was not', () => {
    const bare = createLocalEngine(
      { worktrees, workspacePath: () => null, userHome: '/home/u' },
      logger,
    ).paths();
    expect(bare).toMatchObject({
      userHome: '/home/u',
      home: null,
      worktreesRoot: null,
      workspacesRoot: null,
      installDir: null,
      sessionFoldersRoot: null,
      sessionTmpRoot: null,
      browsersDir: null,
      heavyLockDir: null,
    });

    const given = createLocalEngine(
      {
        worktrees,
        workspacePath: () => null,
        appHome: '/home/u/.pm',
        worktreesRootDir: '/home/u/.pm/worktrees',
        installDir: '/opt/pm',
        browsersDir: '/home/u/.pm/browsers',
        heavyLockDir: '/tmp/pm-heavy',
        claudeTmpRoots: ['/tmp/claude-1'],
      },
      logger,
    ).paths();
    expect(given).toMatchObject({
      home: '/home/u/.pm',
      worktreesRoot: '/home/u/.pm/worktrees',
      installDir: '/opt/pm',
      browsersDir: '/home/u/.pm/browsers',
      heavyLockDir: '/tmp/pm-heavy',
      claudeTmpRoots: ['/tmp/claude-1'],
    });
  });

  it('has no session folders without a root, and no executors or member workspaces it was not given', async () => {
    const engine = createLocalEngine({ worktrees, workspacePath: () => null }, logger);
    expect(engine.sessionFolders).toBeUndefined();
    expect(engine.memberWorkspaces).toBeUndefined();
    expect(engine.fullTestExecutor).toBeUndefined();
    expect(engine.screenshotExecutor).toBeUndefined();
    expect(await engine.freeDiskBytes()).toBeNull();
    expect(engine.processExists(process.pid)).toBe(true);
  });
});

describe('the sessions table (migration 41)', () => {
  it('has `engine_id`, `local` for every session from before engines', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      const column = (
        db.prepare('PRAGMA table_info(sessions)').all() as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>
      ).find((c) => c.name === 'engine_id');
      expect(column).toMatchObject({ notnull: 1, dflt_value: "'local'" });
    } finally {
      db.close();
    }
  });
});

/** Engines that come and go, and a member who is placed on one of them. */
class TestEngines implements EngineDirectory {
  readonly hosts = new Map<EngineId, EngineHost>();
  readonly online = new Set<EngineId>();
  readonly placement = new Map<MemberHandle, EngineId | null>();
  fallback: EngineId | null = LOCAL_ENGINE_ID;
  private readonly listeners = new Set<(id: EngineId, online: boolean) => void>();

  add(host: EngineHost): void {
    this.hosts.set(host.id, host);
    this.online.add(host.id);
  }
  setOnline(id: EngineId, online: boolean): void {
    if (online) this.online.add(id);
    else this.online.delete(id);
    for (const listener of this.listeners) listener(id, online);
  }
  get(id: EngineId): EngineHost | null {
    return this.online.has(id) ? (this.hosts.get(id) ?? null) : null;
  }
  ids(): EngineId[] {
    return [...this.hosts.keys()];
  }
  engineFor(_projectKey: string, member: MemberHandle): EngineId | null {
    return this.placement.has(member) ? this.placement.get(member)! : this.fallback;
  }
  onChange(listener: (id: EngineId, online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe('sessions on engines', () => {
  let h: DomainHarness;
  let engines: TestEngines;
  let root: string;
  let free: Record<string, number | null>;
  const worktreesOf: Record<string, FakeWorktreeManager> = {};
  const logger = capturingLogger().logger;

  /** An engine that does not hold the project: its working directory is null. */
  const without = new Set<EngineId>();

  function host(id: EngineId, workspace: string): EngineHost {
    const worktrees = new FakeWorktreeManager(join(root, id, 'worktrees'));
    worktreesOf[id] = worktrees;
    const engine = createLocalEngine(
      {
        worktrees,
        workspacePath: () => (without.has(id) ? null : workspace),
        freeDiskBytes: async () => free[id] ?? null,
        worktreesRootDir: join(root, id, 'worktrees'),
      },
      logger,
    );
    return { ...engine, id };
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'pm-engines-'));
    free = {};
    without.clear();
    engines = new TestEngines();
    const localWorkspace = join(root, 'local-workspace');
    const remoteWorkspace = join(root, 'remote-workspace');
    mkdirSync(localWorkspace);
    mkdirSync(remoteWorkspace);
    engines.add(host(LOCAL_ENGINE_ID, localWorkspace));
    engines.add(host(REMOTE, remoteWorkspace));
    h = await createDomainHarness({ engines });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  const lastInput = () => h.contextBuilder.inputs[h.contextBuilder.inputs.length - 1]!;

  async function stopped(): Promise<Session> {
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: `/tmp/${session.id}.jsonl` });
    await h.domain.sessions.stop('AR', session.id);
    return session;
  }

  it('starts a session on the engine the member is placed on, and remembers it', async () => {
    engines.placement.set('dev-1', REMOTE);

    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);

    expect(session.engineId).toBe(REMOTE);
    expect(h.domain.sessions.get('AR', session.id).engineId).toBe(REMOTE);
    expect(h.repos.sessions.get(session.id)?.engineId).toBe(REMOTE);
    expect(h.runner.lastStarted().engineId).toBe(REMOTE);
    // The card's worktree is made by that engine's manager, not by the other one.
    expect(worktreesOf[REMOTE]!.calls).toEqual([{ repoName: 'web', taskKey: 'AR-1' }]);
    expect(worktreesOf[LOCAL_ENGINE_ID]!.calls).toEqual([]);
  });

  it('starts on the local engine, and tells the runner so, when nothing else is chosen', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);

    // A local session reads as it always did (no `engineId`); the column holds `local`.
    expect(session.engineId).toBeUndefined();
    expect(engineIdOf(session)).toBe(LOCAL_ENGINE_ID);
    expect(
      (
        h.repos.db.prepare('SELECT engine_id FROM sessions WHERE id = ?').get(session.id) as {
          engine_id: string;
        }
      ).engine_id,
    ).toBe(LOCAL_ENGINE_ID);
    expect(h.runner.lastStarted().engineId).toBe(LOCAL_ENGINE_ID);
  });

  it('resumes a stopped session on the same engine', async () => {
    engines.placement.set('dev-1', REMOTE);
    const session = await stopped();

    const again = await h.domain.sessions.ensureSession('AR', 'dev-1', task);

    expect(again).toMatchObject({ resumed: true, started: true });
    expect(again.session.id).toBe(session.id);
    expect(h.runner.lastStarted()).toMatchObject({ resume: true, engineId: REMOTE });
  });

  it('starts a new conversation, told it was relocated, when the member moved to another engine', async () => {
    engines.placement.set('dev-1', LOCAL_ENGINE_ID);
    const session = await stopped();
    const path = `/tmp/${session.id}.jsonl`;
    h.runnerModule.summaries.set(path, { source: 'last_replies', text: 'Login form is done.', at: null });
    engines.placement.set('dev-1', REMOTE);

    const again = await h.domain.sessions.ensureSession('AR', 'dev-1', task);

    expect(again).toMatchObject({ resumed: false, started: true });
    expect(again.session.engineId).toBe(REMOTE);
    expect(h.runner.lastStarted()).toMatchObject({ resume: false, engineId: REMOTE });
    // The old conversation is read on the engine it was written on (the local runner call has no id).
    expect(h.runnerModule.summaryReads).toEqual([{ path, opts: { provider: 'claude' } }]);
    expect(lastInput().previousConversation).toMatchObject({
      reason: 'relocated',
      fromProvider: null,
      summary: { text: 'Login form is done.' },
    });
  });

  it('reads the old conversation of a relocated session on the old engine', async () => {
    engines.placement.set('dev-1', REMOTE);
    const session = await stopped();
    const path = `/tmp/${session.id}.jsonl`;
    h.runnerModule.summaries.set(path, { source: 'last_replies', text: 'Done on the remote one.', at: null });
    engines.placement.set('dev-1', LOCAL_ENGINE_ID);

    await h.domain.sessions.ensureSession('AR', 'dev-1', task);

    expect(h.runnerModule.summaryReads).toEqual([{ path, opts: { provider: 'claude', engineId: REMOTE } }]);
    expect(lastInput().previousConversation).toMatchObject({ reason: 'relocated' });
  });

  describe('when the engine is not there', () => {
    const startCard = () =>
      h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });

    it('refuses a start with `engine_offline` and the engine, and starts once it is connected', async () => {
      engines.placement.set('dev-1', REMOTE);
      engines.setOnline(REMOTE, false);

      await expect(startCard()).rejects.toMatchObject({
        code: 'engine_offline',
        status: 409,
        details: { engine: REMOTE },
      });
      expect(h.runner.started).toEqual([]);

      engines.setOnline(REMOTE, true);
      await startCard();
      expect(h.runner.started).toHaveLength(1);
      expect(h.runner.lastStarted().engineId).toBe(REMOTE);
    });

    it('refuses a start with `engine_offline` and no engine when none is chosen for the member', async () => {
      engines.placement.set('dev-1', null);

      const err = await startCard().then(
        () => null,
        (e: unknown) => e as { code: string; details?: { engine?: string } },
      );

      expect(err).toMatchObject({ code: 'engine_offline' });
      expect(err?.details?.engine).toBeUndefined();
      expect(h.runner.started).toEqual([]);
    });

    it("refuses a start on an engine that does not hold the project, never on the server's own path", async () => {
      engines.placement.set('dev-1', REMOTE);
      without.add(REMOTE);

      await expect(startCard()).rejects.toMatchObject({
        code: 'engine_offline',
        status: 409,
        details: { engine: REMOTE },
      });
      expect(h.runner.started).toEqual([]);
    });

    it('keeps an automatic start waiting, shows why, and starts it when the engine connects', async () => {
      engines.placement.set('cr', REMOTE);
      engines.setOnline(REMOTE, false);
      await startCard();
      expect(h.runner.started).toHaveLength(1);

      // Moving the card to review starts the reviewer; its engine is not there.
      await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
      await settle();
      expect(h.runner.started).toHaveLength(1);
      expect(h.domain.tasks.get('AR', 'AR-1').startWaiting).toMatchObject({
        reason: 'engine_offline',
        engine: REMOTE,
        member: 'cr',
      });

      // The engine connects: the start goes on without anyone asking again.
      engines.setOnline(REMOTE, true);
      await waitFor(() => (h.runner.started.length === 2 ? true : undefined), {
        what: 'the reviewer starts on the engine that connected',
      });
      expect(h.runner.lastStarted()).toMatchObject({ engineId: REMOTE });
      expect(h.domain.tasks.get('AR', 'AR-1').startWaiting).toBeUndefined();
    });

    it('shows no engine in the waiting of a member who has none chosen', async () => {
      engines.placement.set('cr', null);
      await startCard();

      await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
      await settle();

      const waiting = h.domain.tasks.get('AR', 'AR-1').startWaiting;
      expect(waiting).toMatchObject({ reason: 'engine_offline', member: 'cr' });
      expect(waiting?.engine).toBeUndefined();
    });
  });

  describe('an engine that connects (PM-315)', () => {
    it('ends the sessions it does not report, keeps those it does and those still starting', async () => {
      engines.placement.set('dev-1', REMOTE);
      engines.placement.set('dev-2', REMOTE);
      const kept = (await h.domain.sessions.ensureSession('AR', 'dev-1', task)).session;
      const lost = (await h.domain.sessions.ensureSession('AR', 'dev-2', task)).session;
      expect(h.domain.engineCounters(REMOTE).runningSessions).toBe(2);

      await h.domain.sessions.reconcileEngine(REMOTE, new Set([kept.id]), () => false);
      expect(h.domain.sessions.get('AR', kept.id).state).not.toBe('exited');
      expect(h.domain.sessions.get('AR', lost.id).state).toBe('exited');
      expect(h.domain.engineCounters(REMOTE).runningSessions).toBe(1);

      // A start the cloud is still waiting for is not a lost session.
      await h.domain.sessions.reconcileEngine(REMOTE, new Set(), (id) => id === kept.id);
      expect(h.domain.sessions.get('AR', kept.id).state).not.toBe('exited');
    });

    it('does not touch the sessions of another engine', async () => {
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
      expect(session.engineId).toBeUndefined();
      await h.domain.sessions.reconcileEngine(REMOTE, new Set(), () => false);
      expect(h.domain.sessions.get('AR', session.id).state).not.toBe('exited');
      expect(h.domain.engineCounters(REMOTE).runningSessions).toBe(0);
    });

    it('stops a session it runs that the server does not know, or has ended', async () => {
      engines.placement.set('dev-1', REMOTE);
      const { session } = await stoppedOnRemote();
      await h.domain.sessions.reconcileEngine(REMOTE, new Set(['unknown-session', session.id]), () => false);
      expect(h.runner.stopped).toEqual(expect.arrayContaining(['unknown-session', session.id]));
    });

    it('sweeps the session folders of the engine for the sessions it reports', async () => {
      const swept: string[][] = [];
      const reported = new Set(['live-one']);
      const folders = {
        sweep: async (keep: (id: string) => boolean) => {
          swept.push(['live-one', 'other'].filter(keep));
          return [];
        },
        settleRemovals: async () => {},
        releaseTmpRoot: async () => {},
      };
      engines.hosts.set(REMOTE, { ...engines.hosts.get(REMOTE)!, sessionFolders: folders as never });
      await h.domain.sessions.reconcileEngine(REMOTE, reported, (id) => id === 'other');
      expect(swept).toEqual([['live-one', 'other']]);
    });

    it('holds a message for a member whose engine is not there, counts it and delivers it when the engine is back', async () => {
      engines.placement.set('cr', REMOTE);
      engines.setOnline(REMOTE, false);

      const { recipients } = await h.domain.messaging.sendReporting('AR', 'dev-1', {
        to: ['cr'],
        taskKey: 'AR-1',
        text: 'Please look at this',
      });
      expect(recipients).toEqual([{ handle: 'cr', delivery: 'held', hold: 'engine' }]);
      expect(h.domain.engineCounters(REMOTE).waitingMessages).toBe(1);
      expect(h.domain.engineCounters(LOCAL_ENGINE_ID).waitingMessages).toBe(0);
      expect(h.runner.started).toEqual([]);

      engines.setOnline(REMOTE, true);
      await waitFor(() => (h.runner.started.length === 1 ? true : undefined), {
        what: 'the member wakes on the engine that connected',
      });
      expect(h.runner.lastStarted()).toMatchObject({ engineId: REMOTE });
    });

    it('counts the starts that wait for the engine', async () => {
      engines.placement.set('cr', REMOTE);
      engines.setOnline(REMOTE, false);
      await h.domain.taskStarts.start('AR', 'AR-1', {
        assignee: 'dev-1',
        actor: OWNER_ACTOR,
        author: OWNER,
      });
      await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
      await settle();
      expect(h.domain.engineCounters(REMOTE)).toMatchObject({ waitingStarts: 1, runningSessions: 0 });
      engines.setOnline(REMOTE, true);
      await waitFor(() => (h.domain.engineCounters(REMOTE).waitingStarts === 0 ? true : undefined), {
        what: 'the waiting start is gone',
      });
    });

    it('asks its full test executor when it connects, and again only while the sandbox is missing', async () => {
      const available = vi.fn<FullTestExecutor['available']>(async () => ({
        ok: false,
        reason: 'no sandbox',
      }));
      const executor: FullTestExecutor = {
        available,
        run: async () => {
          throw new Error('not run here');
        },
      };
      engines.hosts.set(REMOTE, { ...engines.hosts.get(REMOTE)!, fullTestExecutor: executor });
      engines.setOnline(REMOTE, false);
      available.mockClear();

      engines.setOnline(REMOTE, true);
      await vi.waitFor(() => expect(available).toHaveBeenCalledTimes(1));
      engines.setOnline(REMOTE, false);
      engines.setOnline(REMOTE, true);
      await vi.waitFor(() => expect(available).toHaveBeenCalledTimes(2));

      available.mockImplementation(async () => ({ ok: true }));
      engines.setOnline(REMOTE, false);
      engines.setOnline(REMOTE, true);
      await vi.waitFor(() => expect(available).toHaveBeenCalledTimes(3));
      await settle(); // the engine is now counted as able to run the test
      engines.setOnline(REMOTE, false);
      engines.setOnline(REMOTE, true);
      await settle();
      expect(available).toHaveBeenCalledTimes(3);
    });

    async function stoppedOnRemote(): Promise<{ session: Session }> {
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
      await h.domain.sessions.stop('AR', session.id);
      return { session };
    }
  });

  describe('free disk space of the engine', () => {
    const startCard = () =>
      h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });

    it('is measured on the engine the session would start on', async () => {
      free[LOCAL_ENGINE_ID] = 50 * GB;
      free[REMOTE] = 4 * GB;

      await startCard();
      expect(h.runner.started).toHaveLength(1);

      engines.placement.set('dev-2', REMOTE);
      await h.domain.tasks.create('AR', { title: 'Second card' }, OWNER_ACTOR);
      await expect(
        h.domain.taskStarts.start('AR', 'AR-2', { assignee: 'dev-2', actor: OWNER_ACTOR, author: OWNER }),
      ).rejects.toMatchObject({ code: 'disk_low', status: 409 });
      expect(h.runner.started).toHaveLength(1);
    });
  });
});

describe("the places of the session's engine", () => {
  let h: DomainHarness;
  let root: string;
  const task = { type: 'task', taskKey: 'AR-1' } as const;

  /** A screenshot executor that records the runs it is given and ends them at once. */
  const executor = () => {
    const specs: ScreenshotRunSpec[] = [];
    const run: ScreenshotExecutor = {
      run: async (spec, _signal, started) => {
        specs.push(spec);
        started();
        return { exitCode: 0, timedOut: false, aborted: false, output: 'done' };
      },
    };
    return { run, specs };
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pm-engine-places-')));
  });
  afterEach(async () => {
    await h.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it("are the remote engine's: session folders, temporary root, queue folder and the screenshot executor", async () => {
    const logger = capturingLogger().logger;
    const remote = join(root, 'remote');
    const local = executor();
    const far = executor();
    const folders = join(remote, 'folders');
    const tmpRoot = join(remote, 'projectman-501-tmp', '0123abcd');
    const heavy = join(remote, 'projectman-501', 'heavy');
    const workspaces: Record<string, string> = {
      [LOCAL_ENGINE_ID]: join(root, 'local-workspace'),
      [REMOTE]: join(remote, 'workspace'),
    };
    for (const dir of Object.values(workspaces)) mkdirSync(dir, { recursive: true });
    const engines = new TestEngines();
    engines.add({
      ...createLocalEngine(
        {
          worktrees: new FakeWorktreeManager(join(root, 'local-worktrees')),
          workspacePath: () => workspaces[LOCAL_ENGINE_ID]!,
          screenshotExecutor: local.run,
          userHome: join(root, 'local-user'),
          claudeTmpRoots: ['/tmp/claude-local'],
        },
        logger,
      ),
      id: LOCAL_ENGINE_ID,
    });
    engines.add({
      ...createLocalEngine(
        {
          worktrees: new FakeWorktreeManager(join(remote, 'worktrees')),
          workspacePath: () => workspaces[REMOTE]!,
          screenshotExecutor: far.run,
          userHome: join(remote, 'user'),
          appHome: join(remote, 'home'),
          worktreesRootDir: join(remote, 'worktrees'),
          sessionFoldersDir: folders,
          sessionTmpDir: tmpRoot,
          heavyLockDir: heavy,
          claudeTmpRoots: ['/tmp/claude-remote'],
        },
        logger,
      ),
      id: REMOTE,
    });
    engines.placement.set('dev-1', REMOTE);
    h = await createDomainHarness({
      engines,
      adjust: (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev?.kind === 'ai') {
          dev.provider = 'codex';
          dev.permissionMode = 'acceptEdits';
        }
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);

    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);

    const spec = h.runner.lastStarted();
    const { env, tmpDir, allowWrite } = spec.sandbox!.portable!;
    const folder = env.PROJECTMAN_SESSION_DIR!;
    expect(folder.startsWith(`${folders}/`)).toBe(true);
    expect(existsSync(folder)).toBe(true);
    expect(tmpDir!.startsWith(`${tmpRoot}/`)).toBe(true);
    expect(allowWrite).toContain(join(remote, 'projectman-501'));
    // The session works in the remote engine's worktree, and the remote engine's home is its own.
    expect(spec.cwd.startsWith(join(remote, 'worktrees'))).toBe(true);
    expect(JSON.stringify(spec.sandbox)).toContain(join(remote, 'home'));
    expect(JSON.stringify(spec.sandbox)).not.toContain('local-user');

    // The screenshot run goes to the executor of the session's engine.
    if (process.platform === 'darwin') {
      mkdirSync(join(session.cwd, 'shots'), { recursive: true });
      writeFileSync(join(session.cwd, 'shots', 'login.mjs'), 'export default {};');
      const ctx = { sessionId: session.id, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' };
      await h.domain.teamTools.takeScreenshots(ctx, { scenario: 'shots/login.mjs', widths: [390] });
      await vi.waitFor(() => expect(far.specs).toHaveLength(1));
      expect(local.specs).toEqual([]);
      expect(far.specs[0]).toMatchObject({ cwd: session.cwd, sessionDir: folder });
    }

    // The folder is removed from the engine that holds it when the session ends.
    await h.runner.stop(session.id);
    await h.domain.sessions.settleFolderRemovals();
    expect(existsSync(folder)).toBe(false);
  });
});

/** PM-312: the disk work of a start is done by the session's engine; the domain only decides. */
describe("the disk work of the session's engine (PM-312)", () => {
  let h: DomainHarness;
  let root: string;
  const task = { type: 'task', taskKey: 'AR-1' } as const;
  const mode = (path: string) => statSync(path).mode & 0o777;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pm-engine-disk-')));
    mkdirSync(join(root, 'workspace'));
  });
  afterEach(async () => {
    await h.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  /** The one local engine of the harness, built from these places, with `adjust` changing the host. */
  async function open(
    places: Partial<Parameters<typeof createLocalEngine>[0]>,
    adjust: (host: EngineHost) => EngineHost = (host) => host,
  ) {
    const engines = new TestEngines();
    const host = createLocalEngine(
      {
        worktrees: new FakeWorktreeManager(join(root, 'worktrees')),
        workspacePath: () => join(root, 'workspace'),
        ...places,
      },
      capturingLogger().logger,
    );
    engines.add(adjust({ ...host, id: LOCAL_ENGINE_ID }));
    h = await createDomainHarness({ engines });
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
  }

  it("makes the member's sandbox directory 0700 and its git settings 0600 on the engine", async () => {
    const appHome = join(root, 'home');
    mkdirSync(appHome);
    await open({ appHome, userHome: join(root, 'user') });

    await h.domain.sessions.ensureSession('AR', 'dev-1', task);

    const dir = memberSandboxDir(appHome, 'AR', 'dev-1');
    for (const sub of MEMBER_SANDBOX_DIRS) expect(mode(join(dir, sub.name)), sub.name).toBe(0o700);
    const settings = join(dir, SANDBOX_GIT_CONFIG_FILE);
    expect(mode(settings)).toBe(0o600);
    expect(readFileSync(settings, 'utf8')).toBe(SANDBOX_GIT_CONFIG);
    // The sandbox of the process points at what the engine made.
    expect(JSON.stringify(h.runner.lastStarted().sandbox)).toContain(dir);
  });

  it('stops the start with `session_start_failed` and the stage when the engine cannot make it', async () => {
    const appHome = join(root, 'home');
    mkdirSync(appHome);
    await open({ appHome, userHome: join(root, 'user') }, (host) => ({
      ...host,
      prepareMemberSandboxDir: async () => {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      },
    }));

    const started = h.domain.sessions.ensureSession('AR', 'dev-1', task);

    await expect(started).rejects.toBeInstanceOf(DomainError);
    await expect(started).rejects.toMatchObject({
      code: 'session_start_failed',
      status: 502,
      details: { stage: 'member_sandbox_dir', reason: 'ENOSPC' },
    });
    expect(h.runner.started).toEqual([]);
  });

  it("checks a new project's working directory on the engine, not on the server's disk", async () => {
    const asked: string[] = [];
    const there = new Set<string>(['/engine/only/a-project']);
    let watching = false;
    // The harness makes its own project through the real check first; the engine's answer follows.
    await open({}, (host) => ({
      ...host,
      isDirectory: async (path) => {
        if (!watching) return host.isDirectory(path);
        asked.push(path);
        return there.has(path);
      },
    }));
    watching = true;
    const create = (key: string, workspacePath: string) =>
      h.domain.projects.create({ key, name: key, workspacePath, templateId: 'test' }, OWNER);

    // A directory only the engine has is a working directory; one only the server has is not.
    await expect(create('BX', '/engine/only/a-project')).resolves.toBeDefined();
    await expect(create('BY', join(root, 'workspace'))).rejects.toMatchObject({
      code: 'workspace_not_found',
    });
    expect(asked).toEqual(['/engine/only/a-project', join(root, 'workspace')]);

    // A relative path is refused without asking the engine.
    await expect(create('BZ', 'relative/dir')).rejects.toMatchObject({ code: 'workspace_not_found' });
    expect(asked).toHaveLength(2);
  });

  it("removes a session's old folder on the engine before it makes the new one at a restart", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await open({ userHome: join(root, 'user'), sessionFoldersDir: join(root, 'folders') }, (host) => {
      const real = host.sessionFolders!;
      const folders: EngineSessionFolders = {
        root: real.root,
        tmpRoot: real.tmpRoot,
        allocate: (id) => real.allocate(id),
        allocateTmp: (id) => real.allocateTmp(id),
        of: (id) => real.of(id),
        make: async (id, dir, tmpDir) => {
          order.push('make');
          await real.make(id, dir, tmpDir);
        },
        remove: async (id) => {
          order.push('remove started');
          await gate;
          await real.remove(id);
          order.push('remove done');
        },
        sweep: (keep) => real.sweep(keep),
        releaseTmpRoot: () => real.releaseTmpRoot(),
      };
      return { ...host, sessionFolders: folders };
    });
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    const first = h.runner.lastStarted().sandbox!.portable!.env.PROJECTMAN_SESSION_DIR!;
    expect(order).toEqual(['make']);

    await h.runner.stop(session.id);
    const restarting = h.domain.sessions.ensureSession('AR', 'dev-1', task);
    // The new folder waits for the old one's removal, which the engine has not finished yet.
    await settle();
    await vi.waitFor(() => expect(order).toEqual(['make', 'remove started']));
    await settle();
    expect(order).toEqual(['make', 'remove started']);

    release();
    await restarting;
    expect(order).toEqual(['make', 'remove started', 'remove done', 'make']);
    const second = h.runner.lastStarted().sandbox!.portable!.env.PROJECTMAN_SESSION_DIR!;
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
  });
});
