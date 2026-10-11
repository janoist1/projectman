import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { TaskKey, type ProjectConfig } from '@projectman/shared';
import type {
  DependencyRefreshResult,
  SourceHead,
  WorktreeInfo,
  WorktreeManager,
  WorktreeManagerOptions,
} from '../contracts';
import { isTaskBranch, taskBranchName } from './branch-name';
import { cloneDependencies, dependencyState } from './dependencies';
import { git, gitSucceeds, isoOrNull, tryGit } from './git';
import { canonical, createKeyedLock, isInside } from './paths';

/** A fetch that takes longer is abandoned; the worktree starts from the last known state. */
const FETCH_TIMEOUT_MS = 60_000;
/** Checkouts (and the repository's checkout hooks, e.g. Git LFS) may take a while. */
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;
const DEPENDENCY_RETRY_MS = 60_000;

export type WorktreeErrorCode =
  | 'invalid_task_key'
  | 'unknown_repo'
  | 'not_a_repository'
  | 'no_start_point'
  | 'path_taken'
  | 'branch_in_main_checkout'
  | 'not_a_worktree'
  | 'main_worktree'
  | 'outside_root'
  | 'dirty';

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;

  constructor(code: WorktreeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'WorktreeError';
  }
}

interface ListedWorktree {
  path: string;
  /** Short branch name; null when detached or bare. */
  branch: string | null;
  /** The repository's main checkout (listed first by git). */
  main: boolean;
  prunable: boolean;
}

/**
 * Git worktrees for tasks, so every developer session works on its own branch without
 * touching the main checkout that people and other sessions use.
 *
 * - Path: `<rootDir>/<projectKey>/<TASKKEY>-<repo>`; branch: `<TASKKEY>-<slug of the title>`.
 * - ensureForTask reuses what exists: the worktree at that path, or the task's branch
 *   (a local `<TASKKEY>` / `<TASKKEY>-*` branch, then `origin/<TASKKEY>-*`) wherever it is
 *   checked out. Only a brand-new branch fetches `origin <defaultBranch>` (failures are
 *   logged and tolerated, e.g. offline). It starts from the local default when it is equal to
 *   or ahead of origin, otherwise from origin (including diverged histories), falling back
 *   to the local default when origin is absent; it gets no upstream until it is pushed.
 * - With cloneDependencies, ensureForTask then clones node_modules into the worktree (new or
 *   existing, when missing or its hidden npm lockfile predates package-lock.json) from an
 *   installed checkout with the same lockfile (PM-332, PM-412,
 *   dependencies.ts); that never fails the call.
 * - remove only touches worktrees under rootDir, refuses dirty ones unless forced and never
 *   deletes the branch.
 */
export function createWorktreeManager(opts: WorktreeManagerOptions): WorktreeManager {
  const rootDir = path.resolve(opts.rootDir);
  const log = opts.logger;
  const withLock = createKeyedLock();
  const withDependencyLock = createKeyedLock();
  const dependencyRepos = new Map<string, string>();
  const dependencyFailures = new Map<
    string,
    { lockTime: number | null; at: number; result: DependencyRefreshResult }
  >();

  async function taskLocation(args: { project: ProjectConfig; repoName: string; taskKey: string }) {
    const { project, repoName, taskKey } = args;
    if (!TaskKey.safeParse(taskKey).success) {
      throw new WorktreeError('invalid_task_key', `invalid task key: ${JSON.stringify(taskKey)}`);
    }
    const repo = project.project.repos.find((r) => r.name === repoName);
    if (!repo) {
      throw new WorktreeError(
        'unknown_repo',
        `project ${project.project.key} has no repo named "${repoName}"`,
      );
    }
    if (
      !/^[A-Z][A-Z0-9]{0,9}$/.test(project.project.key) ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(repo.name) ||
      !taskKey.startsWith(`${project.project.key}-`)
    )
      throw new WorktreeError('outside_root', 'invalid project worktree path');
    const repoPath = path.resolve(project.project.workspacePath, repo.path);
    const workspace = await canonical(project.project.workspacePath);
    const resolvedRepo = await canonical(repoPath);
    if (resolvedRepo !== workspace && !isInside(resolvedRepo, workspace))
      throw new WorktreeError('outside_root', 'repository must be inside its workspace');
    if (!(await gitSucceeds(['check-ref-format', '--branch', repo.defaultBranch])))
      throw new WorktreeError('no_start_point', 'invalid default branch');
    const target = path.join(rootDir, project.project.key, `${taskKey}-${repo.name}`);

    if (
      !isInside(await canonical(target), await canonical(path.join(rootDir, project.project.key))) ||
      !isInside(await canonical(path.join(rootDir, project.project.key)), await canonical(rootDir))
    )
      throw new WorktreeError('outside_root', 'worktree must stay inside its project folder');
    await assertRepositoryRoot(repoPath);
    return { repo, repoPath, target };
  }

  async function worktreeInfo(dir: string, branch: string, repo: string): Promise<WorktreeInfo> {
    const commonDir =
      (await tryGit(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])) ??
      (await git(['-C', dir, 'rev-parse', '--git-common-dir']));
    const adminDir =
      (await tryGit(['-C', dir, 'rev-parse', '--absolute-git-dir'])) ??
      (await git(['-C', dir, 'rev-parse', '--git-dir']));
    return {
      path: dir,
      branch,
      repo,
      gitDir: path.resolve(dir, commonDir.trim()),
      worktreeGitDir: path.resolve(dir, adminDir.trim()),
    };
  }

  async function find(args: {
    project: ProjectConfig;
    repoName: string;
    taskKey: string;
  }): Promise<WorktreeInfo | null> {
    const { repo, repoPath, target } = await taskLocation(args);
    return withLock(await canonical(repoPath), async () => {
      const found = await findByPath(await listWorktrees(repoPath), target);
      if (!found) return null;
      const branch = found.branch ?? (await git(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      return worktreeInfo(target, branch, repo.name);
    });
  }

  async function ensureForTask(args: {
    project: ProjectConfig;
    repoName: string;
    taskKey: string;
    title: string;
  }): Promise<WorktreeInfo> {
    const { repo, repoPath, target } = await taskLocation(args);
    const info = await ensureWorktree(args, { repo, repoPath, target });
    // Outside the repository's lock: the clone is slow-ish I/O that other tasks need not wait for.
    dependencyRepos.set(path.resolve(info.path), repoPath);
    dependencyRepos.set(await canonical(info.path), repoPath);
    await refreshDependencies(info.path);
    return info;
  }

  async function refreshDependencies(worktreePath: string): Promise<DependencyRefreshResult> {
    if (!opts.cloneDependencies) return { status: 'skipped', reason: 'disabled' };
    try {
      const repoPath = dependencyRepos.get(path.resolve(worktreePath));
      if (!repoPath) return { status: 'skipped', reason: 'not_worktree' };
      const own = await canonical(worktreePath);
      if ((await dependencyState(own)).fresh) {
        dependencyFailures.delete(own);
        return { status: 'skipped', reason: 'present' };
      }
      return await withDependencyLock(own, async () => {
        const state = await dependencyState(own);
        if (state.fresh) {
          dependencyFailures.delete(own);
          return { status: 'skipped', reason: 'present' };
        }
        const previous = dependencyFailures.get(own);
        if (
          previous &&
          previous.lockTime === state.lockTime &&
          Date.now() - previous.at < DEPENDENCY_RETRY_MS
        ) {
          log.debug({ path: own, result: previous.result }, 'dependency refresh retry deferred');
          return previous.result;
        }
        const candidates = [repoPath];
        for (const listed of await listWorktrees(repoPath)) {
          if (listed.prunable) continue;
          const listedPath = await canonical(listed.path);
          if (listedPath === own || listedPath === (await canonical(repoPath))) continue;
          candidates.push(listed.path);
        }
        const result = await cloneDependencies({ target: own, candidates, logger: log });
        if (result.status !== 'skipped') {
          const { reference, dirs, ms } = result;
          log.info(
            { path: own, reference, dirs, ms },
            result.status === 'cloned'
              ? 'dependencies cloned into the worktree'
              : 'dependencies refreshed in the worktree',
          );
          dependencyFailures.delete(own);
        } else {
          log.debug({ path: own, reason: result.reason }, 'dependencies not cloned into the worktree');
          if (['no_reference', 'unsupported', 'failed'].includes(result.reason)) {
            dependencyFailures.set(own, { lockTime: state.lockTime, at: Date.now(), result });
            log.info({ path: own, reason: result.reason }, 'worktree dependencies left unchanged');
          }
        }
        return result;
      });
    } catch (err) {
      log.warn(
        { path: worktreePath, err: err instanceof Error ? err.message : String(err) },
        'cloning the dependencies failed; the member installs them',
      );
      return { status: 'skipped', reason: 'failed' };
    }
  }

  async function ensureWorktree(
    args: { project: ProjectConfig; repoName: string; taskKey: string; title: string },
    location: { repo: ProjectConfig['project']['repos'][number]; repoPath: string; target: string },
  ): Promise<WorktreeInfo> {
    const { project, taskKey, title } = args;
    const { repo, repoPath, target } = location;
    return withLock(await canonical(repoPath), async () => {
      await git(['-C', repoPath, 'worktree', 'prune']);
      const worktrees = await listWorktrees(repoPath);

      const atTarget = await findByPath(worktrees, target);
      if (atTarget) {
        const branch =
          atTarget.branch ?? (await git(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        log.debug({ repo: repo.name, taskKey, path: target, branch }, 'reusing task worktree');
        return worktreeInfo(target, branch, repo.name);
      }

      const wanted = taskBranchName(taskKey, title);
      const local = await findTaskBranch(repoPath, 'refs/heads/', taskKey, wanted);
      const branch = local ?? wanted;
      const holder = local ? worktrees.find((w) => w.branch === local && !w.prunable) : undefined;
      if (holder) {
        if (holder.main) {
          throw new WorktreeError(
            'branch_in_main_checkout',
            `branch ${local} is checked out in the main checkout ${holder.path}; switch that checkout to another branch first`,
          );
        }
        if (!isInside(await canonical(holder.path), await canonical(path.join(rootDir, project.project.key))))
          throw new WorktreeError('outside_root', 'existing task worktree is outside its project folder');
        log.info(
          { repo: repo.name, taskKey, path: holder.path, branch },
          'reusing the worktree of the task branch',
        );
        return worktreeInfo(holder.path, branch, repo.name);
      }

      await assertFreeDirectory(target, repoPath);
      await mkdir(path.dirname(target), { recursive: true });

      if (local) {
        await git(['-C', repoPath, 'worktree', 'add', target, local], { timeoutMs: CHECKOUT_TIMEOUT_MS });
        log.info(
          { repo: repo.name, taskKey, path: target, branch },
          'created task worktree on its existing branch',
        );
        return worktreeInfo(target, branch, repo.name);
      }

      const remote = await findTaskBranch(repoPath, 'refs/remotes/origin/', taskKey, wanted);
      if (remote) {
        await git(
          [
            '-C',
            repoPath,
            'worktree',
            'add',
            '--track',
            '-b',
            remote,
            target,
            `refs/remotes/origin/${remote}`,
          ],
          { timeoutMs: CHECKOUT_TIMEOUT_MS },
        );
        log.info(
          { repo: repo.name, taskKey, path: target, branch: remote },
          'created task worktree from origin',
        );
        return worktreeInfo(target, remote, repo.name);
      }

      const startPoint = await startPointFor(repoPath, repo.defaultBranch);
      await git(['-C', repoPath, 'worktree', 'add', '--no-track', '-b', branch, target, startPoint], {
        timeoutMs: CHECKOUT_TIMEOUT_MS,
      });
      log.info({ repo: repo.name, taskKey, path: target, branch, startPoint }, 'created task worktree');
      return worktreeInfo(target, branch, repo.name);
    });
  }

  async function startPointFor(repoPath: string, defaultBranch: string): Promise<string> {
    const remoteRef = `refs/remotes/origin/${defaultBranch}`;
    if (await hasRemote(repoPath, 'origin')) {
      try {
        await git(['-C', repoPath, 'fetch', '--quiet', '--', 'origin', defaultBranch], {
          timeoutMs: FETCH_TIMEOUT_MS,
        });
      } catch (err) {
        log.warn(
          { repo: repoPath, err: err instanceof Error ? err.message : String(err) },
          'git fetch failed; starting from the last known state of the default branch',
        );
      }
    }
    const localRef = `refs/heads/${defaultBranch}`;
    const localExists = await refExists(repoPath, localRef);
    if (await refExists(repoPath, remoteRef)) {
      if (
        localExists &&
        (await gitSucceeds(['-C', repoPath, 'merge-base', '--is-ancestor', remoteRef, localRef]))
      )
        return localRef;
      return remoteRef;
    }
    if (localExists) return localRef;
    throw new WorktreeError(
      'no_start_point',
      `neither origin/${defaultBranch} nor ${defaultBranch} exists in ${repoPath}`,
    );
  }

  async function status(worktreePath: string): Promise<{ dirty: boolean; unpushedCommits: number }> {
    const dir = path.resolve(worktreePath);
    const porcelain = await git(['-C', dir, 'status', '--porcelain']);
    return { dirty: porcelain.trim().length > 0, unpushedCommits: await unpushedCommits(dir) };
  }

  async function head(worktreePath: string): Promise<SourceHead | null> {
    const dir = path.resolve(worktreePath);
    const commit = (await tryGit(['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim();
    const branch = (await tryGit(['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim();
    if (!commit || !branch) return null;
    const changes = (await git(['-C', dir, 'status', '--porcelain'])).split('\n').filter(Boolean).length;
    const committedAt = isoOrNull(await tryGit(['-C', dir, 'log', '-1', '--format=%cI', commit]));
    return { commit, branch, dirty: changes > 0, changes, path: dir, committedAt };
  }

  async function remove(args: { path: string; force?: boolean }): Promise<void> {
    const dir = path.resolve(args.path);
    const force = args.force ?? false;
    if (!(await exists(dir))) {
      const removedPath = await canonical(dir);
      dependencyRepos.delete(dir);
      dependencyRepos.delete(removedPath);
      dependencyFailures.delete(removedPath);
      log.debug({ path: dir }, 'worktree already removed');
      return;
    }
    if (!isInside(await canonical(dir), await canonical(rootDir))) {
      throw new WorktreeError(
        'outside_root',
        `${dir} is not under ${rootDir}; only worktrees created by projectman are removed`,
      );
    }
    let worktrees: ListedWorktree[];
    try {
      worktrees = await listWorktrees(dir);
    } catch {
      throw new WorktreeError('not_a_worktree', `${dir} is not a git worktree`);
    }
    const self = await findByPath(worktrees, dir);
    const main = worktrees[0];
    if (!self || !main) throw new WorktreeError('not_a_worktree', `${dir} is not a git worktree`);
    if (self.main) throw new WorktreeError('main_worktree', `${dir} is a main checkout, not a task worktree`);

    await withLock(await canonical(main.path), async () => {
      if (!force && (await status(dir)).dirty) {
        throw new WorktreeError(
          'dirty',
          `${dir} has uncommitted changes; commit them or remove it with force`,
        );
      }
      const removedPath = await canonical(dir);
      await git(['-C', main.path, 'worktree', 'remove', ...(force ? ['--force'] : []), dir]);
      dependencyRepos.delete(dir);
      dependencyRepos.delete(removedPath);
      dependencyFailures.delete(removedPath);
      log.info({ path: dir, branch: self.branch, force }, 'removed task worktree (branch kept)');
    });
  }

  async function fixLocation(args: { project: ProjectConfig; repoName: string; taskKey: string }) {
    const location = await taskLocation(args);
    const target = path.join(
      rootDir,
      args.project.project.key,
      '_merge-fix',
      `${args.taskKey}-${location.repo.name}`,
    );
    const projectRoot = await canonical(path.join(rootDir, args.project.project.key));
    if (
      (await canonical(path.dirname(target))) !== path.join(projectRoot, '_merge-fix') ||
      (await canonical(target)) !== path.join(projectRoot, '_merge-fix', path.basename(target))
    )
      throw new WorktreeError('outside_root', 'merge fix must stay inside its project folder');
    return { ...location, target, branch: `merge-fix/${args.taskKey}` };
  }

  async function findMergeFix(args: { project: ProjectConfig; repoName: string; taskKey: string }) {
    const { repo, repoPath, target, branch } = await fixLocation(args);
    return withLock(await canonical(repoPath), async () => {
      const found = await findByPath(await listWorktrees(repoPath), target);
      if (!found) return null;
      if (found.branch !== branch)
        throw new WorktreeError('path_taken', 'merge-fix path holds another branch');
      return worktreeInfo(target, branch, repo.name);
    });
  }

  async function ensureMergeFix(args: {
    project: ProjectConfig;
    repoName: string;
    taskKey: string;
    commit: string;
  }) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(args.commit))
      throw new WorktreeError('no_start_point', 'merge fix needs a commit id');
    const { repo, repoPath, target, branch } = await fixLocation(args);
    const info = await withLock(await canonical(repoPath), async () => {
      const listed = await listWorktrees(repoPath);
      const found = await findByPath(listed, target);
      if (found) {
        if (
          found.branch !== branch ||
          !(await gitSucceeds(['-C', target, 'merge-base', '--is-ancestor', args.commit, 'HEAD']))
        )
          throw new WorktreeError('path_taken', 'merge-fix checkout does not contain the approved commit');
        return worktreeInfo(target, branch, repo.name);
      }
      if (await exists(target)) throw new WorktreeError('path_taken', 'merge-fix path already exists');
      if (await refExists(repoPath, `refs/heads/${branch}`))
        throw new WorktreeError('path_taken', 'merge-fix branch already exists without its checkout');
      await mkdir(path.dirname(target), { recursive: true });
      await git(['-C', repoPath, 'worktree', 'add', '-b', branch, target, args.commit], {
        timeoutMs: CHECKOUT_TIMEOUT_MS,
      });
      return worktreeInfo(target, branch, repo.name);
    });
    dependencyRepos.set(path.resolve(info.path), repoPath);
    dependencyRepos.set(await canonical(info.path), repoPath);
    await refreshDependencies(info.path);
    return info;
  }

  async function removeMergeFix(args: { project: ProjectConfig; repoName: string; taskKey: string }) {
    const location = await fixLocation(args);
    const found = await findMergeFix(args);
    if (found) await remove({ path: found.path });
    await withLock(await canonical(location.repoPath), async () => {
      if (await refExists(location.repoPath, `refs/heads/${location.branch}`))
        await git(['-C', location.repoPath, 'branch', '-D', '--', location.branch]);
    });
  }

  async function listMergeFixes(args: { project: ProjectConfig; repoName: string }) {
    // Resolve and validate the repository through the same boundary as task operations.
    const location = await taskLocation({ ...args, taskKey: `${args.project.project.key}-1` });
    const branches = (
      await git([
        '-C',
        location.repoPath,
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads/merge-fix/',
      ])
    )
      .trim()
      .split('\n');
    const fixes: Array<{ taskKey: string; path: string }> = [];
    for (const branch of branches) {
      const taskKey = branch.slice('merge-fix/'.length);
      if (!TaskKey.safeParse(taskKey).success || !taskKey.startsWith(`${args.project.project.key}-`))
        continue;
      const fix = await fixLocation({ ...args, taskKey });
      fixes.push({ taskKey, path: fix.target });
    }
    return fixes;
  }

  return {
    ensureMergeFix,
    findMergeFix,
    removeMergeFix,
    listMergeFixes,
    ensureForTask,
    refreshDependencies,
    find,
    status,
    head,
    remove,
  };
}

async function assertRepositoryRoot(repoPath: string): Promise<void> {
  let top: string;
  try {
    top = (await git(['-C', repoPath, 'rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new WorktreeError('not_a_repository', `${repoPath} is not a git repository`);
  }
  if ((await canonical(top)) !== (await canonical(repoPath))) {
    throw new WorktreeError(
      'not_a_repository',
      `${repoPath} is inside the repository ${top} but is not its root`,
    );
  }
}

async function listWorktrees(repoPath: string): Promise<ListedWorktree[]> {
  const out = await git(['-C', repoPath, 'worktree', 'list', '--porcelain']);
  const list: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = {
        path: line.slice('worktree '.length),
        branch: null,
        main: list.length === 0,
        prunable: false,
      };
      list.push(current);
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (current && line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  return list;
}

async function findByPath(list: ListedWorktree[], wanted: string): Promise<ListedWorktree | undefined> {
  const target = await canonical(wanted);
  for (const worktree of list) {
    if (!worktree.prunable && (await canonical(worktree.path)) === target) return worktree;
  }
  return undefined;
}

/** The task's branch under `prefix`: the preferred name if present, else the first match. */
async function findTaskBranch(
  repoPath: string,
  prefix: 'refs/heads/' | 'refs/remotes/origin/',
  taskKey: string,
  preferred: string,
): Promise<string | null> {
  const out = await git(['-C', repoPath, 'for-each-ref', '--format=%(refname)', prefix]);
  const names = out
    .split('\n')
    .filter((ref) => ref.startsWith(prefix))
    .map((ref) => ref.slice(prefix.length))
    .filter((name) => isTaskBranch(name, taskKey))
    .sort();
  if (names.includes(preferred)) return preferred;
  return names[0] ?? null;
}

async function hasRemote(repoPath: string, name: string): Promise<boolean> {
  return (await git(['-C', repoPath, 'remote'])).split('\n').includes(name);
}

function refExists(repoPath: string, ref: string): Promise<boolean> {
  return gitSucceeds(['-C', repoPath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/**
 * Commits on HEAD that no remote has. Without any remote: commits on HEAD that no other
 * local branch has.
 */
async function unpushedCommits(dir: string): Promise<number> {
  if (!(await refExists(dir, 'HEAD'))) return 0;
  const remotes = (await git(['-C', dir, 'remote'])).split('\n').filter(Boolean);
  let args: string[];
  if (remotes.length > 0) {
    args = ['rev-list', '--count', 'HEAD', '--not', '--remotes'];
  } else {
    // with --branches, --exclude takes the short branch name
    const head = (await tryGit(['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim();
    args = ['rev-list', '--count', 'HEAD', '--not', ...(head ? [`--exclude=${head}`] : []), '--branches'];
  }
  return Number.parseInt((await git(['-C', dir, ...args])).trim(), 10) || 0;
}

async function assertFreeDirectory(target: string, repoPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code === 'ENOTDIR') {
      throw new WorktreeError('path_taken', `${target} exists and is not a worktree of ${repoPath}`);
    }
    throw err;
  }
  if (entries.length > 0) {
    throw new WorktreeError('path_taken', `${target} exists and is not a worktree of ${repoPath}`);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
