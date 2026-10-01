import { execFile } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { openDatabase, schemaVersion } from '../../apps/server/src/db';
import { writeInstanceMarker } from '../../apps/server/src/instance';
import { git } from './git';
import { readPackage } from './package';
import type { PackageManifest, PackagedWork } from './package';
import type { Finding } from './inventory';
import { assertMappings, mapPath, pathGroup } from './paths';
import type { PathMapping } from './paths';
import { MigrationRefused } from './package';

/**
 * Puts a migration package on the new machine (PM-143): a home directory that starts as a **standby**
 * copy. It carries the data, the repositories (from their bundles, at the mapped paths) and the old
 * machine's uncommitted work as pending items. It never starts anything, never resumes an old
 * conversation (the history stays, the new conversation starts from the task brief and the memory)
 * and never makes itself the active instance: that is `instance activate`, a person's step.
 */

const run = promisify(execFile);

export const MIGRATED_DIR = 'migrated';
export const PENDING_WORK_FILE = 'pending-work.json';
export const APPLY_REPORT_FILE = 'report.json';

export interface ApplyOptions {
  packageDir: string;
  targetHome: string;
  /** Explicit `FROM=TO` translations of the old machine's absolute paths. */
  mappings: readonly PathMapping[];
  now?: () => Date;
}

export interface RewriteCounts {
  rewritten: number;
  unchanged: number;
}

export interface ApplyReport {
  version: 1;
  appliedAt: string;
  sourceHome: string;
  targetHome: string;
  schema: { source: number; target: number };
  mappings: PathMapping[];
  configRewrites: { project: string; from: string; to: string }[];
  databaseRewrites: Record<string, RewriteCounts>;
  reposRestored: { project: string; name: string; path: string; head: string; branches: number }[];
  reposSkipped: { project: string; name: string; sourcePath: string; reason: string }[];
  pendingWork: number;
  transcriptsCarried: number;
  sessionsNotResumed: number;
  findings: Finding[];
}

export interface PendingWork extends PackagedWork {
  /** `pending` until a person applies it into a clean checkout of the same commit; never automatic. */
  state: 'pending' | 'applied';
  appliedInto?: string;
  appliedAt?: string;
  /** Where the old path would have been on this machine, when it maps. */
  mappedPath: string | null;
}

function homeMapping(manifest: PackageManifest, targetHome: string): PathMapping {
  return { from: manifest.sourceHome, to: resolve(targetHome) };
}

/** A copy of the package into a fresh home, with the paths translated. */
export async function applyPackage(options: ApplyOptions): Promise<ApplyReport> {
  const packageDir = resolve(options.packageDir);
  const target = resolve(options.targetHome);
  assertMappings(options.mappings);
  const manifest = await readPackage(packageDir);
  if (existsSync(target) && readdirSync(target).length > 0)
    throw new MigrationRefused(`${target} exists and is not empty: the move never overwrites a home`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);

  // The old home maps onto the new one unless the person named something more specific.
  const mappings: PathMapping[] = [
    ...options.mappings,
    ...(options.mappings.some((m) => m.from === manifest.sourceHome) ? [] : [homeMapping(manifest, target)]),
  ];
  const findings: Finding[] = [];
  const unmapped = new Map<string, number>();
  const translate = (path: string): string => {
    const mapped = mapPath(path, mappings);
    if (mapped === null) {
      if (path.startsWith('/')) unmapped.set(pathGroup(path), (unmapped.get(pathGroup(path)) ?? 0) + 1);
      return path;
    }
    return mapped;
  };

  // --- the home
  cpSync(join(packageDir, 'home'), target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  chmodSync(target, 0o700);
  if (existsSync(join(target, 'secret'))) chmodSync(join(target, 'secret'), 0o600);
  chmodSync(join(target, 'db.sqlite'), 0o600);

  // --- the database: migrated by this build, then the paths
  const db = openDatabase(join(target, 'db.sqlite'));
  const databaseRewrites: Record<string, RewriteCounts> = {};
  let schemaTarget: number;
  let sessionsNotResumed = 0;
  let transcriptsCarried = 0;
  try {
    schemaTarget = schemaVersion(db);
    const rewrite = (
      name: string,
      select: string,
      update: string,
      keyOf: (row: Record<string, unknown>) => unknown[],
      column: string,
    ) => {
      const counts: RewriteCounts = { rewritten: 0, unchanged: 0 };
      const rows = db.prepare(select).all() as Record<string, unknown>[];
      const set = db.prepare(update);
      for (const row of rows) {
        const value = row[column];
        if (typeof value !== 'string' || value === '') continue;
        const next = translate(value);
        if (next === value) counts.unchanged += 1;
        else {
          set.run(next, ...keyOf(row));
          counts.rewritten += 1;
        }
      }
      databaseRewrites[name] = counts;
    };
    db.transaction(() => {
      rewrite('sessions.cwd', 'SELECT id, cwd FROM sessions', 'UPDATE sessions SET cwd = ? WHERE id = ?', (r) => [r.id], 'cwd');
      rewrite('member_workspaces.path', 'SELECT id, path FROM member_workspaces', 'UPDATE member_workspaces SET path = ? WHERE id = ?', (r) => [r.id], 'path');
      rewrite(
        'task_workspace_bindings.source_path',
        'SELECT rowid AS id, source_path FROM task_workspace_bindings WHERE source_path IS NOT NULL',
        'UPDATE task_workspace_bindings SET source_path = ? WHERE rowid = ?',
        (r) => [r.id],
        'source_path',
      );
      // A conversation's history is a file: the packaged transcript replaces the old machine's path.
      const archive = join(target, MIGRATED_DIR, 'transcripts');
      const set = db.prepare('UPDATE sessions SET transcript_path = ? WHERE id = ?');
      for (const t of manifest.transcripts) {
        const destination = join(archive, t.sessionId, basename(t.file));
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        cpSync(join(packageDir, t.file), destination);
        chmodSync(destination, 0o600);
        set.run(destination, t.sessionId);
        transcriptsCarried += 1;
      }
      // What sessions have no transcript here cannot show a history, and none resumes anyway.
      const gone = db.prepare('SELECT count(*) AS n FROM sessions WHERE transcript_path IS NOT NULL').get() as { n: number };
      sessionsNotResumed = Number(
        (db.prepare("SELECT count(*) AS n FROM sessions WHERE execution_profile = 'legacy'").get() as { n: number }).n,
      );
      if (gone.n > transcriptsCarried)
        findings.push({
          severity: 'info',
          code: 'transcripts_not_carried',
          subject: 'sessions',
          message: `${gone.n - transcriptsCarried} sessions refer to a transcript that was not on the old machine: their history stays empty`,
        });
    })();
  } finally {
    db.close();
  }
  databaseRewrites['sessions.transcript_path'] = { rewritten: transcriptsCarried, unchanged: 0 };

  // --- the configuration: the workspace path of every project, committed in the copy's history
  const configRewrites: ApplyReport['configRewrites'] = [];
  const projectsDir = join(target, 'customization', 'projects');
  if (existsSync(projectsDir)) {
    for (const key of readdirSync(projectsDir).sort()) {
      const file = join(projectsDir, key, 'project.yaml');
      if (!existsSync(file)) continue;
      const doc = parseDocument(readFileSync(file, 'utf8'));
      const old = doc.getIn(['project', 'workspacePath']);
      if (typeof old !== 'string') continue;
      const next = translate(old);
      if (next === old) continue;
      doc.setIn(['project', 'workspacePath'], next);
      writeFileSync(file, doc.toString({ lineWidth: 0 }));
      configRewrites.push({ project: key, from: old, to: next });
    }
    if (configRewrites.length > 0) {
      const env = {
        GIT_AUTHOR_NAME: 'projectman migrate',
        GIT_AUTHOR_EMAIL: 'migrate@projectman.invalid',
        GIT_COMMITTER_NAME: 'projectman migrate',
        GIT_COMMITTER_EMAIL: 'migrate@projectman.invalid',
      };
      const customization = join(target, 'customization');
      await git(customization, ['add', '-A', 'projects'], { env });
      await git(customization, ['commit', '-q', '-m', 'Move the workspace paths to the new machine (PM-143)'], { env });
    }
  }

  // --- repositories, from their bundles, at the mapped paths
  const reposRestored: ApplyReport['reposRestored'] = [];
  const reposSkipped: ApplyReport['reposSkipped'] = [];
  for (const repo of manifest.repos) {
    const path = mapPath(repo.sourcePath, mappings);
    if (path === null) {
      reposSkipped.push({ project: repo.project, name: repo.name, sourcePath: repo.sourcePath, reason: 'no path mapping covers it' });
      continue;
    }
    if (existsSync(path) && readdirSync(path).length > 0) {
      reposSkipped.push({ project: repo.project, name: repo.name, sourcePath: repo.sourcePath, reason: `${path} exists and is not empty` });
      continue;
    }
    const restored = await restoreRepository(join(packageDir, repo.bundle), path, repo);
    reposRestored.push({ project: repo.project, name: repo.name, path, head: restored.head, branches: restored.branches });
  }
  for (const skipped of reposSkipped)
    findings.push({
      severity: 'warning',
      code: 'repo_not_placed',
      subject: `${skipped.project}/${skipped.name}`,
      message: `${skipped.reason}: its bundle stays in the package and is not placed`,
    });

  // --- the old machine's uncommitted work: pending, never applied on its own
  const pending: PendingWork[] = [];
  const pendingDir = join(target, MIGRATED_DIR, 'pending-work');
  for (const w of manifest.work) {
    mkdirSync(join(pendingDir, w.id), { recursive: true, mode: 0o700 });
    if (w.archive) cpSync(join(packageDir, w.archive), join(pendingDir, w.id, 'files.tar.gz'));
    pending.push({ ...w, state: 'pending', mappedPath: mapPath(w.sourcePath, mappings) });
  }
  if (pending.length > 0)
    findings.push({
      severity: 'warning',
      code: 'pending_work',
      subject: 'work',
      message: `${pending.length} dirty checkouts and worktrees of the old machine wait as pending work (${join(MIGRATED_DIR, PENDING_WORK_FILE)}): a person assigns each to a member, or keeps it pending`,
    });
  writeFileSync(join(target, MIGRATED_DIR, PENDING_WORK_FILE), `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });

  for (const [group, count] of [...unmapped.entries()].sort())
    findings.push({
      severity: 'warning',
      code: 'unmapped_path',
      subject: group,
      message: `${count} stored paths under ${group} are not covered by a mapping and stay as they were (history of the old machine)`,
    });

  // --- a standby copy, never the active one
  writeInstanceMarker(target, 'standby', 'migrated copy: not yet released as the active instance', options.now?.());
  const report: ApplyReport = {
    version: 1,
    appliedAt: (options.now?.() ?? new Date()).toISOString(),
    sourceHome: manifest.sourceHome,
    targetHome: target,
    schema: { source: manifest.sourceSchemaVersion, target: schemaTarget },
    mappings,
    configRewrites,
    databaseRewrites,
    reposRestored,
    reposSkipped,
    pendingWork: pending.length,
    transcriptsCarried,
    sessionsNotResumed,
    findings,
  };
  writeFileSync(join(target, MIGRATED_DIR, APPLY_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(target, MIGRATED_DIR, 'manifest.json'), `${JSON.stringify({ ...manifest, files: undefined }, null, 2)}\n`, { mode: 0o600 });
  return report;
}

/** A repository at `path` made from its bundle: every branch, tag, stash and remote-tracking ref, the old checked-out branch. */
async function restoreRepository(
  bundle: string,
  path: string,
  repo: { branch: string | null; defaultBranch: string; remotes: { name: string; url: string }[] },
): Promise<{ head: string; branches: number }> {
  mkdirSync(path, { recursive: true });
  await git(path, ['init', '-q']);
  await git(path, ['fetch', '-q', '--update-head-ok', bundle, '+refs/*:refs/*']);
  const branches = (await git(path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout.split('\n').filter(Boolean);
  const wanted = [repo.branch, repo.defaultBranch, ...branches].find((b) => b && branches.includes(b));
  if (wanted) {
    await git(path, ['symbolic-ref', 'HEAD', `refs/heads/${wanted}`]);
    await git(path, ['reset', '-q', '--hard']);
  }
  for (const remote of repo.remotes) await git(path, ['remote', 'add', remote.name, remote.url], { okCodes: [3] });
  const head = (await git(path, ['rev-parse', 'HEAD'])).stdout.trim();
  return { head, branches: branches.length };
}

export function readPendingWork(home: string): PendingWork[] {
  const file = join(home, MIGRATED_DIR, PENDING_WORK_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as PendingWork[]) : [];
}

/**
 * Puts one pending item into a checkout a person names. Only into a clean work tree of the same
 * commit the work was made on; the files are written over it and the deleted ones removed. Nothing is
 * stashed or reset, and a conflict (a file that exists with other content) stops it.
 */
export async function applyPendingWork(home: string, id: string, into: string): Promise<PendingWork> {
  const all = readPendingWork(home);
  const item = all.find((w) => w.id === id);
  if (!item) throw new MigrationRefused(`no pending work ${id}`);
  if (item.state === 'applied') throw new MigrationRefused(`pending work ${id} was already applied into ${item.appliedInto}`);
  const dir = resolve(into);
  const head = (await git(dir, ['rev-parse', 'HEAD'], { okCodes: [128] })).stdout.trim();
  if (!item.head || head !== item.head)
    throw new MigrationRefused(`${dir} is at ${head.slice(0, 12) || 'no commit'}, the work was made on ${item.head?.slice(0, 12) ?? 'unknown'}: check out that commit first`);
  const status = (await git(dir, ['status', '--porcelain=v1', '-uall'])).stdout.trim();
  if (status) throw new MigrationRefused(`${dir} is not clean: the work is never mixed into other changes`);
  if (item.archive)
    await run('tar', ['-xzf', join(home, MIGRATED_DIR, 'pending-work', id, 'files.tar.gz'), '-C', dir, '--no-same-owner']);
  for (const path of item.deleted) {
    const file = resolve(dir, path);
    if (file.startsWith(dir + sep)) rmSync(file, { force: true });
  }
  item.state = 'applied';
  item.appliedInto = dir;
  item.appliedAt = new Date().toISOString();
  writeFileSync(join(home, MIGRATED_DIR, PENDING_WORK_FILE), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  return item;
}
