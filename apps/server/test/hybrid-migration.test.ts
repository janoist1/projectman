import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPackage } from '../../../scripts/migrate/apply';
import {
  buildHybridPlan,
  createHybridPackage,
  hybridBack,
  renderHybridPlan,
} from '../../../scripts/migrate/hybrid';
import type { HybridPackageResult } from '../../../scripts/migrate/hybrid';
import { activateHome, engineHome, instanceStatus } from '../../../scripts/migrate/instance';
import { MigrationRefused, readPackage } from '../../../scripts/migrate/package';
import { verifyHome } from '../../../scripts/migrate/verify';
import { buildApp } from '../src/app';
import { createRepositories } from '../src/db';
import { machineKeyHash } from '../src/domain';
import { loadEngineConfig } from '../src/engine-link/engine-config';
import { instanceRole } from '../src/instance';
import { createFakeMcp, createFakeRunnerModule, FakeGithub } from './helpers/fakes';
import { createSourceHome } from './helpers/migration-source';
import type { SourceHome } from './helpers/migration-source';

/**
 * The move to the hybrid mode and back (PM-318): the cloud's package holds only the closed list of
 * entries, the machine key is made on the Mac and only its hash travels, and the cloud's data can
 * replace the Mac's home again with the old entries kept aside.
 */

// Each test builds a real home, repositories and a package: slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const CLOUD_URL = 'https://projectman.example.test';
const AT = new Date('2026-10-09T10:00:00.000Z');

let src: SourceHome;
let out: string;
let result: HybridPackageResult;
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  src = await createSourceHome();
  await src.stop();
  out = join(src.root, 'cloud-package');
  result = await createHybridPackage({
    home: src.home,
    out,
    engineName: 'MacBook',
    cloudUrl: CLOUD_URL,
    now: () => AT,
  });
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  await src.cleanup();
});

const mode = (file: string) => statSync(file).mode & 0o777;
const dbRows = <T>(home: string, sql: string, ...params: unknown[]): T[] => {
  const db = new Database(join(home, 'db.sqlite'), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
};
/** The cloud's volume as the person downloads it: a copy of the package's `home/`, private. */
const cloudData = (name = 'cloud-data'): string => {
  const dir = join(src.root, name);
  cpSync(join(out, 'home'), dir, { recursive: true, verbatimSymlinks: true });
  chmodSync(dir, 0o700);
  return dir;
};
const withCloudDb = <T>(data: string, change: (db: Database.Database) => T): T => {
  const db = new Database(join(data, 'db.sqlite'));
  db.pragma('foreign_keys = ON');
  try {
    return change(db);
  } finally {
    db.close();
  }
};
/** A conversation the cloud's engine ran after the move. */
const addCloudSession = (data: string, id: string, state: 'exited' | 'working', engineId: string) =>
  withCloudDb(data, (db) => {
    createRepositories(db).sessions.insert({
      id,
      projectKey: 'AR',
      // One conversation per member and work item: each added session has a member of its own.
      member: `member-${id}`,
      workItem: { type: 'general' },
      claudeSessionId: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
      provider: 'claude',
      cwd: src.workspace,
      branch: null,
      transcriptPath: null,
      state,
      activity: null,
      startedAt: AT.toISOString(),
      lastActivityAt: AT.toISOString(),
      endedAt: state === 'exited' ? AT.toISOString() : null,
      engineId,
    });
  });
const writeEngineStatus = (pid: number) =>
  writeFileSync(
    join(src.home, 'engine-status.json'),
    JSON.stringify({
      pid,
      bootId: 'boot',
      startedAt: AT.toISOString(),
      updatedAt: AT.toISOString(),
      connection: 'connected',
      attempts: 0,
      pendingEvents: 0,
      droppedEvents: 0,
      running: [],
    }),
  );

describe('the cloud package', () => {
  it('carries the closed list only, and says what stays on the Mac', async () => {
    const entries = readdirSync(join(out, 'home')).sort();
    expect(entries).toEqual(['attachments', 'customization', 'db.sqlite', 'memory', 'secret']);
    expect(readdirSync(out).sort()).toEqual(['home', 'manifest.json']);

    const manifest = await readPackage(out);
    expect(manifest).toMatchObject({
      kind: 'hybrid_cloud',
      engine: { id: result.engine.id, name: 'MacBook' },
      repos: [],
      work: [],
      transcripts: [],
    });
    const notCarried = manifest.notCarried.map((e) => e.name);
    expect(notCarried).toEqual(expect.arrayContaining(['worktrees', 'github-publish']));
    expect(notCarried).not.toEqual(expect.arrayContaining(['db.sqlite', 'secret', 'customization']));
    expect(mode(join(out, 'home', 'db.sqlite'))).toBe(0o600);
    expect(mode(join(out, 'home', 'secret'))).toBe(0o600);
    expect(existsSync(join(out, 'home', 'db.sqlite-wal'))).toBe(false);
  });

  it('registers the engine as the default and moves every session to it', () => {
    const data = join(out, 'home');
    const engines = dbRows<{ id: string; name: string; is_default: number; key_hash: string }>(
      data,
      'SELECT id, name, is_default, key_hash FROM engines',
    );
    expect(engines).toHaveLength(1);
    expect(engines[0]).toMatchObject({ id: result.engine.id, name: 'MacBook', is_default: 1 });
    const sessions = dbRows<{ id: string; engine_id: string }>(data, 'SELECT id, engine_id FROM sessions');
    expect(sessions.map((s) => s.id).sort()).toEqual(['ses_claude', 'ses_codex', 'ses_lost']);
    expect(sessions.every((s) => s.engine_id === result.engine.id)).toBe(true);
    expect(result.sessionsMoved).toBe(3);
    // The source is only read.
    expect(
      dbRows<{ engine_id: string }>(src.home, 'SELECT engine_id FROM sessions').map((s) => s.engine_id),
    ).toEqual(['local', 'local', 'local']);
  });

  it('keeps the machine key on the Mac: the package holds its hash only', () => {
    const key = readFileSync(join(src.home, 'engine.key'), 'utf8').trim();
    expect(key).toMatch(/^pme_[A-Za-z0-9_-]{43}$/);
    expect(mode(join(src.home, 'engine.key'))).toBe(0o600);
    expect(dbRows<{ key_hash: string }>(join(out, 'home'), 'SELECT key_hash FROM engines')[0]!.key_hash).toBe(
      machineKeyHash(key),
    );
    const stack = [out];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) stack.push(path);
        else expect(readFileSync(path).includes(key), path).toBe(false);
      }
    }
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('writes an engine.json the engine accepts, built from the projects', () => {
    expect(mode(join(src.home, 'engine.json'))).toBe(0o600);
    const config = loadEngineConfig(src.home);
    expect(config).toMatchObject({
      schemaVersion: 1,
      cloudUrl: CLOUD_URL,
      engineId: result.engine.id,
      name: 'MacBook',
      projects: [{ project: 'AR', workspacePath: src.workspace }],
      repos: [{ project: 'AR', repo: 'web', path: src.workspace }],
    });
  });

  it('never overwrites the key or the configuration, and leaves nothing behind when it refuses', async () => {
    const key = readFileSync(join(src.home, 'engine.key'), 'utf8');
    const config = readFileSync(join(src.home, 'engine.json'), 'utf8');
    await expect(
      createHybridPackage({
        home: src.home,
        out: join(src.root, 'second'),
        engineName: 'Other',
        cloudUrl: CLOUD_URL,
      }),
    ).rejects.toThrow(/exists already/);
    expect(existsSync(join(src.root, 'second'))).toBe(false);
    expect(readFileSync(join(src.home, 'engine.key'), 'utf8')).toBe(key);
    expect(readFileSync(join(src.home, 'engine.json'), 'utf8')).toBe(config);
  });

  it('refuses an insecure cloud address and a package inside the home', async () => {
    const fresh = await createSourceHome();
    try {
      await fresh.stop();
      await expect(
        createHybridPackage({
          home: fresh.home,
          out: join(fresh.root, 'p'),
          engineName: 'Mac',
          cloudUrl: 'http://cloud.example.test',
        }),
      ).rejects.toBeInstanceOf(MigrationRefused);
      await expect(
        createHybridPackage({
          home: fresh.home,
          out: join(fresh.home, 'p'),
          engineName: 'Mac',
          cloudUrl: CLOUD_URL,
        }),
      ).rejects.toBeInstanceOf(MigrationRefused);
      expect(existsSync(join(fresh.home, 'engine.key'))).toBe(false);
      expect(existsSync(join(fresh.home, 'engine.json'))).toBe(false);
    } finally {
      await fresh.cleanup();
    }
  });

  it('is no package for `apply`', async () => {
    await expect(
      applyPackage({ packageDir: out, targetHome: join(src.root, 'elsewhere'), mappings: [] }),
    ).rejects.toThrow(/hybrid/);
  });
});

describe('plan', () => {
  it('lists what goes to the cloud and what stays, without any content', async () => {
    const fresh = await createSourceHome();
    try {
      await fresh.stop();
      const sheet = renderHybridPlan(await buildHybridPlan({ home: fresh.home }));
      expect(sheet).toContain('## Goes to the cloud');
      expect(sheet).toContain('- db.sqlite');
      expect(sheet).toContain('## Stays on the Mac');
      expect(sheet).toContain('- github-publish');
      expect(sheet).toContain(`AR: workspace ${fresh.workspace}`);
      expect(existsSync(join(fresh.home, 'engine.key'))).toBe(false);
    } finally {
      await fresh.cleanup();
    }
  });
});

describe('verify --hybrid-cloud', () => {
  const codes = async (home: string) =>
    (await verifyHome({ home, checkPaths: true, hybridCloud: true })).findings
      .filter((f) => f.severity === 'blocker')
      .map((f) => f.code);

  it('passes the package without asking for the Mac’s paths', async () => {
    const data = cloudData();
    expect(await verifyHome({ home: data, checkPaths: true, hybridCloud: true })).toMatchObject({ ok: true });
  });

  it('does not look for the workspace and the repositories, which are not on the cloud machine', async () => {
    const data = cloudData();
    rmSync(src.workspace, { recursive: true, force: true });
    expect(await verifyHome({ home: data, checkPaths: true, hybridCloud: true })).toMatchObject({ ok: true });
    expect((await verifyHome({ home: data, checkPaths: true })).findings.map((f) => f.code)).toContain(
      'workspace_missing',
    );
  });

  it('names an entry that must stay on the Mac', async () => {
    const data = cloudData();
    mkdirSync(join(data, 'providers'));
    writeFileSync(join(data, 'engine.key'), 'pme_x\n', { mode: 0o600 });
    expect(await codes(data)).toEqual(['forbidden_entry', 'forbidden_entry']);
  });

  it('tolerates the empty folders the cloud’s own server makes, not a file in them', async () => {
    const data = cloudData();
    for (const name of ['worktrees', 'workspaces', 'spool', 'engine-spool']) mkdirSync(join(data, name));
    expect(await codes(data)).toEqual([]);
    writeFileSync(join(data, 'worktrees', 'leak'), 'a worktree file');
    expect(await codes(data)).toEqual(['forbidden_entry']);
  });

  it('wants exactly one default engine and an engine for every session', async () => {
    const data = cloudData();
    withCloudDb(data, (db) => db.prepare('UPDATE engines SET is_default = 0').run());
    expect(await codes(data)).toEqual(['default_engine']);
    withCloudDb(data, (db) => db.prepare('UPDATE engines SET is_default = 1').run());
    withCloudDb(data, (db) => db.prepare("UPDATE sessions SET engine_id = 'eng_000000000000'").run());
    expect(await codes(data)).toEqual(['session_engine_missing']);
    withCloudDb(data, (db) => db.prepare("UPDATE sessions SET engine_id = 'local'").run());
    expect(await codes(data)).toEqual(['session_engine_missing']);
  });
});

describe('the engine role', () => {
  it('is set only on a home that has the engine’s files, and ends only with the cloud stopped', async () => {
    expect(instanceRole(src.home)).toBe('active');
    engineHome(src.home, 'hybrid', AT);
    expect(instanceRole(src.home)).toBe('engine');
    expect(instanceStatus(src.home)).toContain('engine since');

    expect(() => activateHome({ home: src.home })).toThrow(/cloud is stopped/);
    // The database is still the stale one from before the move: its changes would be lost.
    expect(() => activateHome({ home: src.home, confirmSourceRetired: true })).toThrow(
      /not the cloud's data/,
    );
    activateHome({ home: src.home, confirmSourceRetired: true, discardCloudData: true });
    expect(instanceRole(src.home)).toBe('active');
  });

  it('refuses a home without the engine’s files', async () => {
    const fresh = await createSourceHome();
    try {
      await fresh.stop();
      expect(() => engineHome(fresh.home, 'hybrid')).toThrow(/engine\.key|engine\.json/);
      expect(instanceRole(fresh.home)).toBe('active');
    } finally {
      await fresh.cleanup();
    }
  });

  it('is not activated while the engine runs', () => {
    engineHome(src.home, 'hybrid', AT);
    writeEngineStatus(4242);
    expect(() =>
      activateHome({
        home: src.home,
        confirmSourceRetired: true,
        discardCloudData: true,
        isRunning: () => true,
      }),
    ).toThrow(/engine is running/);
  });
});

describe('the way back', () => {
  const back = (data: string, extra: Partial<Parameters<typeof hybridBack>[0]> = {}) =>
    hybridBack({
      home: src.home,
      from: data,
      confirmCloudStopped: true,
      now: () => AT,
      isRunning: () => false,
      ...extra,
    });

  it('puts the cloud’s data in place, keeps the old entries aside and ends the hybrid role', async () => {
    const data = cloudData();
    addCloudSession(data, 'ses_cloud', 'exited', result.engine.id);
    addCloudSession(data, 'ses_cloud_live', 'working', result.engine.id);
    writeFileSync(join(data, 'memory', 'cloud-note.md'), 'written in the cloud\n');
    engineHome(src.home, 'hybrid', AT);
    const oldKey = readFileSync(join(src.home, 'engine.key'), 'utf8');

    const report = await back(data);

    expect(report).toMatchObject({ engineId: result.engine.id, sessionsMoved: 5, liveSessions: 1 });
    expect(report.archive).toBe(join(src.home, 'pre-hybrid-2026-10-09'));
    for (const name of [
      'db.sqlite',
      'secret',
      'customization',
      'attachments',
      'memory',
      'engine.json',
      'engine.key',
    ])
      expect(existsSync(join(report.archive, name)), name).toBe(true);
    expect(readFileSync(join(report.archive, 'engine.key'), 'utf8')).toBe(oldKey);
    // The Mac's home has the cloud's data and no engine files.
    expect(readFileSync(join(src.home, 'memory', 'cloud-note.md'), 'utf8')).toContain('cloud');
    expect(existsSync(join(src.home, 'engine.key'))).toBe(false);
    expect(existsSync(join(src.home, 'engine.json'))).toBe(false);
    expect(existsSync(join(src.home, 'worktrees'))).toBe(true);
    expect(readdirSync(src.home).filter((n) => n.startsWith('.hybrid-back'))).toEqual([]);
    expect(mode(join(src.home, 'db.sqlite'))).toBe(0o600);
    // The sessions are local again, the engine is revoked.
    expect(
      dbRows<{ engine_id: string }>(src.home, 'SELECT DISTINCT engine_id FROM sessions').map(
        (s) => s.engine_id,
      ),
    ).toEqual(['local']);
    expect(
      dbRows<{ revoked_at: string | null; is_default: number }>(
        src.home,
        'SELECT revoked_at, is_default FROM engines',
      ),
    ).toEqual([{ revoked_at: AT.toISOString(), is_default: 0 }]);
    // Nothing starts until the person says the cloud is retired.
    expect(instanceRole(src.home)).toBe('engine');
    activateHome({ home: src.home, confirmSourceRetired: true });
    expect(instanceRole(src.home)).toBe('active');
  });

  it('is a round trip: the single-machine server starts on it with the same cards and sessions', async () => {
    const data = cloudData();
    addCloudSession(data, 'ses_cloud', 'exited', result.engine.id);
    engineHome(src.home, 'hybrid', AT);
    await back(data);
    activateHome({ home: src.home, confirmSourceRetired: true });

    const runner = createFakeRunnerModule();
    const app = await buildApp({
      home: src.home,
      logger: false,
      modules: {
        createRunnerModule: (opts) => runner.create(opts),
        createMcpModule: (opts) => createFakeMcp().create(opts),
        github: new FakeGithub(),
      },
    });
    apps.push(app);
    await app.ready();
    const { db } = app.projectman.repos;
    expect(
      (db.prepare('SELECT id FROM sessions ORDER BY id').all() as { id: string }[]).map((s) => s.id),
    ).toEqual(['ses_claude', 'ses_cloud', 'ses_codex', 'ses_lost']);
    expect((db.prepare('SELECT key FROM tasks').all() as { key: string }[]).map((t) => t.key)).toEqual([
      src.taskKey,
    ]);
  });

  it('refuses without the statement that the cloud is stopped, and changes nothing', async () => {
    const data = cloudData();
    engineHome(src.home, 'hybrid', AT);
    const before = readdirSync(src.home).sort();
    await expect(back(data, { confirmCloudStopped: false })).rejects.toThrow(/cloud is stopped/);
    expect(readdirSync(src.home).sort()).toEqual(before);
  });

  it('refuses while the engine runs', async () => {
    const data = cloudData();
    engineHome(src.home, 'hybrid', AT);
    writeEngineStatus(4242);
    await expect(back(data, { isRunning: (pid) => pid === 4242 })).rejects.toThrow(/engine is running/);
  });

  it('refuses a home that is not an engine home', async () => {
    await expect(back(cloudData())).rejects.toThrow(/not a hybrid engine home/);
  });

  it('refuses data that does not pass the hybrid check', async () => {
    const data = cloudData();
    mkdirSync(join(data, 'providers'));
    engineHome(src.home, 'hybrid', AT);
    await expect(back(data)).rejects.toThrow(/blocking findings/);
    expect(existsSync(join(src.home, 'pre-hybrid-2026-10-09'))).toBe(false);
  });

  it('refuses data that does not know this engine', async () => {
    const data = cloudData();
    withCloudDb(data, (db) => {
      db.pragma('foreign_keys = OFF');
      db.prepare("UPDATE sessions SET engine_id = 'eng_bbbbbbbbbbbb'").run();
      db.prepare("UPDATE engines SET id = 'eng_bbbbbbbbbbbb'").run();
    });
    engineHome(src.home, 'hybrid', AT);
    await expect(back(data)).rejects.toThrow(/does not know this engine/);
    expect(
      readdirSync(src.home).filter((n) => n.startsWith('pre-hybrid') || n.startsWith('.hybrid')),
    ).toEqual([]);
  });

  it('refuses a session still open on another engine', async () => {
    const data = cloudData();
    withCloudDb(data, (db) => {
      db.prepare(
        "INSERT INTO engines (id, name, key_hash, key_prefix, is_default, created_by, created_at) SELECT 'eng_cccccccccccc', 'Other', 'h', 'pme_other', 0, id, ? FROM users LIMIT 1",
      ).run(AT.toISOString());
    });
    addCloudSession(data, 'ses_elsewhere', 'working', 'eng_cccccccccccc');
    engineHome(src.home, 'hybrid', AT);
    await expect(back(data)).rejects.toThrow(/still open on another engine/);
    expect(existsSync(join(src.home, 'pre-hybrid-2026-10-09'))).toBe(false);
    expect(existsSync(join(src.home, 'engine.key'))).toBe(true);
  });

  it('does not reuse an archive folder', async () => {
    const data = cloudData();
    engineHome(src.home, 'hybrid', AT);
    mkdirSync(join(src.home, 'pre-hybrid-2026-10-09'));
    const report = await back(data);
    expect(report.archive).toBe(join(src.home, 'pre-hybrid-2026-10-09-2'));
  });
});
