/**
 * Publishing a task branch from the managed VM (PM-142, part of PM-135).
 *
 * The one place the rule lives: which branch of which repository a member may publish, and the
 * exact refspec that goes to the remote. The server's publishing gate applies it to values it
 * took from its own records (the authenticated session, the task, the workspace binding), and the
 * GitHub adapter applies it again as a last line before it runs git. Remote branch protection
 * (docs/GITHUB.md) is the other half: the VM identity can neither write the default branch nor
 * merge, whatever this code does.
 */

/** Why a publication is refused; the gate puts it in words the agent reads. */
export const PUBLISH_REFUSALS = [
  /** The session is not of the managed VM profile, or the installation has no publishing identity. */
  'not_available',
  /** The task has no repository, or its repository is local-only (no GitHub name). */
  'local_only',
  /** The session has no branch of this task in its workspace. */
  'no_task_branch',
  /** The branch is the repository's default branch, or another protected name. */
  'protected_branch',
  /** The branch is not a branch of this task. */
  'foreign_branch',
  /** The branch name is not a plain, safe branch name. */
  'invalid_branch',
  /** The commit is not a full 40-character commit id. */
  'invalid_commit',
  /** The branch tip is not the commit the member named. */
  'commit_mismatch',
  /** The remote has commits the member's branch lacks (a non-fast-forward push); nothing was forced. */
  'not_fast_forward',
  /** GitHub (or git) could not be reached, or refused. */
  'remote_failed',
] as const;
export type PublishRefusal = (typeof PUBLISH_REFUSALS)[number];

export interface PublishTarget {
  taskKey: string;
  /** "owner/name" of the repository's GitHub name; absent for a local-only repository. */
  github: string | undefined;
  defaultBranch: string;
  /** The task branch the session works on; null when it has none. */
  branch: string | null;
  /** The commit the member says it publishes. */
  commit: string;
}

export type PublishDecision =
  | { ok: true; branch: string; commit: string; refspec: string }
  | { ok: false; code: PublishRefusal; message: string };

const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** A full SHA-1 commit id, lower case. */
export function isFullCommitId(value: string): boolean {
  return FULL_COMMIT.test(value);
}

/**
 * A plain branch name, stricter than git: letters, digits and `._-/`, no empty, leading dot,
 * trailing dot or `.lock` segment, no `..`. Whatever starts with `-` or contains a refspec or
 * revision character (`:`, `^`, `~`, `@{`, `*`, `?`, `[`, `\`, a space) is refused.
 */
export function isPlainBranchName(branch: string): boolean {
  if (branch.length === 0 || branch.length > 200) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.startsWith('refs/')) return false;
  if (branch.includes('..') || branch.endsWith('/') || branch.endsWith('.')) return false;
  return branch.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** `AR-21` and `AR-21-short-name` are branches of task AR-21; `AR-2` is not a branch of `AR-21`. */
export function branchBelongsToTask(taskKey: string, branch: string): boolean {
  return branch === taskKey || branch.startsWith(`${taskKey}-`);
}

/** The names no member publishes to: the default branch and the usual protected ones. */
export function isProtectedBranchName(branch: string, defaultBranch: string): boolean {
  const lower = branch.toLowerCase();
  return (
    lower === defaultBranch.toLowerCase() ||
    ['main', 'master', 'trunk', 'develop', 'production', 'release', 'head'].includes(lower) ||
    lower.startsWith('release/') ||
    lower.startsWith('refs/')
  );
}

/** The refspec of a publication: one commit to one fully named branch, never forced. */
export function publishRefspec(commit: string, branch: string): string {
  return `${commit}:refs/heads/${branch}`;
}

/**
 * Whether the task's own branch at the named commit may go to the repository's GitHub name, and the
 * exact refspec if so. Pure: every input comes from the server's records, none from the caller's
 * claim except the commit, which the adapter verifies against the branch tip.
 */
export function checkPublishTarget(target: PublishTarget): PublishDecision {
  if (!target.github)
    return {
      ok: false,
      code: 'local_only',
      message:
        'The task has no GitHub repository (it has none, or its repository is local-only), so there is nothing to publish to.',
    };
  if (!target.branch)
    return {
      ok: false,
      code: 'no_task_branch',
      message: `Your workspace has no branch of ${target.taskKey}; publish from the session that works on the task's branch.`,
    };
  if (!isPlainBranchName(target.branch))
    return { ok: false, code: 'invalid_branch', message: `"${target.branch}" is not a plain branch name.` };
  if (isProtectedBranchName(target.branch, target.defaultBranch))
    return {
      ok: false,
      code: 'protected_branch',
      message: `"${target.branch}" is the default or a protected branch; it is never published from here.`,
    };
  if (!branchBelongsToTask(target.taskKey, target.branch))
    return {
      ok: false,
      code: 'foreign_branch',
      message: `"${target.branch}" is not a branch of ${target.taskKey} (its name starts with "${target.taskKey}-").`,
    };
  if (!isFullCommitId(target.commit))
    return {
      ok: false,
      code: 'invalid_commit',
      message: 'The commit must be the full 40-character commit id (git rev-parse HEAD).',
    };
  return {
    ok: true,
    branch: target.branch,
    commit: target.commit,
    refspec: publishRefspec(target.commit, target.branch),
  };
}
