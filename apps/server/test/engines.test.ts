import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EngineId as EngineIdSchema, LOCAL_ENGINE_ID } from '@projectman/shared';
import type { EngineId, MemberHandle, Session } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db';
import type { EngineDirectory, EngineHost } from '../src/contracts';
import { createLocalEngine, engineIdOf, engineOption, LocalEngineDirectory } from '../src/domain/engines';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { capturingLogger, FakeWorktreeManager } from './helpers/fakes';

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

  function host(id: EngineId, workspace: string): EngineHost {
    const worktrees = new FakeWorktreeManager(join(root, id, 'worktrees'));
    worktreesOf[id] = worktrees;
    const engine = createLocalEngine(
      {
        worktrees,
        workspacePath: () => workspace,
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
