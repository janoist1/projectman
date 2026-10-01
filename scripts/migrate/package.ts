import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LATEST_SCHEMA_VERSION } from '../../apps/server/src/db';
import { backupDatabase, snapshotDatabase } from './database';
import { git, isGitRepository } from './git';
import { buildInventory, isDirty } from './inventory';
import type { Finding, Inventory, RepoInventory, WorktreeInfo } from './inventory';

const run = promisify(execFile);

/**
 * The migration package (PM-143): everything that moves, in one directory, with a checksum for every
 * file. It is a SECRET (the cookie signing key, the database, conversations, the owner's unpushed
 * work): created mode 0700, never inside a repository or the source home, never a task attachment.
 *
 *   manifest.json     what is in it, checksums, versions
 *   inventory.json    the inventory the package was made from
 *   home/             the home directory without what must not move (see EXCLUDED)
 *   repos/            one git bundle per repository: every branch, tag, stash and remote-tracking ref
 *   work/<n>/         the uncommitted and untracked files of a dirty checkout or worktree, as they are
 *   transcripts/      the CLI transcripts the database refers to, by session id
 *
 * The source is only read. Nothing is stashed, reset, cleaned or deleted there.
 */

export const PACKAGE_VERSION = 1;

/** Not carried from the home: old worktrees and workspaces (their work is captured separately), the publishing identity, the old role marker and temporary files. */
export const EXCLUDED_ENTRIES = ['worktrees', 'workspaces', 'github-publish', 'instance.json'] as const;
const isTemporary = (name: string) => name.startsWith('.secret-') || name.endsWith('.tmp');

export interface PackageManifest {
  version: typeof PACKAGE_VERSION;
  createdAt: string;
  sourceHome: string;
  sourcePlatform: string;
  sourceSchemaVersion: number;
  buildSchemaVersion: number;
  repos: PackagedRepo[];
  work: PackagedWork[];
  transcripts: PackagedTranscript[];
  /** Entries of the source home that were left out on purpose, with their sizes. */
  notCarried: { name: string; bytes: number }[];
  files: Record<string, { sha256: string; bytes: number }>;
}

export interface PackagedRepo {
  project: string;
  name: string;
  /** The path on the old machine. */
  sourcePath: string;
  bundle: string;
  head: string;
  branch: string | null;
  defaultBranch: string;
  /** Remote URLs without credentials (a remote that had them is not listed). */
  remotes: { name: string; url: string }[];
}

export interface PackagedWork {
  id: string;
  kind: 'checkout' | 'worktree';
  project: string;
  repo: string;
  sourcePath: string;
  head: string | null;
  branch: string | null;
  /** The member and task a session of that directory belonged to, if the database says so. */
  assignedTo: { member: string; taskKey: string | null } | null;
  archive: string | null;
  files: number;
  deleted: string[];
  bytes: number;
}

export interface PackagedTranscript {
  sessionId: string;
  provider: string;
  sourcePath: string;
  file: string;
  bytes: number;
}

export class MigrationRefused extends Error {
  readonly findings: Finding[];
  constructor(message: string, findings: Finding[] = []) {
    super(message);
    this.name = 'MigrationRefused';
    this.findings = findings;
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isDirectory()) stack.push(path);
      else files.push(path);
    }
  }
  return files.sort();
}

/** The files a dirty checkout would lose: everything changed, staged or untracked, and the deleted ones. */
export async function changedFiles(dir: string): Promise<{ present: string[]; deleted: string[] }> {
  const { stdout } = await git(dir, ['status', '--porcelain=v1', '-z', '-uall']);
  const entries = stdout.split('\0').filter(Boolean);
  const present: string[] = [];
  const deleted: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') {
      // The next entry is the old path of a rename: it is gone from the work tree.
      i += 1;
      if (status[0] === 'R') deleted.push(entries[i]!);
    }
    if (status.includes('D') && !existsSync(join(dir, path))) deleted.push(path);
    else present.push(path);
  }
  return { present, deleted };
}

async function archiveFiles(dir: string, files: string[], destination: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'pm-migrate-list-'));
  try {
    const list = join(scratch, 'files');
    writeFileSync(list, files.map((f) => `${f}\0`).join(''));
    await run('tar', ['-czf', destination, '-C', dir, '--null', '-T', list]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface PackageOptions {
  home: string;
  out: string;
  now?: () => Date;
}

export interface PackageResult {
  manifest: PackageManifest;
  inventory: Inventory;
}

function assertSafeOutput(home: string, out: string): void {
  const resolved = resolve(out);
  if (resolved === home || resolved.startsWith(home + sep))
    throw new MigrationRefused(`the package must not be inside the source home (${home})`);
  if (existsSync(resolved) && readdirSync(resolved).length > 0)
    throw new MigrationRefused(`${resolved} exists and is not empty`);
}

/** Builds the package of a stopped source home; refuses on any blocker the inventory finds. */
export async function createPackage(options: PackageOptions): Promise<PackageResult> {
  const home = resolve(options.home);
  const out = resolve(options.out);
  assertSafeOutput(home, out);
  mkdirSync(dirname(out), { recursive: true });
  if (await isGitRepository(dirname(out)))
    throw new MigrationRefused(`${out} lies inside a git repository: a secret package never goes into one`);

  const inventory = await buildInventory({ home, now: options.now });
  const blockers = inventory.findings.filter((f) => f.severity === 'blocker');
  if (blockers.length > 0)
    throw new MigrationRefused(`the source has ${blockers.length} blocking findings`, blockers);

  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);

  // --- home
  const homeOut = join(out, 'home');
  mkdirSync(homeOut, { mode: 0o700 });
  const notCarried: PackageManifest['notCarried'] = [];
  for (const name of readdirSync(home)) {
    if (name === 'db.sqlite' || name === 'db.sqlite-wal' || name === 'db.sqlite-shm') continue;
    const source = join(home, name);
    if ((EXCLUDED_ENTRIES as readonly string[]).includes(name) || isTemporary(name)) {
      const entry = inventory.entries.find((e) => e.name === name);
      notCarried.push({ name, bytes: entry?.bytes ?? 0 });
      continue;
    }
    cpSync(source, join(homeOut, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  }
  if (existsSync(join(homeOut, 'secret'))) chmodSync(join(homeOut, 'secret'), 0o600);

  // The database: a scratch copy of its files, recovered by SQLite, then SQLite's own backup.
  const snapshot = snapshotDatabase(home);
  const transcriptRows: { id: string; provider: string; transcript_path: string }[] = [];
  try {
    const version = Number(snapshot.db.pragma('user_version', { simple: true }));
    await backupDatabase(snapshot.db, join(homeOut, 'db.sqlite'));
    if (version >= 1) {
      const hasProvider = version >= 9;
      transcriptRows.push(
        ...(snapshot.db
          .prepare(
            `SELECT id, ${hasProvider ? 'provider' : "'claude'"} AS provider, transcript_path FROM sessions
             WHERE transcript_path IS NOT NULL ORDER BY id`,
          )
          .all() as typeof transcriptRows),
      );
    }
  } finally {
    snapshot.dispose();
  }
  chmodSync(join(homeOut, 'db.sqlite'), 0o600);

  // --- repositories: one bundle each, and the work no commit holds
  const repos: PackagedRepo[] = [];
  const work: PackagedWork[] = [];
  const bundled = new Set<string>();
  let workCounter = 0;
  const captureWork = async (
    kind: PackagedWork['kind'],
    project: string,
    repo: RepoInventory,
    dir: string,
    info: { head: string | null; branch: string | null; assignedTo: PackagedWork['assignedTo'] },
  ): Promise<void> => {
    workCounter += 1;
    const id = String(workCounter).padStart(3, '0');
    const { present, deleted } = await changedFiles(dir);
    const workDir = join(out, 'work', id);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    let archive: string | null = null;
    let bytes = 0;
    if (present.length > 0) {
      archive = `work/${id}/files.tar.gz`;
      await archiveFiles(dir, present, join(out, archive));
      bytes = statSync(join(out, archive)).size;
    }
    work.push({ id, kind, project, repo: repo.name, sourcePath: dir, head: info.head, branch: info.branch, assignedTo: info.assignedTo, archive, files: present.length, deleted, bytes });
  };
  for (const project of inventory.projects) {
    for (const repo of project.repos) {
      if (!repo.isGit || !repo.head || bundled.has(resolve(repo.path))) continue;
      bundled.add(resolve(repo.path));
      const bundle = `repos/${project.key}__${repo.name}.bundle`;
      mkdirSync(join(out, 'repos'), { recursive: true, mode: 0o700 });
      await git(repo.path, ['bundle', 'create', join(out, bundle), '--all']);
      repos.push({
        project: project.key,
        name: repo.name,
        sourcePath: resolve(repo.path),
        bundle,
        head: repo.head,
        branch: repo.branch,
        defaultBranch: repo.defaultBranch,
        remotes: repo.remotes,
      });
      if (isDirty(repo.dirty))
        await captureWork('checkout', project.key, repo, repo.path, { head: repo.head, branch: repo.branch, assignedTo: null });
      for (const w of repo.worktrees as WorktreeInfo[])
        if (isDirty(w.dirty) && !w.prunable && existsSync(w.path))
          await captureWork('worktree', project.key, repo, w.path, { head: w.head, branch: w.branch, assignedTo: w.assignedTo });
    }
  }

  // --- transcripts the database refers to
  const transcripts: PackagedTranscript[] = [];
  for (const row of transcriptRows) {
    if (!existsSync(row.transcript_path) || !statSync(row.transcript_path).isFile()) continue;
    const file = `transcripts/${row.id}/${basename(row.transcript_path)}`;
    mkdirSync(join(out, 'transcripts', row.id), { recursive: true, mode: 0o700 });
    copyFileSync(row.transcript_path, join(out, file));
    chmodSync(join(out, file), 0o600);
    transcripts.push({ sessionId: row.id, provider: row.provider, sourcePath: row.transcript_path, file, bytes: statSync(join(out, file)).size });
  }

  // --- inventory, manifest, checksums
  writeFileSync(join(out, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  const files: PackageManifest['files'] = {};
  for (const path of walkFiles(out)) {
    files[relative(out, path).split(sep).join('/')] = { sha256: await sha256File(path), bytes: lstatSync(path).size };
  }
  const manifest: PackageManifest = {
    version: PACKAGE_VERSION,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    sourceHome: home,
    sourcePlatform: process.platform,
    sourceSchemaVersion: inventory.database.schemaVersion ?? 0,
    buildSchemaVersion: LATEST_SCHEMA_VERSION,
    repos,
    work,
    transcripts,
    notCarried,
    files,
  };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { manifest, inventory };
}

/** Reads and checks a package: every listed file must be there with its checksum, and no other file may be. */
export async function readPackage(dir: string): Promise<PackageManifest> {
  const root = resolve(dir);
  const manifestPath = join(root, 'manifest.json');
  if (!existsSync(manifestPath)) throw new MigrationRefused(`${root} has no manifest.json: not a migration package`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
  if (manifest.version !== PACKAGE_VERSION)
    throw new MigrationRefused(`unsupported package version ${String(manifest.version)}`);
  const seen = new Set<string>();
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = join(root, name);
    if (!existsSync(path)) throw new MigrationRefused(`the package lacks ${name}`);
    if ((await sha256File(path)) !== expected.sha256) throw new MigrationRefused(`${name} does not match its checksum`);
    seen.add(name);
  }
  for (const path of walkFiles(root)) {
    const name = relative(root, path).split(sep).join('/');
    if (name !== 'manifest.json' && !seen.has(name)) throw new MigrationRefused(`${name} is in the package but not in its manifest`);
  }
  return manifest;
}
