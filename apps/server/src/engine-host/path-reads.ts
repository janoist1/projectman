import {
  MAX_CHANGED_ITEMS,
  MAX_CHANGED_PATHS,
  MAX_LISTED_PATHS,
  MergeError,
  type BranchMerger,
  type ChangedPathsItem,
  type ChangedPathsResult,
  type MergeRepoRef,
} from '../contracts';
import { nulPaths } from './git-output';
import { outputTail, runGit } from './merge-git';
import { invalidInput, isBranchName, type MergeArgs } from './merge-input';
import { must, requireCommit, resolveCommit } from './merge-repo';

/**
 * Reading the file names of a repository for the structure map (PM-595): the tracked files at the base
 * head, and the files each card's work changes. Read-only and without a fetch: only names leave the
 * engine, never content.
 */

export interface PathReadOptions {
  args: MergeArgs;
  /** Test only: a smaller `listPaths` cap (default MAX_LISTED_PATHS). */
  maxListedPaths?: number;
  /** Test only: a smaller per item `changedPaths` cap (default MAX_CHANGED_PATHS). */
  maxChangedPaths?: number;
}

const ITEM_ID_MAX = 40;

const cut = (paths: string[], max: number): { paths: string[]; truncated: boolean } => {
  const sorted = [...new Set(paths)].sort();
  return { paths: sorted.slice(0, max), truncated: sorted.length > max };
};

export function createPathReads(options: PathReadOptions): Pick<BranchMerger, 'listPaths' | 'changedPaths'> {
  const { args } = options;
  const maxListed = options.maxListedPaths ?? MAX_LISTED_PATHS;
  const maxChanged = options.maxChangedPaths ?? MAX_CHANGED_PATHS;

  const listPaths = async (
    ref: MergeRepoRef,
    input: { base: string },
  ): Promise<{ commit: string; paths: string[]; truncated: boolean }> => {
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    const commit = await requireCommit(repo, `refs/heads/${base}`, 'The base');
    const listed = await must(repo, ['ls-tree', '-r', '-z', '--name-only', commit], 'ls-tree');
    return { commit, ...cut(nulPaths(listed), maxListed) };
  };

  const diffPaths = async (repo: string, from: string, to: string): Promise<string[]> =>
    nulPaths(
      await must(
        repo,
        ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-commit-id', from, to],
        'diff-tree',
      ),
    );

  /** The item's commit and the commit to diff it from; null: not known here. */
  const resolveItem = async (
    repo: string,
    baseHead: string,
    at: ChangedPathsItem['at'],
  ): Promise<{ commit: string; from: string } | null> => {
    if ('merge' in at) {
      const commit = await resolveCommit(repo, args.commit(at.merge, 'The merge commit'));
      if (!commit) return null;
      const parent = await resolveCommit(repo, `${commit}^1`);
      return parent ? { commit, from: parent } : null;
    }
    let commit: string | null;
    if ('branch' in at) {
      if (!(await isBranchName(at.branch))) return invalidInput('Not a branch name');
      commit = await resolveCommit(repo, `refs/heads/${at.branch}`);
    } else commit = await resolveCommit(repo, args.commit(at.commit, 'The commit'));
    if (!commit) return null;
    const mergeBase = await runGit(repo, ['merge-base', baseHead, commit]);
    if (mergeBase.code === 1) return null;
    if (mergeBase.code !== 0)
      throw new MergeError('git_failed', `merge-base failed: ${outputTail(mergeBase.stderr, 500)}`);
    const from = mergeBase.stdout.trim();
    return from ? { commit, from } : null;
  };

  const changedPaths = async (
    ref: MergeRepoRef,
    input: { base: string; items: ChangedPathsItem[] },
  ): Promise<ChangedPathsResult[]> => {
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    if (input.items.length > MAX_CHANGED_ITEMS)
      invalidInput(`More than ${MAX_CHANGED_ITEMS} items in one call`);
    for (const item of input.items) {
      if (item.id.length < 1 || item.id.length > ITEM_ID_MAX) invalidInput('Not an item id');
      if (Object.keys(item.at).length !== 1) invalidInput('An item names one branch, commit or merge');
    }
    const baseHead = await requireCommit(repo, `refs/heads/${base}`, 'The base');
    const results: ChangedPathsResult[] = [];
    for (const item of input.items) {
      const found = await resolveItem(repo, baseHead, item.at);
      if (!found) {
        results.push({ id: item.id, ok: false, reason: 'unknown' });
        continue;
      }
      const changed = cut(await diffPaths(repo, found.from, found.commit), maxChanged);
      results.push({ id: item.id, ok: true, commit: found.commit, ...changed });
    }
    return results;
  };

  return { listPaths, changedPaths };
}
