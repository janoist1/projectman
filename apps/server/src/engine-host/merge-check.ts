import { lstat, mkdir, readFile as readFileBytes, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MergeError, type BranchMerger, type MergeRepoRef } from '../contracts';
import { copyDependencyTrees, DEPENDENCY_LOCKFILE, findDependencyReference } from '../worktree';
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
      if (source.path !== null)
        await copyDependencyTrees({
          source: source.path,
          target: realTarget,
          platform,
          timeoutMs: options.copyTimeoutMs,
        });
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
