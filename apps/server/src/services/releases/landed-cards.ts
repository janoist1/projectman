import type { TaskKey } from '@projectman/shared';
import type { BranchMerger, MergeRepoRef } from '../../contracts';
import type { MergeRecord } from '../../db';
import { conflict } from '../../kernel';

/** The commit a card's merge left on the default branch. */
export interface LandedMerge {
  taskKey: TaskKey;
  commit: string;
}

/** The commit a merge left on the default branch: the merge commit, or the commit that was found merged. */
function landedCommit(row: MergeRecord): string | null {
  return (row.startedBy ? row.mergeCommit : row.commit) ?? null;
}

/** The recorded merges of a repository that left a commit, oldest first. */
export function landedMerges(rows: readonly MergeRecord[]): LandedMerge[] {
  return rows.flatMap((row) => {
    const commit = landedCommit(row);
    return commit ? [{ taskKey: row.taskKey, commit }] : [];
  });
}

/**
 * The commit a release is made of: `commit` when it is one a merge of a card recorded, else (none given) the
 * head of the default branch, which has to be one too. `defaultBranch` is asked only when it is needed.
 */
export async function resolveLandedCommit(input: {
  merger: BranchMerger;
  ref: MergeRepoRef;
  landed: readonly LandedMerge[];
  commit?: string | undefined;
  defaultBranch: () => Promise<string>;
}): Promise<string> {
  const { landed } = input;
  let chosen = input.commit;
  if (!chosen) {
    const newest = landed.at(-1);
    if (!newest) throw conflict('release_empty', 'no merged card has landed in the repository yet');
    chosen = (
      await input.merger.prepare(input.ref, { base: await input.defaultBranch(), commit: newest.commit })
    ).local;
  }
  if (!landed.some((entry) => entry.commit === chosen))
    throw conflict('release_commit_unknown', `${chosen} is not the result of a recorded merge of a card`, {
      commit: chosen,
    });
  return chosen;
}

/**
 * The merges after `baseCommit` (null: from the first) up to `commit` (default: the last), by the recorded order
 * of the default branch, which is linear as merges run one after the other per repository. It needs no git
 * when the base is one of the recorded merges; null: it is not, and only git can tell where it stands.
 */
function landedBetween<T extends { commit: string }>(
  landed: readonly T[],
  baseCommit: string | null,
  commit?: string,
): T[] | null {
  const end = commit === undefined ? landed.length : landed.findLastIndex((e) => e.commit === commit) + 1;
  if (baseCommit === null) return landed.slice(0, end);
  const at = landed.findLastIndex((entry) => entry.commit === baseCommit);
  return at < 0 ? null : landed.slice(at + 1, end);
}

/**
 * The cards merged into `commit` and not into `baseCommit` (null: no base), in the order of their merges.
 * `release_empty` when there are none. Git is asked only when the base is no recorded merge, and then from
 * the newest merge backwards, up to the first one the base already holds.
 */
export async function landedCards(input: {
  merger: BranchMerger;
  ref: MergeRepoRef;
  landed: readonly LandedMerge[];
  commit: string;
  baseCommit: string | null;
}): Promise<TaskKey[]> {
  const { merger, ref, commit, baseCommit } = input;
  let between = landedBetween(input.landed, baseCommit, commit);
  if (!between) {
    const upTo = input.landed.slice(0, input.landed.findLastIndex((e) => e.commit === commit) + 1);
    let from = upTo.length;
    while (
      from > 0 &&
      !(await merger.isAncestor(ref, { ancestor: upTo[from - 1]!.commit, commit: baseCommit! }))
    )
      from--;
    between = upTo.slice(from);
  }
  const keys = [...new Set(between.map((entry) => entry.taskKey))];
  if (keys.length === 0) throw conflict('release_empty', 'there is nothing new to release');
  return keys;
}
