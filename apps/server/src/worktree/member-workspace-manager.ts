import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  MemberWorkspaceErrorCode,
  MemberWorkspaceInfo,
  MemberWorkspaceKey,
  MemberWorkspaceManager,
  MemberWorkspaceManagerOptions,
  WorkspaceCheckout,
  WorkspaceSource,
} from '../contracts';
import { isTaskBranch } from './branch-name';
import { git, GitCommandError } from './git';
import { canonical, createKeyedLock, isInside } from './paths';

/** A fetch that takes longer fails: a new task never starts from a base that may be stale. */
const FETCH_TIMEOUT_MS = 60_000;
/** Clones and checkouts (and large working trees) may take a while. */
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;

/**
 * Settings for every git command the server runs in a member workspace or reads from one. The
 * member controls those repositories (their config, hooks and attributes), so the server's git
 * runs no hooks or fsmonitor, reads no system or global configuration (`isolatedConfig`), and
 * transfers objects only over local paths. Filters a repository's own configuration defines still
 * apply to a checkout; until the VM boundary (PM-140) separates the server from the members, the
 * server and the sessions run as the same user anyway.
 */
const SAFE_SETTINGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'init.templateDir=',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.file.allow=always',
  '-c',
  'advice.detachedHead=false',
  '--no-replace-objects',
];

function safeGit(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  return git([...SAFE_SETTINGS, ...args], { ...opts, isolatedConfig: true });
}

async function safeGitSucceeds(args: string[]): Promise<boolean> {
  try {
    await safeGit(args);
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

/**
 * Durable workspaces, one per project x member x repository (PM-138), replacing the worktree per
 * task: `<rootDir>/<PROJECT>/<handle>/<repo>/{repo,cache,tmp}`. `repo` is an independent clone of
 * the project's repository (`--no-local`: no hardlinks, no alternates, no worktree link, its own
 * `.git`), without a remote, so nothing the member does there reaches the project repository or a
 * teammate. The server fetches into it by explicit path and moves it between branches only when it
 * is clean, never resetting, stashing or cleaning; it is never removed.
 */
export function createMemberWorkspaceManager(opts: MemberWorkspaceManagerOptions): MemberWorkspaceManager {
  const log = opts.logger;
  const withLock = createKeyedLock();
  let root: Promise<string> | undefined;

  function rootPath(): Promise<string> {
    root ??= (async () => {
      const requested = path.resolve(opts.rootDir);
      if ((await maybeLstat(requested))?.isSymbolicLink())
        throw new MemberWorkspaceError('workspace_invalid', 'the workspace root is a symlink');
      await mkdir(requested, { recursive: true, mode: 0o700 });
      return canonical(requested);
    })();
    return root;
  }

  /** The workspace's directories and the project repository it is cloned from, validated. */
  async function locate(key: MemberWorkspaceKey) {
    const { project, repoName, member } = key;
    const projectKey = project.project.key;
    const repo = project.project.repos.find((r) => r.name === repoName);
    if (!repo || !PROJECT_KEY.test(projectKey) || !REPO_NAME.test(repoName) || !HANDLE.test(member))
      throw new MemberWorkspaceError('workspace_invalid', 'invalid workspace location', {
        projectKey,
        repo: repoName,
        member,
      });
    const base = await rootPath();
    let dir = base;
    for (const part of [projectKey, member, repoName]) {
      dir = path.join(dir, part);
      const entry = await maybeLstat(dir);
      if (entry && (entry.isSymbolicLink() || !entry.isDirectory()))
        throw new MemberWorkspaceError('workspace_invalid', `${dir} is not a plain directory`);
    }
    const repoPath = path.resolve(project.project.workspacePath, repo.path);
    const workspaceRoot = await canonical(project.project.workspacePath);
    const resolvedRepo = await canonical(repoPath);
    if (resolvedRepo !== workspaceRoot && !isInside(resolvedRepo, workspaceRoot))
      throw new MemberWorkspaceError('workspace_invalid', 'the repository must be inside its workspace');
    const info: MemberWorkspaceInfo = {
      path: path.join(dir, 'repo'),
      gitDir: path.join(dir, 'repo', '.git'),
      cacheDir: path.join(dir, 'cache'),
      tempDir: path.join(dir, 'tmp'),
    };
    return { dir, info, repoPath: resolvedRepo, defaultBranch: repo.defaultBranch };
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
    let dir = await rootPath();
    for (const part of [key.projectKey, key.member, '.home']) {
      dir = path.join(dir, part);
      const entry = await maybeLstat(dir);
      if (entry && (entry.isSymbolicLink() || !entry.isDirectory()))
        throw new MemberWorkspaceError('workspace_invalid', `${dir} is not a plain directory`);
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
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
    const gitDir = (await safeGit(['-C', info.path, 'rev-parse', '--absolute-git-dir'])).trim();
    if ((await canonical(gitDir)) !== (await canonical(info.gitDir)))
      throw new MemberWorkspaceError('workspace_invalid', `${info.path} uses another git directory`);
  }

  async function ensure(key: MemberWorkspaceKey): Promise<MemberWorkspaceInfo & { created: boolean }> {
    const { dir, info, repoPath } = await locate(key);
    return withLock(dir, async () => {
      let created = false;
      if (!(await maybeLstat(info.path))) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // An interrupted clone is thrown away: no session ever ran in it.
        const partial = path.join(dir, 'repo.partial');
        await rm(partial, { recursive: true, force: true });
        await safeGit(['clone', '--quiet', '--no-local', '--template=', '--', repoPath, partial], {
          timeoutMs: CHECKOUT_TIMEOUT_MS,
        });
        // No remote: the server fetches by path, and a push has nowhere to go.
        await safeGit(['-C', partial, 'remote', 'remove', 'origin']);
        await rename(partial, info.path);
        await writeFile(
          path.join(dir, 'workspace.json'),
          `${JSON.stringify({ projectKey: key.project.project.key, member: key.member, repo: key.repoName })}\n`,
          { mode: 0o600 },
        );
        created = true;
        log.info({ member: key.member, repo: key.repoName, path: info.path }, 'created member workspace');
      }
      await assertWorkspace(info);
      await mkdir(info.cacheDir, { recursive: true, mode: 0o700 });
      await mkdir(info.tempDir, { recursive: true, mode: 0o700 });
      return { ...info, created };
    });
  }

  async function checkoutOf(dir: string): Promise<WorkspaceCheckout | null> {
    const head = await safeGit(['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(
      () => null,
    );
    if (!head) return null;
    const branch = await safeGit(['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
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
    const porcelain = await safeGit(['-C', info.path, 'status', '--porcelain', '--untracked-files=normal']);
    return { dirty: porcelain.trim().length > 0, operation, checkout: await checkoutOf(info.path) };
  }

  async function status(key: MemberWorkspaceKey) {
    const { dir, info } = await locate(key);
    return withLock(dir, async () => {
      await assertWorkspace(info);
      return inspect(info);
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
      const ref = await baseRef(repoPath, defaultBranch);
      const tracking = `refs/remotes/upstream/${defaultBranch}`;
      try {
        await safeGit(
          ['-C', info.path, 'fetch', '--quiet', '--no-tags', '--', repoPath, `+${ref}:${tracking}`],
          {
            timeoutMs: FETCH_TIMEOUT_MS,
          },
        );
      } catch (err) {
        throw new MemberWorkspaceError(
          'workspace_fetch_failed',
          `could not fetch ${defaultBranch} into the workspace: ${(err as Error).message}`,
          { branch: defaultBranch },
        );
      }
      const commit = (
        await safeGit(['-C', info.path, 'rev-parse', '--verify', `${tracking}^{commit}`])
      ).trim();
      // The member's own default branch follows when it only falls behind (never rewritten).
      const checkout = await checkoutOf(info.path);
      if (checkout?.branch !== defaultBranch) {
        await safeGit([
          '-C',
          info.path,
          'fetch',
          '--quiet',
          '--no-tags',
          '--',
          info.path,
          `${tracking}:refs/heads/${defaultBranch}`,
        ]).catch((err: unknown) =>
          log.debug({ err, path: info.path }, 'the workspace default branch was not fast-forwarded'),
        );
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
      if (
        hasLocal &&
        (await safeGitSucceeds(['-C', repoPath, 'merge-base', '--is-ancestor', remoteRef, localRef]))
      )
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
      return null;
    });
  }

  async function resolveSource(source: WorkspaceSource): Promise<string | null> {
    if (!(await safeGitSucceeds(['check-ref-format', source.ref]))) return null;
    const out = await safeGit([
      '-C',
      source.path,
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
          await safeGit(['-C', info.path, 'branch', '--no-track', '--', target.branch, target.startPoint]);
        } else {
          if (!(await safeGitSucceeds(['check-ref-format', target.source.ref])))
            throw new MemberWorkspaceError('workspace_invalid', 'invalid source ref');
          try {
            // A new local branch: only committed work travels, nothing is overwritten.
            await safeGit(
              [
                '-C',
                info.path,
                'fetch',
                '--quiet',
                '--no-tags',
                '--',
                target.source.path,
                `${target.source.ref}:${ref}`,
              ],
              { timeoutMs: FETCH_TIMEOUT_MS },
            );
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
        await safeGit(['-C', info.path, 'switch', '--quiet', '--no-guess', target.branch], {
          timeoutMs: CHECKOUT_TIMEOUT_MS,
        });
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
      if (!OID.test(commit)) throw new MemberWorkspaceError('workspace_invalid', 'invalid review commit');
      if (!(await safeGitSucceeds(['check-ref-format', source.ref])))
        throw new MemberWorkspaceError('workspace_invalid', 'invalid source ref');
      // The same round again (a resumed review): what the reviewer did there stays as it is.
      const before = await checkoutOf(info.path);
      if (before && before.branch === null && before.head === commit && !(await operationIn(info.gitDir)))
        return before;
      await assertClean(info);
      const fetched = 'refs/projectman/review/source';
      try {
        await safeGit(
          ['-C', info.path, 'fetch', '--quiet', '--no-tags', '--', source.path, `+${source.ref}:${fetched}`],
          {
            timeoutMs: FETCH_TIMEOUT_MS,
          },
        );
      } catch (err) {
        throw new MemberWorkspaceError(
          'workspace_fetch_failed',
          `could not fetch ${source.ref} for review: ${(err as Error).message}`,
        );
      }
      if (!(await safeGitSucceeds(['-C', info.path, 'merge-base', '--is-ancestor', commit, fetched])))
        throw new MemberWorkspaceError(
          'workspace_source_missing',
          `the commit ${commit} is not on ${source.ref} any more`,
          { commit },
        );
      const current = await checkoutOf(info.path);
      if (!current || current.branch !== null || current.head !== commit) {
        await safeGit(['-C', info.path, 'switch', '--quiet', '--detach', commit], {
          timeoutMs: CHECKOUT_TIMEOUT_MS,
        });
      }
      return (await checkoutOf(info.path))!;
    });
  }

  return {
    location,
    home,
    ensure,
    status,
    fetchBase,
    findTaskBranch,
    resolveSource,
    checkoutTaskBranch,
    checkoutReview,
  };
}

async function assertBranchName(branch: string): Promise<void> {
  if (branch.startsWith('-') || !(await safeGitSucceeds(['check-ref-format', '--branch', branch])))
    throw new MemberWorkspaceError('workspace_invalid', `invalid branch name: ${JSON.stringify(branch)}`);
}

function refExists(repo: string, ref: string): Promise<boolean> {
  return safeGitSucceeds(['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/** The task's branch under `prefix`: the preferred name if present, else the first match. */
async function taskBranches(
  repo: string,
  prefix: 'refs/heads/' | 'refs/remotes/origin/',
  taskKey: string,
  preferred?: string,
): Promise<string | null> {
  const out = await safeGit(['-C', repo, 'for-each-ref', '--format=%(refname)', prefix]);
  const names = out
    .split('\n')
    .filter((ref) => ref.startsWith(prefix))
    .map((ref) => ref.slice(prefix.length))
    .filter((name) => isTaskBranch(name, taskKey))
    .sort();
  if (preferred && names.includes(preferred)) return preferred;
  return names[0] ?? null;
}

async function maybeLstat(p: string) {
  return lstat(p).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
}
