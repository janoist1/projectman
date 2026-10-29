import { randomBytes } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  MemberWorkspaceErrorCode,
  MemberWorkspaceInfo,
  MemberWorkspaceKey,
  MemberWorkspaceManager,
  MemberWorkspaceManagerOptions,
  SourceHead,
  WorkspaceCheckout,
  WorkspaceSource,
  WorkspaceDependenciesResult,
} from '../contracts';
import { isTaskBranch } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { git, GitCommandError, isoOrNull } from './git';
import { isStrictlyWithin } from '../kernel';
import { canonical, createKeyedLock, withRepoLock } from './paths';
import { localWorkspaceAccess, SAFE_GIT_SETTINGS } from './workspace-access';
import type { WorkspaceAccess } from './workspace-access';

/** A fetch that takes longer fails: a new task never starts from a base that may be stale. */
const FETCH_TIMEOUT_MS = 60_000;
/** Clones and checkouts (and large working trees) may take a while. */
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;

/** A git command with no repository (ref name checks) runs here, as the server. */
function plainGit(args: string[]): Promise<string> {
  return git([...SAFE_GIT_SETTINGS, ...args], { isolatedConfig: true });
}

async function plainGitSucceeds(args: string[]): Promise<boolean> {
  try {
    await plainGit(args);
    return true;
  } catch (err) {
    if (err instanceof GitCommandError) return false;
    throw err;
  }
}

/** Files in a git directory that mean an operation was started and not finished. */
const OPERATION_MARKERS: Array<[string, string]> = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
  ['index.lock', 'index-lock'],
  ['HEAD.lock', 'head-lock'],
];

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const REPO_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const TASK_KEY = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,9}$/;
/** Where a developer's handed-over commits live in the project repository (PM-739), one ref per commit. */
const SNAPSHOT_PREFIX = 'refs/projectman/workspaces/';
/** The receiving refs of a hand-over in progress; removed again when it ends. */
const INCOMING_PREFIX = 'refs/projectman/incoming/';

export class MemberWorkspaceError extends Error {
  readonly code: MemberWorkspaceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: MemberWorkspaceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'MemberWorkspaceError';
  }
}

interface MemberWorkspaceManagerSettings extends MemberWorkspaceManagerOptions {
  /** How workspaces are touched (default: here, as the server). */
  access?: WorkspaceAccess;
  /** The root of a member's workspaces (default: `rootDir` for every member). */
  rootFor?: (member: string) => string;
  /** Called at the end of every successful `ensure` with the clone's canonical path (PM-743). */
  onEnsured?: (key: MemberWorkspaceKey, repoPath: string) => void;
}

/**
 * Durable workspaces, one per project x member x repository (PM-138), replacing the worktree per
 * task: `<root>/<PROJECT>/<handle>/<repo>/{repo,cache,tmp}`. `repo` is an independent clone of
 * the project's repository (no hardlinks, no alternates, no worktree link, its own `.git`),
 * without a remote, so nothing the member does there reaches the project repository or a
 * teammate. The server fetches into it explicitly and moves it between branches only when it is
 * clean, never resetting, stashing or cleaning; it is never removed. Every command inside a
 * workspace goes through `access`, which applies the isolated git settings for local commands.
 */
export function createMemberWorkspaceManager(opts: MemberWorkspaceManagerSettings): MemberWorkspaceManager {
  const log = opts.logger;
  const access = opts.access ?? localWorkspaceAccess();
  const rootFor = opts.rootFor ?? (() => opts.rootDir);
  const withLock = createKeyedLock();
  const roots = new Map<string, Promise<string>>();

  function rootPath(member: string): Promise<string> {
    const requested = path.resolve(rootFor(member));
    let root = roots.get(requested);
    if (!root) {
      root = (async () => {
        if ((await maybeLstat(requested))?.isSymbolicLink())
          throw new MemberWorkspaceError('workspace_invalid', 'the workspace root is a symlink');
        await access.mkdir(access.ownerOf(requested), requested);
        return canonical(requested);
      })();
      // A failed attempt (the worker or its home not there yet) is tried again next time.
      root.catch(() => roots.delete(requested));
      roots.set(requested, root);
    }
    return root;
  }

  /** git in a repository, as the owner of its files. */
  const gitIn = (repo: string, args: string[], timeoutMs?: number) =>
    access.git(access.ownerOf(repo), ['-C', repo, ...args], timeoutMs ? { timeoutMs } : undefined);

  async function gitInSucceeds(repo: string, args: string[]): Promise<boolean> {
    try {
      await gitIn(repo, args);
      return true;
    } catch (err) {
      if (err instanceof GitCommandError) return false;
      throw err;
    }
  }

  /**
   * Fetches `refspec`'s source refs from `source` into the workspace at `workspace`, through a
   * hand-over bundle when the workspace's owner may not read the source.
   */
  async function fetchInto(
    workspace: string,
    source: { path: string; refs: string[] },
    refspecs: string[],
    timeoutMs = FETCH_TIMEOUT_MS,
  ): Promise<void> {
    const owner = access.ownerOf(workspace);
    const handed = await access.transfer(owner, { ...source, owner: access.ownerOf(source.path) });
    try {
      await gitIn(workspace, ['fetch', '--quiet', '--no-tags', '--', handed.from, ...refspecs], timeoutMs);
    } finally {
      await handed
        .done()
        .catch((err: unknown) => log.warn({ err, workspace }, 'could not remove a hand-over'));
    }
  }

  async function repositoryOf({ project, repoName }: { project: ProjectConfig; repoName: string }) {
    const projectKey = project.project.key;
    const repo = project.project.repos.find((r) => r.name === repoName);
    if (!repo || !PROJECT_KEY.test(projectKey) || !REPO_NAME.test(repoName))
      throw new MemberWorkspaceError('workspace_invalid', 'invalid repository location');
    const repoPath = path.resolve(project.project.workspacePath, repo.path);
    const workspaceRoot = await canonical(project.project.workspacePath);
    const resolvedRepo = await canonical(repoPath);
    if (resolvedRepo !== workspaceRoot && !isStrictlyWithin(workspaceRoot, resolvedRepo))
      throw new MemberWorkspaceError('workspace_invalid', 'the repository must be inside its workspace');
    return { repoPath: resolvedRepo, defaultBranch: repo.defaultBranch };
  }

  /** The workspace's directories and the project repository it is cloned from, validated. */
  async function locate(key: MemberWorkspaceKey) {
    const { project, repoName, member } = key;
    const projectKey = project.project.key;
    const repository = await repositoryOf(key);
    if (!HANDLE.test(member))
      throw new MemberWorkspaceError('workspace_invalid', 'invalid workspace location', {
        projectKey,
        repo: repoName,
        member,
      });
    const base = await rootPath(member);
    let dir = base;
    for (const part of [projectKey, member, repoName]) {
      dir = path.join(dir, part);
      const entry = await maybeLstat(dir);
      if (entry && (entry.isSymbolicLink() || !entry.isDirectory()))
        throw new MemberWorkspaceError('workspace_invalid', `${dir} is not a plain directory`);
    }
    const info: MemberWorkspaceInfo = {
      path: path.join(dir, 'repo'),
      gitDir: path.join(dir, 'repo', '.git'),
      cacheDir: path.join(dir, 'cache'),
      tempDir: path.join(dir, 'tmp'),
    };
    return { dir, info, ...repository };
  }

  async function location(key: MemberWorkspaceKey): Promise<MemberWorkspaceInfo> {
    return (await locate(key)).info;
  }

  /**
   * The member's own directory for sessions without a repository (PM-141): `<root>/<PROJECT>/<handle>/.home`.
   * The leading dot cannot collide with a repository name, which never starts with one.
   */
  async function home(key: { projectKey: string; member: string }): Promise<string> {
    if (!PROJECT_KEY.test(key.projectKey) || !HANDLE.test(key.member))
      throw new MemberWorkspaceError('workspace_invalid', 'invalid home location', {
        projectKey: key.projectKey,
        member: key.member,
      });
    let dir = await rootPath(key.member);
    for (const part of [key.projectKey, key.member, '.home']) {
      dir = path.join(dir, part);
      const entry = await maybeLstat(dir);
      if (entry && (entry.isSymbolicLink() || !entry.isDirectory()))
        throw new MemberWorkspaceError('workspace_invalid', `${dir} is not a plain directory`);
    }
    await access.mkdir(access.ownerOf(dir), dir);
    return dir;
  }

  /** The clone is ours: a plain directory with its own `.git` directory, no alternates. */
  async function assertWorkspace(info: MemberWorkspaceInfo): Promise<void> {
    const repoEntry = await maybeLstat(info.path);
    const gitEntry = await maybeLstat(info.gitDir);
    if (
      !repoEntry?.isDirectory() ||
      repoEntry.isSymbolicLink() ||
      !gitEntry?.isDirectory() ||
      gitEntry.isSymbolicLink()
    )
      throw new MemberWorkspaceError('workspace_invalid', `${info.path} is not an independent clone`);
    if (await maybeLstat(path.join(info.gitDir, 'objects', 'info', 'alternates')))
      throw new MemberWorkspaceError('workspace_invalid', `${info.path} borrows objects (alternates)`);
    const gitDir = (await gitIn(info.path, ['rev-parse', '--absolute-git-dir'])).trim();
    if ((await canonical(gitDir)) !== (await canonical(info.gitDir)))
      throw new MemberWorkspaceError('workspace_invalid', `${info.path} uses another git directory`);
  }

  async function ensure(key: MemberWorkspaceKey): Promise<MemberWorkspaceInfo & { created: boolean }> {
    const { dir, info, repoPath } = await locate(key);
    const owner = access.ownerOf(dir);
    return withLock(dir, async () => {
      let created = false;
      if (!(await maybeLstat(info.path))) {
        await access.mkdir(owner, dir);
        // An interrupted clone is thrown away: no session ever ran in it.
        const partial = path.join(dir, 'repo.partial');
        await access.remove(owner, partial);
        const handed = await access.transfer(owner, {
          path: repoPath,
          refs: ['--all'],
          owner: access.ownerOf(repoPath),
        });
        try {
          await access.git(
            owner,
            ['clone', '--quiet', '--no-local', '--template=', '--', handed.from, partial],
            {
              timeoutMs: CHECKOUT_TIMEOUT_MS,
            },
          );
        } finally {
          await handed.done().catch((err: unknown) => log.warn({ err, dir }, 'could not remove a hand-over'));
        }
        // No remote: the server fetches explicitly, and a push has nowhere to go.
        await access.git(owner, ['-C', partial, 'remote', 'remove', 'origin']);
        await access.rename(owner, partial, info.path);
        if (access.writesDescription)
          await writeFile(
            path.join(dir, 'workspace.json'),
            `${JSON.stringify({ projectKey: key.project.project.key, member: key.member, repo: key.repoName })}\n`,
            { mode: 0o600 },
          );
        created = true;
        log.info({ member: key.member, repo: key.repoName, path: info.path }, 'created member workspace');
      }
      await assertWorkspace(info);
      await access.mkdir(owner, info.cacheDir);
      await access.mkdir(owner, info.tempDir);
      opts.onEnsured?.(key, await canonical(info.path));
      return { ...info, created };
    });
  }

  async function checkoutOf(dir: string): Promise<WorkspaceCheckout | null> {
    const head = await gitIn(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => null);
    if (!head) return null;
    const branch = await gitIn(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
    return { branch: branch?.trim() || null, head: head.trim() };
  }

  async function operationIn(gitDir: string): Promise<string | null> {
    for (const [marker, operation] of OPERATION_MARKERS) {
      if (await maybeLstat(path.join(gitDir, marker))) return operation;
    }
    return null;
  }

  async function inspect(info: MemberWorkspaceInfo) {
    const operation = await operationIn(info.gitDir);
    const porcelain = await gitIn(info.path, ['status', '--porcelain', '--untracked-files=normal']);
    return { dirty: porcelain.trim().length > 0, operation, checkout: await checkoutOf(info.path) };
  }

  async function status(key: MemberWorkspaceKey) {
    const { dir, info } = await locate(key);
    return withLock(dir, async () => {
      await assertWorkspace(info);
      return inspect(info);
    });
  }

  async function prepareDependencies(
    key: MemberWorkspaceKey,
    options: { waitMs?: number } = {},
  ): Promise<WorkspaceDependenciesResult> {
    const { dir, info } = await locate(key);
    // Start while holding the checkout lock, but release it before awaiting the engine operation.
    const started = await withLock(dir, async () => {
      await assertWorkspace(info);
      if (!opts.dependencies || access.ownerOf(info.path) !== null) return null;
      return {
        promise: opts.dependencies.prepare(
          {
            project: key.project.project.key,
            member: key.member,
            repo: key.repoName,
            repoPath: await canonical(info.path),
          },
          { waitMs: options.waitMs ?? 45_000 },
        ),
      };
    });
    if (!started) return { status: 'skipped', reason: 'not_configured' };
    try {
      return await started.promise;
    } catch (err) {
      throw dependencyError(err);
    }
  }

  async function assertDependenciesIdle(key: MemberWorkspaceKey, info: MemberWorkspaceInfo): Promise<void> {
    if (!opts.dependencies?.busy(info.path)) return;
    try {
      // Join without waiting so the installer supplies the actual operation's startedAt.
      await opts.dependencies.prepare(
        {
          project: key.project.project.key,
          member: key.member,
          repo: key.repoName,
          repoPath: info.path,
        },
        { waitMs: 0 },
      );
    } catch (err) {
      throw dependencyError(err);
    }
  }

  async function sourceHead(key: MemberWorkspaceKey, branch: string): Promise<SourceHead | null> {
    const { dir, info } = await locate(key);
    return withLock(dir, async () => {
      await assertWorkspace(info);
      await assertBranchName(branch);
      const out = await gitIn(info.path, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}^{commit}`,
      ]).catch(() => null);
      const commit = out?.trim() ?? '';
      if (!OID.test(commit)) return null;
      // Uncommitted files are the task's only while its branch is the one checked out.
      const checkedOut = (await checkoutOf(info.path))?.branch === branch;
      const porcelain = checkedOut
        ? await gitIn(info.path, ['status', '--porcelain', '--untracked-files=normal'])
        : '';
      const changes = porcelain.split('\n').filter(Boolean).length;
      const committedAt = isoOrNull(
        await gitIn(info.path, ['log', '-1', '--format=%cI', commit]).catch(() => null),
      );
      return { commit, branch, dirty: changes > 0, changes, path: info.path, committedAt };
    });
  }

  /** Refuses to move a workspace that holds unfinished work. */
  async function assertClean(info: MemberWorkspaceInfo): Promise<void> {
    const state = await inspect(info);
    if (state.operation)
      throw new MemberWorkspaceError(
        'workspace_dirty',
        `${info.path} has an unfinished git operation (${state.operation})`,
        { operation: state.operation, branch: state.checkout?.branch ?? null },
      );
    if (state.dirty)
      throw new MemberWorkspaceError('workspace_dirty', `${info.path} has uncommitted changes`, {
        operation: null,
        branch: state.checkout?.branch ?? null,
      });
  }

  async function fetchBase(key: MemberWorkspaceKey): Promise<{ branch: string; commit: string }> {
    const { dir, info, repoPath, defaultBranch } = await locate(key);
    return withLock(dir, async () => {
      await assertWorkspace(info);
      await assertBranchName(defaultBranch);
      const ref = await withRepoLock(repoPath, async () => {
        // The project repository is the owner's: its own git configuration (credentials) applies.
        const remotes = (await git(['-C', repoPath, 'remote'])).split('\n');
        if (remotes.includes('origin')) {
          try {
            await git(['-C', repoPath, 'fetch', '--quiet', '--', 'origin', defaultBranch], {
              timeoutMs: FETCH_TIMEOUT_MS,
            });
          } catch (err) {
            throw new MemberWorkspaceError(
              'workspace_fetch_failed',
              `could not fetch ${defaultBranch} from origin: ${(err as Error).message}`,
              { branch: defaultBranch },
            );
          }
        }
        return baseRef(repoPath, defaultBranch);
      });
      const tracking = `refs/remotes/upstream/${defaultBranch}`;
      try {
        await fetchInto(info.path, { path: repoPath, refs: [ref] }, [`+${ref}:${tracking}`]);
      } catch (err) {
        throw new MemberWorkspaceError(
          'workspace_fetch_failed',
          `could not fetch ${defaultBranch} into the workspace: ${(err as Error).message}`,
          { branch: defaultBranch },
        );
      }
      const commit = (await gitIn(info.path, ['rev-parse', '--verify', `${tracking}^{commit}`])).trim();
      // The member's own default branch follows when it only falls behind (never rewritten).
      const checkout = await checkoutOf(info.path);
      if (checkout?.branch !== defaultBranch) {
        await gitIn(info.path, [
          'fetch',
          '--quiet',
          '--no-tags',
          '--',
          info.path,
          `${tracking}:refs/heads/${defaultBranch}`,
        ]).catch(async (err: unknown) => {
          const own = `refs/heads/${defaultBranch}`;
          // The member's own default branch has commits the project's does not: it stays as it is.
          if (
            (await refExists(info.path, own)) &&
            !(await gitInSucceeds(info.path, ['merge-base', '--is-ancestor', own, tracking]))
          )
            log.warn(
              { path: info.path, branch: defaultBranch, tracking: commit },
              'the workspace default branch has diverged from the project default branch; left as it is',
            );
          else log.debug({ err, path: info.path }, 'the workspace default branch was not fast-forwarded');
        });
      }
      return { branch: defaultBranch, commit };
    });
  }

  /**
   * The newer of the project repository's default branch and its origin tracking branch: the
   * local one when it is equal to or ahead of origin, otherwise origin (as the worktree manager).
   */
  async function baseRef(repoPath: string, defaultBranch: string): Promise<string> {
    const localRef = `refs/heads/${defaultBranch}`;
    const remoteRef = `refs/remotes/origin/${defaultBranch}`;
    const hasLocal = await refExists(repoPath, localRef);
    if (await refExists(repoPath, remoteRef)) {
      if (hasLocal && (await gitInSucceeds(repoPath, ['merge-base', '--is-ancestor', remoteRef, localRef])))
        return localRef;
      return remoteRef;
    }
    if (hasLocal) return localRef;
    throw new MemberWorkspaceError(
      'workspace_fetch_failed',
      `neither origin/${defaultBranch} nor ${defaultBranch} exists in the project repository`,
      { branch: defaultBranch },
    );
  }

  function refExists(repo: string, ref: string): Promise<boolean> {
    return gitInSucceeds(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  }

  /** The task's branch under `prefix`: the preferred name if present, else the first match. */
  async function taskBranches(
    repo: string,
    prefix: 'refs/heads/' | 'refs/remotes/origin/',
    taskKey: string,
    preferred?: string,
  ): Promise<string | null> {
    const out = await gitIn(repo, ['for-each-ref', '--format=%(refname)', prefix]);
    const names = out
      .split('\n')
      .filter((ref) => ref.startsWith(prefix))
      .map((ref) => ref.slice(prefix.length))
      .filter((name) => isTaskBranch(name, taskKey))
      .sort();
    if (preferred && names.includes(preferred)) return preferred;
    return names[0] ?? null;
  }

  /**
   * The snapshots handed over for the task (`publishTaskBranch`) in the project repository, by their
   * names: `refs/projectman/workspaces/<member>/<TASK-KEY>/<commit>` pointing at exactly `<commit>`.
   */
  async function taskSnapshots(
    repo: string,
    taskKey: string,
  ): Promise<Array<{ ref: string; commit: string }>> {
    const out = await gitIn(repo, ['for-each-ref', '--format=%(objectname) %(refname)', SNAPSHOT_PREFIX]);
    const found: Array<{ ref: string; commit: string }> = [];
    for (const line of out.split('\n')) {
      const [object, ref] = line.split(' ');
      const parts = ref?.split('/') ?? [];
      // refs / projectman / workspaces / <member> / <task> / <commit>
      if (parts.length !== 6 || parts[4] !== taskKey || !OID.test(parts[5]!) || object !== parts[5]) continue;
      found.push({ ref: ref!, commit: parts[5]! });
    }
    return found.sort((a, b) => (a.ref < b.ref ? -1 : 1));
  }

  /** Enumerates only server-owned task ref namespaces; malformed or unrelated refs are never touched. */
  async function snapshotRefs(repoPath: string, projectKey: string) {
    const output = await gitIn(repoPath, [
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      SNAPSHOT_PREFIX,
      INCOMING_PREFIX,
    ]);
    const refs: Array<{ taskKey: string; ref: string; oid: string }> = [];
    for (const line of output.split('\n')) {
      const [oid, ref] = line.split(' ');
      const parts = ref?.split('/') ?? [];
      if (
        !oid ||
        !OID.test(oid) ||
        !ref ||
        parts.length !== 6 ||
        !HANDLE.test(parts[3]!) ||
        !TASK_KEY.test(parts[4]!) ||
        !parts[4]!.startsWith(`${projectKey}-`)
      )
        continue;
      if (ref.startsWith(SNAPSHOT_PREFIX) ? !OID.test(parts[5]!) : !/^[a-f0-9]+$/.test(parts[5]!)) continue;
      refs.push({ taskKey: parts[4]!, ref, oid });
    }
    return refs;
  }

  async function listSnapshotTasks(args: { project: ProjectConfig; repoName: string }) {
    const { repoPath } = await repositoryOf(args);
    return [
      ...new Set((await snapshotRefs(repoPath, args.project.project.key)).map((entry) => entry.taskKey)),
    ].sort();
  }

  async function removeTaskSnapshots(args: { project: ProjectConfig; repoName: string; taskKeys: string[] }) {
    const { repoPath } = await repositoryOf(args);
    if (
      args.taskKeys.length > 100 ||
      args.taskKeys.some((key) => !TASK_KEY.test(key) || !key.startsWith(`${args.project.project.key}-`))
    )
      throw new MemberWorkspaceError('workspace_invalid', 'invalid snapshot cleanup tasks');
    if (!args.taskKeys.length) return;
    await withRepoLock(repoPath, async () => {
      const keys = new Set(args.taskKeys);
      const refs = (await snapshotRefs(repoPath, args.project.project.key)).filter((entry) =>
        keys.has(entry.taskKey),
      );
      if (!refs.length) return;
      await access.git(access.ownerOf(repoPath), ['-C', repoPath, 'update-ref', '--no-deref', '--stdin'], {
        input: `start\n${refs.map(({ ref, oid }) => `delete ${ref} ${oid}\n`).join('')}prepare\ncommit\n`,
      });
    });
  }

  async function findTaskBranch(key: MemberWorkspaceKey, taskKey: string, preferred?: string) {
    const { dir, info, repoPath } = await locate(key);
    return withLock(dir, async () => {
      await assertWorkspace(info);
      const local = await taskBranches(info.path, 'refs/heads/', taskKey, preferred);
      if (local) return { branch: local, source: null };
      for (const prefix of ['refs/heads/', 'refs/remotes/origin/'] as const) {
        const found = await taskBranches(repoPath, prefix, taskKey, preferred);
        if (found) return { branch: found, source: { path: repoPath, ref: `${prefix}${found}` } };
      }
      // Work handed over from a developer's workspace: one commit, or the exact one asked for.
      const snapshots = await taskSnapshots(repoPath, taskKey);
      const commits = new Set(snapshots.map((s) => s.commit));
      const chosen =
        commits.size <= 1
          ? snapshots[0]
          : snapshots.find((s) => preferred !== undefined && (preferred === s.commit || preferred === s.ref));
      if (!chosen) {
        if (commits.size > 1)
          throw new MemberWorkspaceError(
            'workspace_source_missing',
            `${taskKey} has several handed-over commits; none was named`,
            { taskKey },
          );
        return null;
      }
      // The developer's branch name is the caller's (its binding); a task branch name stands in.
      const branch = preferred !== undefined && isTaskBranch(preferred, taskKey) ? preferred : taskKey;
      return { branch, source: { path: repoPath, ref: chosen.ref } };
    });
  }

  async function publishTaskBranch(
    key: MemberWorkspaceKey,
    taskKey: string,
    branch: string,
    commit: string,
  ): Promise<WorkspaceSource> {
    const { dir, info, repoPath } = await locate(key);
    const projectKey = key.project.project.key;
    if (
      !OID.test(commit) ||
      !TASK_KEY.test(taskKey) ||
      !taskKey.startsWith(`${projectKey}-`) ||
      !isTaskBranch(branch, taskKey)
    )
      throw new MemberWorkspaceError('workspace_invalid', 'invalid hand-over request', { taskKey, branch });
    await assertBranchName(branch);
    const snapshot = `${SNAPSHOT_PREFIX}${key.member}/${taskKey}/${commit}`;
    if (!(await plainGitSucceeds(['check-ref-format', snapshot])))
      throw new MemberWorkspaceError('workspace_invalid', 'invalid hand-over ref');
    const source: WorkspaceSource = { path: repoPath, ref: snapshot };
    return withLock(dir, async () =>
      withRepoLock(repoPath, async () => {
        // Another hand-over of the same commit may have finished while this one waited.
        if (await existingSnapshot(repoPath, snapshot, commit)) return source;
        await assertWorkspace(info);
        const branchRef = `refs/heads/${branch}`;
        const onBranch =
          (await gitInSucceeds(info.path, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])) &&
          (await gitInSucceeds(info.path, ['merge-base', '--is-ancestor', commit, branchRef]));
        if (!onBranch)
          throw new MemberWorkspaceError(
            'workspace_source_missing',
            `the commit ${commit} is not on ${branch} in the developer's workspace`,
            { commit, branch },
          );
        // A receiving ref of our own naming that nothing else can use; the snapshot is made only
        // once the fetched history is proven to hold the commit.
        const incoming = `${INCOMING_PREFIX}${key.member}/${taskKey}/${randomBytes(8).toString('hex')}`;
        try {
          try {
            const handed = await access.transfer(access.ownerOf(repoPath), {
              path: info.path,
              refs: [branchRef],
              owner: access.ownerOf(info.path),
            });
            try {
              await gitIn(
                repoPath,
                [
                  // The objects come from an AI-written store: a malformed one must not reach the project repository.
                  '-c',
                  'fetch.fsckObjects=true',
                  'fetch',
                  '--quiet',
                  '--no-tags',
                  '--no-write-fetch-head',
                  '--',
                  handed.from,
                  `${branchRef}:${incoming}`,
                ],
                FETCH_TIMEOUT_MS,
              );
            } finally {
              await handed
                .done()
                .catch((err: unknown) =>
                  log.warn({ err, workspace: info.path }, 'could not remove a hand-over'),
                );
            }
          } catch (err) {
            throw new MemberWorkspaceError(
              'workspace_fetch_failed',
              `could not hand over ${branch}: ${(err as Error).message}`,
              { branch },
            );
          }
          if (!(await gitInSucceeds(repoPath, ['merge-base', '--is-ancestor', commit, incoming])))
            throw new MemberWorkspaceError(
              'workspace_source_missing',
              `the commit ${commit} did not arrive with ${branch}`,
              { commit, branch },
            );
          try {
            // Only when missing: `update-ref` refuses to move a ref whose old value is the null id.
            await gitIn(repoPath, ['update-ref', '--no-deref', snapshot, commit, '0'.repeat(commit.length)]);
          } catch (err) {
            // Lost a race to the same hand-over (the ref is there at the commit now) or to another one.
            if (!(err instanceof GitCommandError) || !(await existingSnapshot(repoPath, snapshot, commit)))
              throw err;
          }
        } finally {
          await gitIn(repoPath, ['update-ref', '-d', incoming]).catch((err: unknown) =>
            log.warn({ err, ref: incoming }, 'could not remove a receiving ref'),
          );
        }
        log.info({ member: key.member, taskKey, commit, ref: snapshot }, 'handed over a task commit');
        return source;
      }),
    );
  }

  /** Whether the snapshot is there at `commit`; another commit under that name is refused. */
  async function existingSnapshot(repoPath: string, snapshot: string, commit: string): Promise<boolean> {
    const out = await gitIn(repoPath, ['rev-parse', '--verify', '--quiet', snapshot]).catch(() => null);
    const present = out?.trim() ?? '';
    if (!present) return false;
    if (present !== commit)
      throw new MemberWorkspaceError('workspace_source_missing', `${snapshot} already names another commit`, {
        commit,
      });
    return true;
  }

  async function resolveSource(source: WorkspaceSource): Promise<string | null> {
    if (!(await plainGitSucceeds(['check-ref-format', source.ref]))) return null;
    const out = await gitIn(source.path, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${source.ref}^{commit}`,
    ]).catch(() => null);
    const commit = out?.trim() ?? '';
    return OID.test(commit) ? commit : null;
  }

  async function checkoutTaskBranch(
    key: MemberWorkspaceKey,
    target:
      | { mode: 'continue'; branch: string }
      | { mode: 'create'; branch: string; startPoint: string }
      | { mode: 'fetch'; branch: string; source: WorkspaceSource },
  ): Promise<WorkspaceCheckout> {
    const { dir, info } = await locate(key);
    return withLock(dir, async () => {
      await assertWorkspace(info);
      await assertDependenciesIdle(key, info);
      await assertBranchName(target.branch);
      // Already there (a resumed task): its own unfinished work stays as it is.
      const before = await checkoutOf(info.path);
      if (before?.branch === target.branch && !(await operationIn(info.gitDir))) return before;
      await assertClean(info);
      const ref = `refs/heads/${target.branch}`;
      const present = await refExists(info.path, ref);
      if (!present) {
        if (target.mode === 'continue')
          throw new MemberWorkspaceError(
            'workspace_branch_missing',
            `the branch ${target.branch} is missing from ${info.path}`,
            { branch: target.branch },
          );
        if (target.mode === 'create') {
          if (!OID.test(target.startPoint))
            throw new MemberWorkspaceError('workspace_invalid', 'the start point must be a commit id');
          await gitIn(info.path, ['branch', '--no-track', '--', target.branch, target.startPoint]);
        } else {
          if (!(await plainGitSucceeds(['check-ref-format', target.source.ref])))
            throw new MemberWorkspaceError('workspace_invalid', 'invalid source ref');
          try {
            // A new local branch: only committed work travels, nothing is overwritten.
            await fetchInto(info.path, { path: target.source.path, refs: [target.source.ref] }, [
              `${target.source.ref}:${ref}`,
            ]);
          } catch (err) {
            throw new MemberWorkspaceError(
              'workspace_fetch_failed',
              `could not fetch ${target.source.ref}: ${(err as Error).message}`,
              { branch: target.branch },
            );
          }
        }
      }
      const current = await checkoutOf(info.path);
      if (current?.branch !== target.branch) {
        await gitIn(info.path, ['switch', '--quiet', '--no-guess', target.branch], CHECKOUT_TIMEOUT_MS);
        log.info(
          { path: info.path, from: current?.branch ?? current?.head ?? null, to: target.branch },
          'switched member workspace branch',
        );
      }
      return (await checkoutOf(info.path))!;
    });
  }

  async function checkoutReview(
    key: MemberWorkspaceKey,
    source: WorkspaceSource,
    commit: string,
  ): Promise<WorkspaceCheckout> {
    const { dir, info } = await locate(key);
    return withLock(dir, async () => {
      await assertWorkspace(info);
      await assertDependenciesIdle(key, info);
      if (!OID.test(commit)) throw new MemberWorkspaceError('workspace_invalid', 'invalid review commit');
      if (!(await plainGitSucceeds(['check-ref-format', source.ref])))
        throw new MemberWorkspaceError('workspace_invalid', 'invalid source ref');
      // The same round again (a resumed review): what the reviewer did there stays as it is.
      const before = await checkoutOf(info.path);
      if (before && before.branch === null && before.head === commit && !(await operationIn(info.gitDir)))
        return before;
      await assertClean(info);
      const fetched = 'refs/projectman/review/source';
      try {
        await fetchInto(info.path, { path: source.path, refs: [source.ref] }, [`+${source.ref}:${fetched}`]);
      } catch (err) {
        throw new MemberWorkspaceError(
          'workspace_fetch_failed',
          `could not fetch ${source.ref} for review: ${(err as Error).message}`,
        );
      }
      if (!(await gitInSucceeds(info.path, ['merge-base', '--is-ancestor', commit, fetched])))
        throw new MemberWorkspaceError(
          'workspace_source_missing',
          `the commit ${commit} is not on ${source.ref} any more`,
          { commit },
        );
      const current = await checkoutOf(info.path);
      if (!current || current.branch !== null || current.head !== commit) {
        await gitIn(info.path, ['switch', '--quiet', '--detach', commit], CHECKOUT_TIMEOUT_MS);
      }
      return (await checkoutOf(info.path))!;
    });
  }

  return {
    listSnapshotTasks,
    removeTaskSnapshots,
    location,
    home,
    ensure,
    status,
    sourceHead,
    fetchBase,
    prepareDependencies,
    findTaskBranch,
    resolveSource,
    checkoutTaskBranch,
    checkoutReview,
    publishTaskBranch,
  };
}

function dependencyError(err: unknown): unknown {
  const failure = err as { code?: unknown; details?: Record<string, unknown> } | null;
  if (failure?.code === 'workspace_dependencies_pending' || failure?.code === 'workspace_dependencies_failed')
    return new MemberWorkspaceError(failure.code, (err as Error).message, failure.details);
  return err;
}

async function assertBranchName(branch: string): Promise<void> {
  if (branch.startsWith('-') || !(await plainGitSucceeds(['check-ref-format', '--branch', branch])))
    throw new MemberWorkspaceError('workspace_invalid', `invalid branch name: ${JSON.stringify(branch)}`);
}

async function maybeLstat(p: string) {
  return lstat(p).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
}
