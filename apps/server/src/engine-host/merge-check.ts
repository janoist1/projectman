import { lstat, mkdir, readdir, readFile as readFileBytes, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  MERGE_CHECK_DIR,
  mergeCheckPath,
  MergeError,
  type BranchMerger,
  type MergeRepoRef,
} from '../contracts';
import { isWithin } from '../kernel';
import { copyDependencyTrees, DEPENDENCY_LOCKFILE, findDependencyReference } from '../worktree';
import { runGit } from './merge-git';
import { invalidInput, isMergeId, type MergeArgs } from './merge-input';
import { listWorktrees, must } from './merge-repo';

/**
 * The check checkout of a merge and the dependencies copied into it (PM-451, PM-580): a detached
 * worktree of the merge commit under `<worktreesRoot>/_merge/<mergeId>`, made for the card's checks.
 */

export { MERGE_CHECK_DIR } from '../contracts';
export const DEPENDENCIES_NOT_INSTALLED =
  "No checkout of the repository has the dependencies of the merge result installed (its package-lock.json matches no installed checkout). Install them with npm ci in a checkout whose package-lock.json is the merge result's: the repository's own checkout of the default branch when the card does not change the dependencies, otherwise the card's worktree after merging the default branch into it. Then retry merge_task.";
export interface MergeCheckOptions {
  args: MergeArgs;
  /** The engine's worktrees root; the checks live in `<worktreesRoot>/_merge/<mergeId>`. null: no check checkouts. */
  worktreesRoot: string | null;
  platform: NodeJS.Platform;
  /** The budget for copying dependencies into a check checkout. */
  copyTimeoutMs?: number;
}

/**
 * Removes the check checkouts a crash left behind (PM-837): the direct children of
 * `<worktreesRoot>/_merge` named like a merge id and not touched for `olderThanMs`. A link is judged by
 * `lstat` and unlinked, never followed. The git worktree entry of a removed checkout is pruned by the
 * next `releaseCheck`. Returns how many it removed.
 */
export async function sweepStaleChecks(
  worktreesRoot: string,
  olderThanMs: number,
  now: number = Date.now(),
): Promise<number> {
  const realRoot = await realpath(worktreesRoot).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  });
  if (realRoot === null) return 0;
  const root = path.join(realRoot, MERGE_CHECK_DIR);
  const known = await lstat(root).catch(() => null);
  if (!known?.isDirectory() || known.isSymbolicLink()) return 0;
  const names = await readdir(root);
  let removed = 0;
  for (const name of names) {
    if (!isMergeId(name)) continue;
    const target = path.join(root, name);
    const info = await lstat(target).catch(() => null);
    if (!info || now - info.mtimeMs <= olderThanMs) continue;
    if (info.isSymbolicLink()) await unlink(target);
    else if (info.isDirectory()) await rm(target, { recursive: true, force: true });
    else continue;
    removed += 1;
  }
  return removed;
}

export function createMergeChecks(
  options: MergeCheckOptions,
): Pick<BranchMerger, 'checkoutForCheck' | 'releaseCheck'> {
  const { args, platform } = options;

  const checkPath = async (mergeId: string): Promise<string> => {
    if (!options.worktreesRoot) return invalidInput('This engine has no worktrees root');
    const worktreesRoot = await realpath(options.worktreesRoot);
    const root = path.join(worktreesRoot, MERGE_CHECK_DIR);
    const known = await lstat(root).catch(() => null);
    if (known && (!known.isDirectory() || known.isSymbolicLink()))
      return invalidInput(`${root} is not a directory`);
    return mergeCheckPath(worktreesRoot, mergeId);
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

  const dependencySource = async (
    repo: string,
    target: string,
    preferred: string | null,
    allowInstall: boolean,
  ) => {
    const source = preferred === null ? null : await realpath(preferred).catch(() => null);
    if (preferred !== null && source === null) invalidInput('The dependencies path does not exist');
    const overlaps = (candidate: string) => isWithin(target, candidate) || isWithin(candidate, target);
    if (source !== null && overlaps(source))
      invalidInput('The dependencies path overlaps the check checkout');
    const lockPath = path.join(target, DEPENDENCY_LOCKFILE);
    const info = await lstat(lockPath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink())
      return { path: source, reference: null, lock: null, installRequired: false };
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
    if (!reference) {
      // No installed checkout matches the merged lockfile: the caller prepares them in the check checkout
      // when it asked for it (PM-681); old packages are never copied in their place.
      if (allowInstall) return { path: null, reference: null, lock, installRequired: true };
      throw new MergeError('git_failed', DEPENDENCIES_NOT_INSTALLED);
    }
    return { path: reference.path, reference, lock, installRequired: false };
  };

  const checkoutForCheck = async (
    ref: MergeRepoRef,
    input: {
      mergeId: string;
      mergeCommit: string;
      depsFrom: string | null;
      allowDependencyInstall?: boolean;
    },
  ): Promise<{ path: string; gitDir: string; dependencyInstallRequired?: boolean }> => {
    const repo = args.repo(ref);
    if (!isMergeId(input.mergeId)) invalidInput('Not a merge id');
    const mergeCommit = args.commit(input.mergeCommit, 'The merge commit');
    if (input.depsFrom !== null && !path.isAbsolute(input.depsFrom))
      invalidInput('The dependencies path is not absolute');
    const target = await checkPath(input.mergeId);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // A leftover of an earlier try with this id is made again from scratch.
    await release(repo, target);
    await must(repo, ['worktree', 'add', '--detach', target, mergeCommit], 'worktree add');
    try {
      const realTarget = await realpath(target);
      const source = await dependencySource(
        repo,
        realTarget,
        input.depsFrom,
        input.allowDependencyInstall === true,
      );
      if (source.path !== null) {
        try {
          await copyDependencyTrees({
            source: source.path,
            target: realTarget,
            platform,
            timeoutMs: options.copyTimeoutMs,
          });
        } catch (err) {
          throw new MergeError(
            'git_failed',
            err instanceof Error ? err.message : 'copying the dependencies failed',
          );
        }
      }
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
      return {
        path: await realpath(target),
        gitDir: await realpath(commonDir),
        ...(source.installRequired ? { dependencyInstallRequired: true } : {}),
      };
    } catch (error) {
      await release(repo, target).catch(() => {});
      throw error;
    }
  };

  const releaseCheck = async (ref: MergeRepoRef, input: { mergeId: string }): Promise<void> => {
    const repo = args.repo(ref);
    if (!isMergeId(input.mergeId)) invalidInput('Not a merge id');
    await release(repo, await checkPath(input.mergeId));
  };

  return { checkoutForCheck, releaseCheck };
}
