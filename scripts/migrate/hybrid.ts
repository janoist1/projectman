import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../../apps/server/src/db';
import { LIVE_SESSION_STATES, newMachineKey } from '../../apps/server/src/domain';
import {
  cloudOrigin,
  ENGINE_CONFIG_FILE,
  ENGINE_KEY_FILE,
  ENGINE_STATUS_FILE,
  EngineConfig,
  EngineConfigError,
  loadEngineConfig,
} from '../../apps/server/src/engine-link/engine-config';
import { readEngineStatus } from '../../apps/server/src/engine-link/engine-status';
import { instanceRole } from '../../apps/server/src/instance';
import { backupDatabase, databaseFiles, snapshotDatabase } from './database';
import { isGitRepository } from './git';
import { HYBRID_CLOUD_ENTRIES, HYBRID_NEVER_CARRIED } from './hybrid-entries';
import { processAlive } from './instance';
import { buildInventory, readProjectFiles } from './inventory';
import type { Finding, Inventory } from './inventory';
import { assertSafeOutput, MigrationRefused, PACKAGE_VERSION, sha256File, walkFiles } from './package';
import type { PackageManifest } from './package';
import { verifyHome } from './verify';

/**
 * The move to the hybrid mode and back (PM-318, part of PM-286). The Mac keeps its home (the same real
 * path, so the instance tag, the worktrees and the CLI transcripts keep working) and runs only the
 * engine on it; a package of the closed list `HYBRID_CLOUD_ENTRIES` goes to the cloud. Three commands:
 *
 *   plan     read-only: what goes where, what stays
 *   package  the cloud's `home/`, plus `engine.key` and `engine.json` written in the Mac's home
 *   back     the cloud's data replaces the Mac's home (the old entries are moved aside, never deleted)
 *
 * The machine key is made here, on the Mac, and only its hash goes into the package.
 */

const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} kB`
      : `${bytes} B`;

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------------
// engine.json from the projects

export interface EngineProjects {
  projects: EngineConfig['projects'];
  repos: EngineConfig['repos'];
  /** What was left out of the engine's configuration, and why. */
  warnings: string[];
}

/**
 * The projects and repositories the engine on this Mac serves, read from the customization repository.
 * A workspace or repository that does not exist here, or a repository outside its workspace, is left
 * out with a warning (the engine would refuse it at its start).
 */
export function engineProjects(home: string): EngineProjects {
  const projects: EngineProjects['projects'] = [];
  const repos: EngineProjects['repos'] = [];
  const warnings: string[] = [];
  const projectShape = EngineConfig.shape.projects.element;
  const repoShape = EngineConfig.shape.repos.element;
  for (const project of readProjectFiles(home)) {
    const entry = { project: project.key, workspacePath: project.workspacePath };
    if (!projectShape.safeParse(entry).success || !isDirectory(project.workspacePath)) {
      warnings.push(`project ${project.key}: the workspace ${project.workspacePath} is not usable here`);
      continue;
    }
    projects.push(entry);
    for (const repo of project.repos) {
      const subject = `repository ${project.key}/${repo.name}`;
      if (!inside(project.workspacePath, repo.path)) {
        warnings.push(`${subject}: ${repo.path} is outside the workspace`);
        continue;
      }
      if (!existsSync(repo.path)) {
        warnings.push(`${subject}: ${repo.path} does not exist here`);
        continue;
      }
      let fullTestCommand = repo.fullTestCommand;
      if (fullTestCommand !== undefined && fullTestCommand.length > 500) {
        warnings.push(`${subject}: the full test command is longer than 500 characters, left out`);
        fullTestCommand = undefined;
      }
      const item = {
        project: project.key,
        repo: repo.name,
        path: repo.path,
        ...(fullTestCommand ? { fullTestCommand } : {}),
      };
      if (!repoShape.safeParse(item).success) {
        warnings.push(`${subject}: the name or the settings do not fit the engine's configuration`);
        continue;
      }
      repos.push(item);
    }
  }
  return { projects, repos, warnings };
}

// ---------------------------------------------------------------------------------------------------
// plan

export interface HybridPlan {
  inventory: Inventory;
  /** What goes into the cloud's home, with the sizes. */
  carried: { name: string; bytes: number }[];
  /** What stays on the Mac. */
  stays: { name: string; bytes: number; why: string }[];
  engine: EngineProjects;
}

const DATABASE_SIDE_FILES = ['db.sqlite-wal', 'db.sqlite-shm'];

/** Read-only: safe on a running source. */
export async function buildHybridPlan(options: { home: string; now?: () => Date }): Promise<HybridPlan> {
  const home = resolve(options.home);
  const inventory = await buildInventory({ home, now: options.now });
  const carried: HybridPlan['carried'] = [];
  const stays: HybridPlan['stays'] = [];
  for (const entry of inventory.entries) {
    if ((HYBRID_CLOUD_ENTRIES as readonly string[]).includes(entry.name))
      carried.push({ name: entry.name, bytes: entry.bytes });
    else if (!DATABASE_SIDE_FILES.includes(entry.name))
      stays.push({
        name: entry.name,
        bytes: entry.bytes,
        why: HYBRID_NEVER_CARRIED[entry.name] ?? 'not on the list of what the cloud carries',
      });
  }
  return { inventory, carried, stays, engine: engineProjects(home) };
}

export function renderHybridPlan(plan: HybridPlan): string {
  const { inventory } = plan;
  const out: string[] = [];
  out.push(`# Hybrid move: ${inventory.home}`, '');
  out.push(
    'Read-only: nothing was changed. The cloud gets a copy of the database, the secrets, the customization',
    'repository, the attachments and the memory; everything that is the Mac (repositories, worktrees,',
    'CLI homes, logs) stays where it is, and the engine on the Mac works in it.',
    '',
  );
  const findings = inventory.findings.filter((f: Finding) => f.severity !== 'info');
  if (findings.length > 0) {
    out.push('## Findings', '');
    for (const f of findings)
      out.push(`- ${f.severity.toUpperCase()} [${f.code}] ${f.subject}: ${f.message}`);
    out.push('');
  }
  out.push('## Goes to the cloud (`home/` of the package)', '');
  for (const item of plan.carried) out.push(`- ${item.name} (${sizeText(item.bytes)})`);
  out.push(
    '',
    'The database is a consistent copy: an engine is registered in it (its key hash only) and every session',
    "moves to that engine. `repos/`, `work/` and `transcripts/` are not made: the Mac's repositories and",
    'transcripts do not move.',
    '',
  );
  out.push('## Stays on the Mac', '');
  for (const item of plan.stays) out.push(`- ${item.name} (${sizeText(item.bytes)}): ${item.why}`);
  out.push('');
  out.push("## The engine's configuration (`engine.json`)", '');
  if (plan.engine.projects.length === 0) out.push('- no project can be served from this Mac');
  for (const project of plan.engine.projects) {
    out.push(`- ${project.project}: workspace ${project.workspacePath}`);
    for (const repo of plan.engine.repos.filter((r) => r.project === project.project))
      out.push(
        `  - ${repo.repo}: ${repo.path}${repo.fullTestCommand ? ` (full test: ${repo.fullTestCommand})` : ''}`,
      );
  }
  for (const warning of plan.engine.warnings) out.push(`- WARNING ${warning}`);
  out.push(
    '',
    '## Next',
    '',
    '1. Stop projectman on the Mac.',
    '2. `npm run migrate -- hybrid package --home <home> --out <dir> --engine-name <name> --cloud <https://…>`',
    '3. Upload `<dir>/home/` to the cloud volume, `npm run migrate -- verify --home <volume copy> --hybrid-cloud` there.',
    '4. `npm run migrate -- instance engine --home <home>`, then `npm run engine -- start` (or `service install`).',
    '',
    'The whole order, the dry run and the way back: `docs/HYBRID.md`.',
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// package

export interface HybridPackageOptions {
  home: string;
  out: string;
  engineName: string;
  cloudUrl: string;
  now?: () => Date;
}

export interface HybridPackageResult {
  manifest: PackageManifest;
  engine: { id: string; name: string };
  /** Where the machine key was written (its content is never returned or printed). */
  keyFile: string;
  configFile: string;
  /** Sessions whose engine moved from `local` to the new engine. */
  sessionsMoved: number;
  warnings: string[];
}

const earliestUser = (db: Database.Database): string | null =>
  (db.prepare('SELECT id FROM users ORDER BY created_at, rowid LIMIT 1').get() as { id: string } | undefined)
    ?.id ?? null;

/**
 * The cloud's package of a stopped home. Writes into the home only `engine.key` and `engine.json`, both
 * new files that are never overwritten; on any failure the package is removed and so is a file just
 * written.
 */
export async function createHybridPackage(options: HybridPackageOptions): Promise<HybridPackageResult> {
  const home = resolve(options.home);
  const out = resolve(options.out);
  const name = options.engineName.trim();
  if (name.length < 1 || name.length > 64)
    throw new MigrationRefused('the engine name must be 1 to 64 characters');
  try {
    cloudOrigin(options.cloudUrl);
  } catch (error) {
    throw new MigrationRefused(error instanceof EngineConfigError ? error.message : String(error));
  }
  assertSafeOutput(home, out);
  mkdirSync(dirname(out), { recursive: true });
  if (await isGitRepository(dirname(out)))
    throw new MigrationRefused(`${out} lies inside a git repository: a secret package never goes into one`);

  const role = instanceRole(home);
  if (role === 'retired' || role === 'engine')
    throw new MigrationRefused(
      `${home} is ${role}: only an active or standby home is moved to the hybrid mode`,
    );
  const keyFile = join(home, ENGINE_KEY_FILE);
  const configFile = join(home, ENGINE_CONFIG_FILE);
  for (const file of [keyFile, configFile])
    if (existsSync(file)) throw new MigrationRefused(`${file} exists already: it is never overwritten`);

  const inventory = await buildInventory({ home, now: options.now });
  const blockers = inventory.findings.filter((f) => f.severity === 'blocker');
  if (blockers.length > 0)
    throw new MigrationRefused(`the source has ${blockers.length} blocking findings`, blockers);

  const identity = newMachineKey();
  const projects = engineProjects(home);
  const config = EngineConfig.parse({
    schemaVersion: 1,
    cloudUrl: options.cloudUrl,
    engineId: identity.id,
    name,
    projects: projects.projects,
    repos: projects.repos,
  });

  const written: string[] = [];
  try {
    mkdirSync(out, { recursive: true, mode: 0o700 });
    chmodSync(out, 0o700);
    const homeOut = join(out, 'home');
    mkdirSync(homeOut, { mode: 0o700 });

    // --- the closed list of entries
    for (const entry of HYBRID_CLOUD_ENTRIES) {
      if (entry === 'db.sqlite' || !existsSync(join(home, entry))) continue;
      cpSync(join(home, entry), join(homeOut, entry), {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    }
    if (existsSync(join(homeOut, 'secret'))) chmodSync(join(homeOut, 'secret'), 0o600);
    const notCarried: PackageManifest['notCarried'] = [];
    for (const entry of inventory.entries)
      if (
        !(HYBRID_CLOUD_ENTRIES as readonly string[]).includes(entry.name) &&
        !DATABASE_SIDE_FILES.includes(entry.name)
      )
        notCarried.push({ name: entry.name, bytes: entry.bytes });

    // --- the database: a consistent copy, prepared for the engine
    const snapshot = snapshotDatabase(home);
    try {
      await backupDatabase(snapshot.db, join(homeOut, 'db.sqlite'));
    } finally {
      snapshot.dispose();
    }
    let sessionsMoved = 0;
    const db = new Database(join(homeOut, 'db.sqlite'));
    try {
      db.pragma('foreign_keys = ON');
      migrate(db);
      const registry = createRepositories(db).engines;
      if (registry.list().length > 0)
        throw new MigrationRefused('the database has engines already: it is not a single-machine database');
      const userId = earliestUser(db);
      if (!userId) throw new MigrationRefused('the database has no account to register the engine under');
      registry.create({
        id: identity.id,
        name,
        hash: identity.hash,
        prefix: identity.prefix,
        userId,
        at: (options.now?.() ?? new Date()).toISOString(),
      });
      sessionsMoved = db
        .prepare("UPDATE sessions SET engine_id = ? WHERE engine_id = 'local'")
        .run(identity.id).changes;
      // One self-contained file: the cloud's server turns the log mode on itself.
      db.pragma('journal_mode = DELETE');
    } finally {
      db.close();
    }
    chmodSync(join(homeOut, 'db.sqlite'), 0o600);

    // --- manifest and checksums
    const files: PackageManifest['files'] = {};
    for (const path of walkFiles(out))
      files[relative(out, path).split(sep).join('/')] = {
        sha256: await sha256File(path),
        bytes: lstatSync(path).size,
      };
    const manifest: PackageManifest = {
      version: PACKAGE_VERSION,
      kind: 'hybrid_cloud',
      engine: { id: identity.id, name },
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      sourceHome: home,
      sourcePlatform: process.platform,
      sourceSchemaVersion: inventory.database.schemaVersion ?? 0,
      buildSchemaVersion: LATEST_SCHEMA_VERSION,
      repos: [],
      work: [],
      transcripts: [],
      notCarried,
      files,
    };
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    // --- the Mac's two new files, last: the key (shown nowhere) and the engine's configuration
    writeFileSync(keyFile, `${identity.key}\n`, { mode: 0o600, flag: 'wx' });
    written.push(keyFile);
    chmodSync(keyFile, 0o600);
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    written.push(configFile);

    return {
      manifest,
      engine: { id: identity.id, name },
      keyFile,
      configFile,
      sessionsMoved,
      warnings: projects.warnings,
    };
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    for (const file of written) rmSync(file, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------
// back

export interface HybridBackOptions {
  home: string;
  /** The cloud's data directory as downloaded (its `/data`). */
  from: string;
  /** The person's statement that the cloud is stopped: no more writes there. */
  confirmCloudStopped: boolean;
  now?: () => Date;
  /** For tests: whether a process is alive (default: signal 0). */
  isRunning?: (pid: number) => boolean;
}

export interface HybridBackReport {
  engineId: string;
  /** The folder the Mac's former entries were moved into. */
  archive: string;
  /** Sessions of this engine that are `local` again. */
  sessionsMoved: number;
  /** Of those, the ones that were not closed when the cloud stopped (the first start resumes or ends them). */
  liveSessions: number;
}

/** Entries of the Mac's home the cloud's data replaces, and the engine's own files that go with them. */
const REPLACED_ENTRIES = [
  'db.sqlite',
  'db.sqlite-wal',
  'db.sqlite-shm',
  'secret',
  'secrets',
  'customization',
  'attachments',
  'memory',
  ENGINE_CONFIG_FILE,
  ENGINE_KEY_FILE,
  ENGINE_STATUS_FILE,
  'attachments-cache',
];

function archiveName(home: string, now: Date): string {
  const base = `pre-hybrid-${now.toISOString().slice(0, 10)}`;
  let name = base;
  for (let n = 2; existsSync(join(home, name)); n += 1) name = `${base}-${n}`;
  return name;
}

/**
 * The way back (PM-318): the cloud's data becomes the Mac's home again. The old entries are moved to
 * `pre-hybrid-<date>/`, never deleted. The role marker stays `engine`; `instance activate` ends it.
 */
export async function hybridBack(options: HybridBackOptions): Promise<HybridBackReport> {
  const home = resolve(options.home);
  const from = resolve(options.from);
  const now = options.now?.() ?? new Date();
  if (!existsSync(home)) throw new MigrationRefused(`no such home directory: ${home}`);
  if (instanceRole(home) !== 'engine')
    throw new MigrationRefused(`${home} is not a hybrid engine home (mark it with: instance engine)`);
  let engineId: string;
  try {
    engineId = loadEngineConfig(home).engineId;
  } catch (error) {
    throw new MigrationRefused(error instanceof Error ? error.message : String(error));
  }
  if (!options.confirmCloudStopped)
    throw new MigrationRefused(
      'say that the cloud is stopped and its data is the final one: --confirm-source-retired',
    );
  const status = readEngineStatus(join(home, ENGINE_STATUS_FILE));
  if (status && (options.isRunning ?? processAlive)(status.pid))
    throw new MigrationRefused(
      `the engine is running (pid ${status.pid}): stop it (and uninstall its service) first`,
    );
  if (from === home || inside(home, from) || inside(from, home))
    throw new MigrationRefused('the downloaded data and the home must be separate directories');

  const verified = await verifyHome({ home: from, checkPaths: false, hybridCloud: true });
  const blockers = verified.findings.filter((f) => f.severity === 'blocker');
  if (blockers.length > 0)
    throw new MigrationRefused(`the downloaded data has ${blockers.length} blocking findings`, blockers);

  // --- stage the replacement inside the home (the same volume: the final moves are renames)
  const stage = join(home, `.hybrid-back-${randomBytes(4).toString('hex')}`);
  mkdirSync(stage, { mode: 0o700 });
  const staged: string[] = [];
  let sessionsMoved = 0;
  let liveSessions = 0;
  try {
    for (const entry of HYBRID_CLOUD_ENTRIES) {
      if (entry === 'db.sqlite' || !existsSync(join(from, entry))) continue;
      cpSync(join(from, entry), join(stage, entry), {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      staged.push(entry);
    }
    if (existsSync(join(stage, 'secret'))) chmodSync(join(stage, 'secret'), 0o600);
    const snapshot = snapshotDatabase(from);
    try {
      await backupDatabase(snapshot.db, join(stage, 'db.sqlite'));
    } finally {
      snapshot.dispose();
    }
    staged.push('db.sqlite');
    chmodSync(join(stage, 'db.sqlite'), 0o600);

    const db = new Database(join(stage, 'db.sqlite'));
    try {
      db.pragma('foreign_keys = ON');
      const engine = createRepositories(db).engines.get(engineId);
      if (!engine) throw new MigrationRefused(`the downloaded data does not know this engine (${engineId})`);
      const live = LIVE_SESSION_STATES.map(() => '?').join(', ');
      const foreign = db
        .prepare(
          `SELECT id, engine_id FROM sessions WHERE engine_id NOT IN (?, 'local') AND state IN (${live})`,
        )
        .all(engineId, ...LIVE_SESSION_STATES) as { id: string; engine_id: string }[];
      if (foreign.length > 0)
        throw new MigrationRefused(
          `${foreign.length} sessions are still open on another engine (${[...new Set(foreign.map((s) => s.engine_id))].join(', ')}): end them in the cloud first`,
        );
      const userId = earliestUser(db);
      if (!userId) throw new MigrationRefused('the downloaded data has no account');
      liveSessions = Number(
        (
          db
            .prepare(`SELECT count(*) AS n FROM sessions WHERE engine_id = ? AND state IN (${live})`)
            .get(engineId, ...LIVE_SESSION_STATES) as { n: number }
        ).n,
      );
      sessionsMoved = db
        .prepare("UPDATE sessions SET engine_id = 'local' WHERE engine_id = ?")
        .run(engineId).changes;
      createRepositories(db).engines.revoke(engineId, userId, now.toISOString());
      db.pragma('journal_mode = DELETE');
    } finally {
      db.close();
    }
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }

  // --- move the old entries aside, then the staged ones into place; undo it all if a move fails
  const archive = archiveName(home, now);
  const archiveDir = join(home, archive);
  mkdirSync(archiveDir, { mode: 0o700 });
  const aside: string[] = [];
  const placed: string[] = [];
  try {
    const present = new Set([...REPLACED_ENTRIES.filter((name) => existsSync(join(home, name)))]);
    for (const name of databaseFiles(home)) present.add(name);
    for (const name of present) {
      renameSync(join(home, name), join(archiveDir, name));
      aside.push(name);
    }
    for (const name of staged) {
      renameSync(join(stage, name), join(home, name));
      placed.push(name);
    }
  } catch (error) {
    for (const name of placed) renameSync(join(home, name), join(stage, name));
    for (const name of aside) renameSync(join(archiveDir, name), join(home, name));
    rmSync(stage, { recursive: true, force: true });
    if (readdirSync(archiveDir).length === 0) rmSync(archiveDir, { recursive: true, force: true });
    throw error;
  }
  rmSync(stage, { recursive: true, force: true });
  return { engineId, archive: archiveDir, sessionsMoved, liveSessions };
}
