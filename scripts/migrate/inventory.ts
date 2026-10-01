import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION } from '../../apps/server/src/db';
import { LIVE_SESSION_STATES } from '../../apps/server/src/domain';
import { databaseFiles, databaseInUse, snapshotDatabase } from './database';
import { git, isGitRepository, redactRemoteUrl } from './git';
import { pathGroup } from './paths';

/**
 * The inventory of a home directory and of the work around it (PM-143): everything the move has to
 * carry, keep or deliberately leave behind, as facts and findings. It is read-only: the database is
 * read from a scratch copy, repositories are only queried, and nothing it prints is a secret (file
 * names, counts, modes and commit ids; never file contents, tokens or remote credentials).
 */

export type Severity = 'blocker' | 'warning' | 'info';
export interface Finding {
  severity: Severity;
  code: string;
  subject: string;
  message: string;
}

export interface DirtyInfo {
  modified: number;
  deleted: number;
  untracked: number;
  /** The first paths (capped), for a person to recognise the work. */
  paths: string[];
}

export interface BranchInfo {
  name: string;
  sha: string;
  /** Commits of this branch that no remote-tracking reference contains: the work that exists only here. */
  localOnlyCommits: number;
}

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  /** Made by projectman (under `<home>/worktrees`). */
  managed: boolean;
  dirty: DirtyInfo;
  /** The member and task a session of that directory belonged to, when the database knows it. */
  assignedTo: { member: string; taskKey: string | null } | null;
}

export interface RepoInventory {
  project: string;
  name: string;
  path: string;
  exists: boolean;
  isGit: boolean;
  head: string | null;
  branch: string | null;
  defaultBranch: string;
  branches: BranchInfo[];
  remotes: { name: string; url: string }[];
  stashes: number;
  dirty: DirtyInfo;
  /** Linked worktrees (the main checkout is the repository itself). */
  worktrees: WorktreeInfo[];
}

export interface ProjectInventory {
  key: string;
  workspacePath: string;
  repos: RepoInventory[];
}

export interface Inventory {
  version: 1;
  createdAt: string;
  home: string;
  platform: string;
  database: {
    present: boolean;
    inUse: boolean;
    /** Leftover write-ahead-log files next to the database (an unclean stop, or a running server). */
    sideFiles: string[];
    schemaVersion: number | null;
    buildSchemaVersion: number;
    integrity: string | null;
    foreignKeyViolations: number | null;
    counts: Record<string, number>;
    liveSessions: number;
    openInbox: number;
    deferredStarts: number;
  };
  secret: { present: boolean; mode: string | null };
  customization: { present: boolean; head: string | null; dirty: number; submodules: string[] };
  attachments: {
    rows: number;
    files: number;
    rowsWithoutFile: number;
    filesWithoutRow: number;
    bytes: number;
  };
  memory: { files: number };
  /** The top-level entries of the home and their sizes, so what is not carried is visible too. */
  entries: { name: string; kind: 'file' | 'directory'; bytes: number }[];
  projects: ProjectInventory[];
  sessions: {
    total: number;
    byProvider: Record<string, number>;
    byProfile: Record<string, number>;
    transcripts: { referenced: number; present: number; missing: number; bytes: number };
  };
  memberWorkspaces: { total: number; missing: number };
  /** Absolute paths stored in configuration and database, grouped by their first segments. */
  absolutePaths: { group: string; kinds: string[]; count: number }[];
  findings: Finding[];
}

export interface InventoryOptions {
  home: string;
  /** For tests: whatever finds the sizes cheaply (default: walk the files). */
  now?: () => Date;
}

const LIVE_STATES: readonly string[] = LIVE_SESSION_STATES;
const MAX_PATHS = 50;

export function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(current, name);
      const info = lstatSync(path);
      if (info.isDirectory()) stack.push(path);
      else {
        files += 1;
        bytes += info.size;
      }
    }
  }
  return { bytes, files };
}

async function dirtyOf(dir: string): Promise<DirtyInfo> {
  const { stdout } = await git(dir, ['status', '--porcelain=v1', '-z', '-uall']);
  const entries = stdout.split('\0').filter(Boolean);
  const info: DirtyInfo = { modified: 0, deleted: 0, untracked: 0, paths: [] };
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename or copy lists the old path as the next entry.
    if (status[0] === 'R' || status[0] === 'C') i += 1;
    if (status === '??') info.untracked += 1;
    else if (status.includes('D')) info.deleted += 1;
    else info.modified += 1;
    if (info.paths.length < MAX_PATHS) info.paths.push(path);
  }
  return info;
}

export const isDirty = (dirty: DirtyInfo): boolean => dirty.modified + dirty.deleted + dirty.untracked > 0;

async function branchesOf(repo: string): Promise<BranchInfo[]> {
  const { stdout } = await git(repo, [
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)',
    'refs/heads',
  ]);
  const branches: BranchInfo[] = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [name, sha] = line.split('\t') as [string, string];
    const counted = await git(repo, ['rev-list', '--count', name, '--not', '--remotes'], { okCodes: [128] });
    branches.push({ name, sha, localOnlyCommits: counted.code === 0 ? Number(counted.stdout.trim()) : 0 });
  }
  return branches;
}

interface ListedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  bare: boolean;
}

function parseWorktrees(text: string): ListedWorktree[] {
  const list: ListedWorktree[] = [];
  for (const block of text.split('\n\n').filter((b) => b.trim())) {
    const item: ListedWorktree = {
      path: '',
      head: null,
      branch: null,
      detached: false,
      locked: false,
      prunable: false,
      bare: false,
    };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) item.path = line.slice(9);
      else if (line.startsWith('HEAD ')) item.head = line.slice(5);
      else if (line.startsWith('branch ')) item.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'detached') item.detached = true;
      else if (line === 'bare') item.bare = true;
      else if (line.startsWith('locked')) item.locked = true;
      else if (line.startsWith('prunable')) item.prunable = true;
    }
    if (item.path) list.push(item);
  }
  return list;
}

interface SessionRow {
  project_key: string;
  member: string;
  work_item_type: string;
  work_item_ref: string;
  cwd: string;
  transcript_path: string | null;
  provider: string;
  execution_profile: string;
  state: string;
}

function tableCount(db: Database.Database, table: string): number {
  try {
    return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  } catch {
    return 0;
  }
}

const COUNTED_TABLES = [
  'users',
  'projects',
  'tasks',
  'timeline_events',
  'sessions',
  'team_messages',
  'inbox_items',
  'attachments',
  'member_workspaces',
  'task_workspace_bindings',
  'boundary_requests',
  'boundary_grants',
];

/** The projects of the customization repository and the repositories each names (absolute paths). */
export function readProjectFiles(
  home: string,
): { key: string; workspacePath: string; repos: { name: string; path: string; defaultBranch: string }[] }[] {
  const root = join(home, 'customization', 'projects');
  if (!existsSync(root)) return [];
  const projects = [];
  for (const key of readdirSync(root).sort()) {
    const file = join(root, key, 'project.yaml');
    if (!existsSync(file)) continue;
    const doc = parseYaml(readFileSync(file, 'utf8')) as {
      project?: { workspacePath?: string; repos?: { name: string; path: string; defaultBranch?: string }[] };
    };
    const project = doc?.project;
    if (!project?.workspacePath) continue;
    projects.push({
      key,
      workspacePath: project.workspacePath,
      repos: (project.repos ?? []).map((r) => ({
        name: r.name,
        path: isAbsolute(r.path) ? r.path : resolve(project.workspacePath!, r.path),
        defaultBranch: r.defaultBranch ?? 'main',
      })),
    });
  }
  return projects;
}

export async function buildInventory(options: InventoryOptions): Promise<Inventory> {
  const home = resolve(options.home);
  if (!existsSync(home) || !statSync(home).isDirectory()) throw new Error(`no such home directory: ${home}`);
  const findings: Finding[] = [];
  const add = (severity: Severity, code: string, subject: string, message: string) =>
    findings.push({ severity, code, subject, message });
  const pathKinds = new Map<string, { kinds: Set<string>; count: number }>();
  const notePath = (kind: string, path: string | null | undefined) => {
    if (!path || !isAbsolute(path)) return;
    const group = pathGroup(path);
    const entry = pathKinds.get(group) ?? { kinds: new Set<string>(), count: 0 };
    entry.kinds.add(kind);
    entry.count += 1;
    pathKinds.set(group, entry);
  };

  // --- database
  const sideFiles = databaseFiles(home).filter((name) => name !== 'db.sqlite');
  const present = existsSync(join(home, 'db.sqlite'));
  const inUse = present ? databaseInUse(home) : false;
  const database: Inventory['database'] = {
    present,
    inUse,
    sideFiles,
    schemaVersion: null,
    buildSchemaVersion: LATEST_SCHEMA_VERSION,
    integrity: null,
    foreignKeyViolations: null,
    counts: {},
    liveSessions: 0,
    openInbox: 0,
    deferredStarts: 0,
  };
  const sessions: SessionRow[] = [];
  let attachmentIds: string[] = [];
  const workspaceRows: { path: string }[] = [];
  const bindingSources: { source_path: string | null }[] = [];
  if (!present) add('blocker', 'database_missing', 'db.sqlite', 'the home has no database');
  else {
    if (inUse)
      add(
        'blocker',
        'source_running',
        'db.sqlite',
        'another process has the database open: stop projectman before the move',
      );
    else if (sideFiles.length > 0)
      add(
        'warning',
        'wal_left_over',
        sideFiles.join(', '),
        'write-ahead-log files were left behind (an unclean stop); SQLite recovers them in the copy',
      );
    const snapshot = snapshotDatabase(home);
    try {
      const db = snapshot.db;
      database.schemaVersion = Number(db.pragma('user_version', { simple: true }));
      if (database.schemaVersion > LATEST_SCHEMA_VERSION)
        add(
          'blocker',
          'schema_newer',
          'db.sqlite',
          `the database is at schema ${database.schemaVersion}, this build knows ${LATEST_SCHEMA_VERSION}: use a newer build, never an older one`,
        );
      else if (database.schemaVersion < LATEST_SCHEMA_VERSION)
        add(
          'info',
          'schema_older',
          'db.sqlite',
          `the database is at schema ${database.schemaVersion}; the new build migrates it to ${LATEST_SCHEMA_VERSION} in the copy only`,
        );
      database.integrity = String(db.pragma('integrity_check', { simple: true }));
      if (database.integrity !== 'ok')
        add('blocker', 'integrity_failed', 'db.sqlite', `integrity_check: ${database.integrity}`);
      database.foreignKeyViolations = (db.pragma('foreign_key_check') as unknown[]).length;
      if (database.foreignKeyViolations > 0)
        add(
          'warning',
          'foreign_key_violations',
          'db.sqlite',
          `${database.foreignKeyViolations} rows break a foreign key (copied as they are)`,
        );
      for (const table of COUNTED_TABLES) database.counts[table] = tableCount(db, table);
      const hasSessions = tableCount(db, 'sessions') > 0 || database.schemaVersion >= 1;
      if (hasSessions && database.schemaVersion >= 1) {
        const hasProfile = database.schemaVersion >= 14;
        const hasProvider = database.schemaVersion >= 9;
        sessions.push(
          ...(db
            .prepare(
              `SELECT project_key, member, work_item_type, work_item_ref, cwd, transcript_path, state,
                 ${hasProvider ? 'provider' : "'claude'"} AS provider,
                 ${hasProfile ? 'execution_profile' : "'legacy'"} AS execution_profile
               FROM sessions`,
            )
            .all() as SessionRow[]),
        );
        database.liveSessions = sessions.filter((s) => LIVE_STATES.includes(s.state)).length;
      }
      if (database.schemaVersion >= 1)
        database.openInbox = Number(
          (db.prepare("SELECT count(*) AS n FROM inbox_items WHERE state = 'open'").get() as { n: number }).n,
        );
      if (database.schemaVersion >= 10) database.deferredStarts = tableCount(db, 'deferred_starts');
      if (database.schemaVersion >= 11)
        attachmentIds = (
          db.prepare("SELECT id FROM attachments WHERE state = 'ready'").all() as { id: string }[]
        ).map((r) => r.id);
      if (database.schemaVersion >= 13) {
        workspaceRows.push(...(db.prepare('SELECT path FROM member_workspaces').all() as { path: string }[]));
        bindingSources.push(
          ...(db.prepare('SELECT source_path FROM task_workspace_bindings').all() as {
            source_path: string | null;
          }[]),
        );
      }
    } finally {
      snapshot.dispose();
    }
    if (database.liveSessions > 0)
      add(
        'warning',
        'live_sessions',
        'sessions',
        `${database.liveSessions} sessions are recorded as running: the server was not stopped cleanly, or still runs`,
      );
    if (database.openInbox > 0)
      add('info', 'open_inbox', 'inbox', `${database.openInbox} open inbox items travel with the database`);
    if (database.deferredStarts > 0)
      add(
        'info',
        'deferred_starts',
        'deferred starts',
        `${database.deferredStarts} deferred starts travel with the database; only the active instance may run them`,
      );
  }

  // --- secret, customization, attachments, memory
  const secretPath = join(home, 'secret');
  const secret = {
    present: existsSync(secretPath),
    mode: existsSync(secretPath) ? (statSync(secretPath).mode & 0o777).toString(8) : null,
  };
  if (!secret.present)
    add(
      'blocker',
      'secret_missing',
      'secret',
      'the cookie signing key is missing: a copy without it logs every browser out',
    );
  else if (secret.mode !== '600')
    add('warning', 'secret_mode', 'secret', `the cookie signing key has mode ${secret.mode}, not 600`);

  const customizationDir = join(home, 'customization');
  const customization: Inventory['customization'] = {
    present: existsSync(customizationDir),
    head: null,
    dirty: 0,
    submodules: [],
  };
  if (customization.present) {
    if (!(await isGitRepository(customizationDir)))
      add(
        'blocker',
        'customization_not_git',
        'customization',
        'the customization directory is not a git repository: its history would be lost',
      );
    else {
      customization.head =
        (await git(customizationDir, ['rev-parse', 'HEAD'], { okCodes: [128] })).stdout.trim() || null;
      customization.dirty = (await dirtyOf(customizationDir)).paths.length;
      if (customization.dirty > 0)
        add(
          'warning',
          'customization_dirty',
          'customization',
          `${customization.dirty} uncommitted changes in the customization repository (copied as they are)`,
        );
      const modules = (
        await git(
          customizationDir,
          ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
          { okCodes: [1, 128] },
        )
      ).stdout;
      customization.submodules = modules
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(' ')[1]!)
        .filter(Boolean);
      if (customization.submodules.length > 0)
        add(
          'info',
          'submodules',
          customization.submodules.join(', '),
          'registered submodules are copied with their own .git (the whole customization directory moves as one)',
        );
    }
  } else add('warning', 'customization_missing', 'customization', 'the home has no customization repository');

  const attachmentsDir = join(home, 'attachments');
  const attachmentFiles = new Set<string>();
  let attachmentBytes = 0;
  if (existsSync(attachmentsDir)) {
    const stack = [attachmentsDir];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const info = lstatSync(path);
        if (info.isDirectory()) stack.push(path);
        else {
          attachmentFiles.add(name);
          attachmentBytes += info.size;
        }
      }
    }
  }
  const attachments: Inventory['attachments'] = {
    rows: attachmentIds.length,
    files: attachmentFiles.size,
    rowsWithoutFile: attachmentIds.filter((id) => !attachmentFiles.has(id)).length,
    filesWithoutRow: [...attachmentFiles].filter((name) => !attachmentIds.includes(name)).length,
    bytes: attachmentBytes,
  };
  if (attachments.rowsWithoutFile > 0)
    add(
      'warning',
      'attachments_missing_files',
      'attachments',
      `${attachments.rowsWithoutFile} attachment rows have no file (broken before the move)`,
    );
  if (attachments.filesWithoutRow > 0)
    add(
      'info',
      'attachments_unreferenced_files',
      'attachments',
      `${attachments.filesWithoutRow} files in attachments/ have no ready row (the server cleans uploads cut short)`,
    );
  const memory = { files: existsSync(join(home, 'memory')) ? dirSize(join(home, 'memory')).files : 0 };

  const entries: Inventory['entries'] = readdirSync(home)
    .sort()
    .map((name) => {
      const info = lstatSync(join(home, name));
      return info.isDirectory()
        ? { name, kind: 'directory' as const, bytes: dirSize(join(home, name)).bytes }
        : { name, kind: 'file' as const, bytes: info.size };
    });
  if (existsSync(join(home, 'github-publish')))
    add(
      'info',
      'publishing_identity',
      'github-publish',
      'the publishing identity state is never copied: the VM gets its own identity',
    );

  // --- projects, repositories, worktrees
  const sessionByDir = new Map<string, { member: string; taskKey: string | null }>();
  for (const s of sessions)
    sessionByDir.set(resolve(s.cwd), {
      member: s.member,
      taskKey: s.work_item_type === 'task' ? s.work_item_ref : null,
    });
  const managedRoot = join(home, 'worktrees');
  const projects: ProjectInventory[] = [];
  const seenRepos = new Set<string>();
  for (const project of readProjectFiles(home)) {
    notePath('project workspace', project.workspacePath);
    if (!existsSync(project.workspacePath))
      add(
        'warning',
        'workspace_missing',
        project.key,
        `the workspace ${project.workspacePath} does not exist on this machine`,
      );
    else {
      // Only the repositories move: anything else lying in a workspace directory that is not itself a repository stays.
      const roots = new Set(project.repos.map((r) => relative(project.workspacePath, r.path).split(sep)[0]));
      if (!roots.has('') && !roots.has('.')) {
        const extra = readdirSync(project.workspacePath).filter((n) => !n.startsWith('.') && !roots.has(n));
        if (extra.length > 0)
          add(
            'warning',
            'workspace_extra_content',
            project.key,
            `${extra.length} entries in ${project.workspacePath} belong to no repository and are not carried (${extra.slice(0, 5).join(', ')})`,
          );
      }
    }
    const repos: RepoInventory[] = [];
    for (const repo of project.repos) {
      const subject = `${project.key}/${repo.name}`;
      const entry: RepoInventory = {
        project: project.key,
        name: repo.name,
        path: repo.path,
        exists: existsSync(repo.path),
        isGit: false,
        head: null,
        branch: null,
        defaultBranch: repo.defaultBranch,
        branches: [],
        remotes: [],
        stashes: 0,
        dirty: { modified: 0, deleted: 0, untracked: 0, paths: [] },
        worktrees: [],
      };
      repos.push(entry);
      if (!entry.exists) {
        add('warning', 'repo_missing', subject, `the repository ${repo.path} does not exist on this machine`);
        continue;
      }
      if (!(await isGitRepository(repo.path))) {
        add(
          'warning',
          'not_a_git_repo',
          subject,
          `${repo.path} is not a git repository: nothing of it is carried`,
        );
        continue;
      }
      entry.isGit = true;
      if (seenRepos.has(resolve(repo.path))) continue;
      seenRepos.add(resolve(repo.path));
      entry.head = (await git(repo.path, ['rev-parse', 'HEAD'], { okCodes: [128] })).stdout.trim() || null;
      entry.branch =
        (
          await git(repo.path, ['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [1, 128] })
        ).stdout.trim() || null;
      entry.branches = entry.head ? await branchesOf(repo.path) : [];
      const remotes = (await git(repo.path, ['remote', '-v'])).stdout
        .split('\n')
        .filter((l) => l.endsWith('(fetch)'));
      for (const line of remotes) {
        const [name, url] = line.split(/\s+/) as [string, string];
        const redacted = redactRemoteUrl(url);
        entry.remotes.push({ name, url: redacted.url });
        if (redacted.hadCredentials)
          add(
            'warning',
            'credentials_in_remote_url',
            `${subject} (${name})`,
            'the remote URL carries credentials: they are not recorded and not carried; the VM uses its own identity',
          );
      }
      entry.stashes = (await git(repo.path, ['stash', 'list'])).stdout.split('\n').filter(Boolean).length;
      entry.dirty = await dirtyOf(repo.path);
      if (isDirty(entry.dirty))
        add(
          'warning',
          'dirty_work',
          subject,
          `${entry.dirty.modified + entry.dirty.deleted} changed and ${entry.dirty.untracked} untracked files in ${repo.path}: captured, never discarded or stashed`,
        );
      if (entry.remotes.length === 0 && entry.head)
        add(
          'warning',
          'local_only_repository',
          subject,
          'the repository has no remote: every commit exists only here, the bundle is the only copy that moves',
        );
      for (const branch of entry.branches)
        if (branch.localOnlyCommits > 0 && entry.remotes.length > 0)
          add(
            'warning',
            'local_only_commits',
            `${subject}:${branch.name}`,
            `${branch.localOnlyCommits} commits are on no remote: they travel in the bundle`,
          );
      if (entry.stashes > 0)
        add('info', 'stashes', subject, `${entry.stashes} stash entries travel with the bundle (refs/stash)`);
      const listed = parseWorktrees((await git(repo.path, ['worktree', 'list', '--porcelain'])).stdout);
      for (const w of listed.slice(1)) {
        const info: WorktreeInfo = {
          path: w.path,
          head: w.head,
          branch: w.branch,
          detached: w.detached,
          locked: w.locked,
          prunable: w.prunable,
          managed: resolve(w.path) === managedRoot || resolve(w.path).startsWith(managedRoot + sep),
          dirty:
            w.prunable || !existsSync(w.path)
              ? { modified: 0, deleted: 0, untracked: 0, paths: [] }
              : await dirtyOf(w.path),
          assignedTo: sessionByDir.get(resolve(w.path)) ?? null,
        };
        entry.worktrees.push(info);
        if (isDirty(info.dirty))
          add(
            'warning',
            'dirty_work',
            `${subject} worktree ${basename(w.path)}`,
            `${info.dirty.modified + info.dirty.deleted} changed and ${info.dirty.untracked} untracked files in ${w.path}: captured${info.assignedTo ? ` for ${info.assignedTo.member}` : ' (no member known)'}, never discarded`,
          );
        if (w.detached)
          add(
            'warning',
            'detached_head',
            `${subject} worktree ${basename(w.path)}`,
            `HEAD is detached at ${w.head?.slice(0, 12)}: a commit on no branch is not carried by the bundle`,
          );
        if (w.prunable)
          add(
            'info',
            'worktree_prunable',
            `${subject} worktree ${basename(w.path)}`,
            'git lists it as prunable (its directory is gone)',
          );
      }
    }
    projects.push({ key: project.key, workspacePath: project.workspacePath, repos });
  }

  // --- sessions and transcripts
  const byProvider: Record<string, number> = {};
  const byProfile: Record<string, number> = {};
  let present_ = 0;
  let missing = 0;
  let transcriptBytes = 0;
  let referenced = 0;
  for (const s of sessions) {
    byProvider[s.provider] = (byProvider[s.provider] ?? 0) + 1;
    byProfile[s.execution_profile] = (byProfile[s.execution_profile] ?? 0) + 1;
    notePath('session directory', s.cwd);
    if (s.transcript_path) {
      referenced += 1;
      notePath('transcript', s.transcript_path);
      if (existsSync(s.transcript_path)) {
        present_ += 1;
        transcriptBytes += statSync(s.transcript_path).size;
      } else missing += 1;
    }
  }
  if (missing > 0)
    add(
      'info',
      'transcripts_missing',
      'transcripts',
      `${missing} conversations have no transcript file on this machine (their history cannot be shown after the move either)`,
    );
  const legacy = byProfile.legacy ?? 0;
  if (legacy > 0)
    add(
      'info',
      'sessions_not_resumed',
      'sessions',
      `${legacy} conversations ran in the legacy profile: they stay as history, and a new conversation starts from the task brief and the member's memory (never an automatic resume)`,
    );

  let workspaceMissing = 0;
  for (const w of workspaceRows) {
    notePath('member workspace', w.path);
    if (!existsSync(w.path)) workspaceMissing += 1;
  }
  for (const b of bindingSources) notePath('workspace source', b.source_path);

  const absolutePaths = [...pathKinds.entries()]
    .map(([group, v]) => ({ group, kinds: [...v.kinds].sort(), count: v.count }))
    .sort((a, b) => b.count - a.count);

  return {
    version: 1,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    home,
    platform: process.platform,
    database,
    secret,
    customization,
    attachments,
    memory,
    entries,
    projects,
    sessions: {
      total: sessions.length,
      byProvider,
      byProfile,
      transcripts: { referenced, present: present_, missing, bytes: transcriptBytes },
    },
    memberWorkspaces: { total: workspaceRows.length, missing: workspaceMissing },
    absolutePaths,
    findings,
  };
}

/** A short, readable form of the inventory for a person (the JSON is the complete one). */
export function formatInventory(inv: Inventory): string {
  const lines: string[] = [];
  lines.push(`Inventory of ${inv.home} (${inv.createdAt})`);
  const db = inv.database;
  lines.push(
    `  database: schema ${db.schemaVersion ?? '-'} (this build ${db.buildSchemaVersion}), integrity ${db.integrity ?? '-'}, ` +
      Object.entries(db.counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(', '),
  );
  lines.push(`  secret: ${inv.secret.present ? `present, mode ${inv.secret.mode}` : 'MISSING'}`);
  lines.push(
    `  customization: ${inv.customization.present ? `head ${inv.customization.head?.slice(0, 12) ?? '-'}, ${inv.customization.dirty} uncommitted` : 'missing'}`,
  );
  lines.push(
    `  attachments: ${inv.attachments.rows} rows, ${inv.attachments.files} files, ${inv.attachments.bytes} bytes; memory: ${inv.memory.files} files`,
  );
  for (const p of inv.projects) {
    lines.push(`  project ${p.key}: ${p.workspacePath}`);
    for (const r of p.repos) {
      lines.push(
        `    ${r.name}: ${r.path} ${r.isGit ? `(${r.branch ?? 'detached'}, ${r.branches.length} branches, ${r.worktrees.length} worktrees, ${isDirty(r.dirty) ? 'DIRTY' : 'clean'})` : r.exists ? '(not git)' : '(missing)'}`,
      );
    }
  }
  lines.push(
    `  sessions: ${inv.sessions.total}; transcripts ${inv.sessions.transcripts.present}/${inv.sessions.transcripts.referenced} present`,
  );
  lines.push(
    '  absolute paths to map: ' +
      (inv.absolutePaths.map((g) => `${g.group} (${g.count})`).join(', ') || 'none'),
  );
  for (const sev of ['blocker', 'warning', 'info'] as const) {
    const found = inv.findings.filter((f) => f.severity === sev);
    if (found.length === 0) continue;
    lines.push(`${sev.toUpperCase()}S (${found.length}):`);
    for (const f of found) lines.push(`  - [${f.code}] ${f.subject}: ${f.message}`);
  }
  return lines.join('\n');
}
