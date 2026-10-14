import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile as readFileBytes, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MergeError, type BranchMerger, type MergeRepoRef } from '../contracts';
import { DEPENDENCY_LOCKFILE, findDependencyReference } from '../worktree';
import { runGit } from './merge-git';
import { invalidInput, isMergeId, type MergeArgs } from './merge-input';
import { listWorktrees, must } from './merge-repo';
import { isWithin } from './within';

/**
 * The check checkout of a merge and the dependencies copied into it (PM-451, PM-580): a detached
 * worktree of the merge commit under `<worktreesRoot>/_merge/<mergeId>`, made for the card's checks.
 */

export const MERGE_CHECK_DIR = '_merge';
export const DEPENDENCIES_NOT_INSTALLED =
  "No checkout of the repository has the dependencies of the merge result installed (its package-lock.json matches no installed checkout). Install them with npm ci in a checkout whose package-lock.json is the merge result's: the repository's own checkout of the default branch when the card does not change the dependencies, otherwise the card's worktree after merging the default branch into it. Then retry merge_task.";
const MAX_NODE_MODULES_DEPTH = 2; // the root, `*/` and `*/*/`
const DEPENDENCY_COPY_TIMEOUT_MS = 300_000;
/** Caches under node_modules that may hold absolute paths of the place they were made in. */
const CACHE_DIRS = ['.vite', '.vite-temp', '.cache'];

export interface MergeCheckOptions {
  args: MergeArgs;
  /** The engine's worktrees root; the checks live in `<worktreesRoot>/_merge/<mergeId>`. null: no check checkouts. */
  worktreesRoot: string | null;
  platform: NodeJS.Platform;
  /** The budget for copying dependencies into a check checkout. */
  copyTimeoutMs?: number;
}

export function createMergeChecks(
  options: MergeCheckOptions,
): Pick<BranchMerger, 'checkoutForCheck' | 'releaseCheck'> {
  const { args, platform } = options;

  const checkRoot = async (): Promise<string> => {
    if (!options.worktreesRoot) return invalidInput('This engine has no worktrees root');
    const root = path.join(await realpath(options.worktreesRoot), MERGE_CHECK_DIR);
    const known = await lstat(root).catch(() => null);
    if (known && (!known.isDirectory() || known.isSymbolicLink()))
      return invalidInput(`${root} is not a directory`);
    return root;
  };

  /** The directories (relative, '' is the root) that hold a real `node_modules`, down to three levels. */
  const dependencyParents = async (root: string): Promise<string[]> => {
    const realDirectory = async (dir: string) => {
      const info = await lstat(dir).catch(() => null);
      return info !== null && info.isDirectory() && !info.isSymbolicLink();
    };
    const found: string[] = [];
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (await realDirectory(path.join(root, relative, 'node_modules'))) found.push(relative);
      if (depth >= MAX_NODE_MODULES_DEPTH) return;
      const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(path.join(relative, entry.name), depth + 1);
      }
    };
    await walk('', 0);
    return found;
  };
  const copyTree = (source: string, dest: string, clone: boolean, timeoutMs: number): Promise<void> =>
    new Promise((resolve, reject) => {
      // `-P`: a link is copied as a link (the workspace links are relative and point into the new tree).
      const cpArgs = [...(clone ? ['-c'] : []), '-R', '-P', source, dest];
      execFile(
        'cp',
        cpArgs,
        { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeout: timeoutMs, windowsHide: true },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  const copyDependencies = async (from: string, target: string): Promise<void> => {
    const deadline = Date.now() + (options.copyTimeoutMs ?? DEPENDENCY_COPY_TIMEOUT_MS);
    for (const parent of await dependencyParents(from)) {
      const holder = path.join(target, parent);
      const holderInfo = await lstat(holder).catch(() => null);
      // The merged tree may not have that directory any more, or may track something of that name.
      if (!holderInfo || !holderInfo.isDirectory() || holderInfo.isSymbolicLink()) continue;
      // The merged tree is the card's: a tracked link on any part of the path (`apps -> /elsewhere`) would
      // lead the copy out of the check worktree. `target` is already a real path, so the real holder must
      // be exactly where the path says.
      if ((await realpath(holder).catch(() => null)) !== holder) continue;
      const dest = path.join(holder, 'node_modules');
      if (await lstat(dest).catch(() => null)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new MergeError('git_failed', 'copying the dependencies timed out');
      const source = path.join(from, parent, 'node_modules');
      if (platform === 'darwin') {
        try {
          await copyTree(source, dest, true, remaining);
        } catch {
          await rm(dest, { recursive: true, force: true });
          await copyTree(source, dest, false, Math.max(deadline - Date.now(), 1000));
        }
      } else await copyTree(source, dest, false, remaining);
      for (const cache of CACHE_DIRS) await rm(path.join(dest, cache), { recursive: true, force: true });
    }
  };

  const release = async (repo: string, target: string): Promise<void> => {
    const known = await lstat(target).catch(() => null);
    if (known?.isSymbolicLink() || (known && !known.isDirectory())) {
      await unlink(target);
    } else if (known) {
      await runGit(repo, ['worktree', 'remove', '--force', '--force', target]);
      await rm(target, { recursive: true, force: true });
    }
    await runGit(repo, ['worktree', 'prune']);
  };

  const dependencySource = async (repo: string, target: string, preferred: string | null) => {
    const source = preferred === null ? null : await realpath(preferred).catch(() => null);
    if (preferred !== null && source === null) invalidInput('The dependencies path does not exist');
    const overlaps = (candidate: string) => isWithin(target, candidate) || isWithin(candidate, target);
    if (source !== null && overlaps(source))
      invalidInput('The dependencies path overlaps the check checkout');
    const lockPath = path.join(target, DEPENDENCY_LOCKFILE);
    const info = await lstat(lockPath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) return { path: source, reference: null, lock: null };
    const lock = await readFileBytes(lockPath);
    const candidates = new Set<string>();
    const add = (candidate: string | null) => {
      if (candidate !== null && !overlaps(candidate)) candidates.add(candidate);
    };
    add(source);
    add(await realpath(repo));
    const root = await realpath(options.worktreesRoot!);
    const mergeRoot = path.join(root, MERGE_CHECK_DIR);
    const worktrees = await listWorktrees(repo);
    for (const worktree of worktrees) {
      if (worktree.prunable) continue;
      const candidate = await realpath(worktree.path).catch(() => null);
      if (candidate !== null && isWithin(root, candidate) && !isWithin(mergeRoot, candidate)) add(candidate);
    }
    const reference = await findDependencyReference([...candidates], target, lock);
    if (!reference) throw new MergeError('git_failed', DEPENDENCIES_NOT_INSTALLED);
    return { path: reference.path, reference, lock };
  };

  const checkoutForCheck = async (
    ref: MergeRepoRef,
    input: { mergeId: string; mergeCommit: string; depsFrom: string | null },
  ): Promise<{ path: string; gitDir: string }> => {
    const repo = args.repo(ref);
    if (!isMergeId(input.mergeId)) invalidInput('Not a merge id');
    const mergeCommit = args.commit(input.mergeCommit, 'The merge commit');
    if (input.depsFrom !== null && !path.isAbsolute(input.depsFrom))
      invalidInput('The dependencies path is not absolute');
    const root = await checkRoot();
    const target = path.join(root, input.mergeId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // A leftover of an earlier try with this id is made again from scratch.
    await release(repo, target);
    await must(repo, ['worktree', 'add', '--detach', target, mergeCommit], 'worktree add');
    try {
      const realTarget = await realpath(target);
      const source = await dependencySource(repo, realTarget, input.depsFrom);
      if (source.path !== null) await copyDependencies(source.path, realTarget);
      if (source.reference !== null && source.lock !== null) {
        const after = await findDependencyReference([source.reference.path], realTarget, source.lock);
        if (!after || after.installedAt !== source.reference.installedAt)
          throw new MergeError(
            'git_failed',
            'the dependency source changed while it was copied; retry the merge',
          );
      }
      const commonDir = (
        await must(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'rev-parse')
      ).trim();
      return { path: await realpath(target), gitDir: await realpath(commonDir) };
    } catch (error) {
      await release(repo, target).catch(() => {});
      throw error;
    }
  };

  const releaseCheck = async (ref: MergeRepoRef, input: { mergeId: string }): Promise<void> => {
    const repo = args.repo(ref);
    if (!isMergeId(input.mergeId)) invalidInput('Not a merge id');
    const root = await checkRoot();
    await release(repo, path.join(root, input.mergeId));
  };

  return { checkoutForCheck, releaseCheck };
}
