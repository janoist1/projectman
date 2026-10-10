import { execFile } from 'node:child_process';

/**
 * The inputs of the merge calls (PM-451), checked the same way by the local merger (which never trusts its
 * caller) and by the engine's limit (which never trusts the cloud).
 */

/** A commit id, SHA-1 or SHA-256. */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** The id of one merge of a card (`mrg_` and 8 to 40 lowercase letters or digits). */
export const MERGE_ID = /^mrg_[a-z0-9]{8,40}$/;
export const MERGE_MESSAGE_MAX = 2000;

export function isCommitId(value: string): boolean {
  return COMMIT_ID.test(value);
}

export function isMergeId(value: string): boolean {
  return MERGE_ID.test(value);
}

/** At most 2000 characters and no NUL. */
export function isMergeMessage(value: string): boolean {
  return value.length <= MERGE_MESSAGE_MAX && !value.includes('\0');
}

/** Characters git's ref rules forbid anywhere, plus anything that is not printable ASCII or a letter. */
const PLAIN_BRANCH = /^[^\s\0-\x1f\x7f~^:?*[\\]+$/;

/**
 * Whether `name` is a plain branch name: git's own rule (`check-ref-format --branch`) and then no form
 * that git would expand (`@{-1}`), no `HEAD` and no leading dash.
 */
export function isBranchName(name: string): Promise<boolean> {
  if (
    name.length === 0 ||
    name.length > 200 ||
    name === 'HEAD' ||
    name === '@' ||
    name.startsWith('-') ||
    name.includes('@{') ||
    !PLAIN_BRANCH.test(name)
  )
    return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['check-ref-format', '--branch', name],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => resolve(!error && stdout.trim() === name),
    );
  });
}
