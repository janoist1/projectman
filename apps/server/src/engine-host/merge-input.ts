import { execFile } from 'node:child_process';
import { isRepoFilePath } from '@projectman/shared';
import { MergeError, type MergeRepoRef } from '../contracts';

/**
 * The inputs of the merge calls (PM-451), checked the same way by the local merger (which never trusts its
 * caller) and by the engine's limit (which never trusts the cloud).
 */

/** A commit id, SHA-1 or SHA-256. */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/**
 * The id of one merge of a card: `merge_` (what the domain's `newId('merge')` makes, and what stored rows
 * carry) or `mrg_`, then 8 to 40 lowercase letters or digits.
 */
export const MERGE_ID = /^(?:merge|mrg)_[a-z0-9]{8,40}$/;
export const MERGE_MESSAGE_MAX = 2000;
/** The largest file `readFile` returns and `commitFiles` writes (PM-494). */
export const DOC_FILE_MAX_BYTES = 1024 * 1024;
/** How many files one `commitFiles` call sets (the decision log and the roadmap). */
export const COMMIT_FILES_MAX = 2;

export { isRepoFilePath };

/** Whether one file of `commitFiles` is acceptable: a path inside the repository, text under 1 MiB (UTF-8 bytes) without NUL. */
export function isCommitFile(file: { path: string; text: string }): boolean {
  return (
    isRepoFilePath(file.path) &&
    !file.text.includes('\0') &&
    Buffer.byteLength(file.text, 'utf8') <= DOC_FILE_MAX_BYTES
  );
}

/** Whether `files` is a valid set for `commitFiles`: 1 to 2 files, each acceptable, with different paths. */
export function isCommitFileSet(files: readonly { path: string; text: string }[]): boolean {
  return (
    files.length >= 1 &&
    files.length <= COMMIT_FILES_MAX &&
    files.every(isCommitFile) &&
    new Set(files.map((file) => file.path)).size === files.length
  );
}

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

const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const REPO_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export const invalidInput = (message: string): never => {
  throw new MergeError('invalid_input', message);
};

/** The arguments of a merge call, checked: the repository (from the engine's own binding), a commit id, a base. */
export interface MergeArgs {
  repo(ref: MergeRepoRef): string;
  commit(value: string, what: string): string;
  base(value: string): Promise<string>;
}

export function mergeArgs(repoPath: (projectKey: string, repo: string) => string | null): MergeArgs {
  return {
    repo(ref) {
      if (!PROJECT_KEY.test(ref.projectKey) || !REPO_NAME.test(ref.repo))
        invalidInput('Not a project key or repo name');
      const repo = repoPath(ref.projectKey, ref.repo);
      if (!repo) return invalidInput(`${ref.projectKey}/${ref.repo} is not bound on this engine`);
      return repo;
    },
    commit(value, what) {
      if (!isCommitId(value)) invalidInput(`${what} is not a commit id`);
      return value.toLowerCase();
    },
    async base(value) {
      if (!(await isBranchName(value))) invalidInput('The base is not a branch name');
      return value;
    },
  };
}
