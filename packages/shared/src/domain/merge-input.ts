/** A commit id, SHA-1 or SHA-256; validation never normalizes stored snapshots. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** Current and historical card merge ids, followed by 8–40 lowercase letters or digits. */
const MERGE_ID = /^(?:merge|mrg)_[a-z0-9]{8,40}$/;
/** Whitespace, control characters and characters forbidden in git refs. */
const PLAIN_BRANCH = /^[^\s\0-\x1f\x7f~^:?*[\\]+$/;

/** A release tag name: one path part of letters, digits, dot, underscore and dash (`publish_release`, PM-968). */
const RELEASE_TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Whether `name` is acceptable as the tag of a release: no `..`, no `.lock` or trailing dot ending (git refuses them). */
export function isReleaseTagName(name: string): boolean {
  return (
    RELEASE_TAG_NAME.test(name) && !name.includes('..') && !name.endsWith('.lock') && !name.endsWith('.')
  );
}

export function isCommitId(value: string): boolean {
  return COMMIT_ID.test(value);
}

export function isMergeId(value: string): boolean {
  return MERGE_ID.test(value);
}

/** Pure branch syntax; the engine also checks with git before executing merge operations. */
export function isPlainBranchName(name: string): boolean {
  if (
    name.length === 0 ||
    name.length > 200 ||
    name === 'HEAD' ||
    name === '@' ||
    name.startsWith('-') ||
    name.includes('@{') ||
    name.includes('..') ||
    name.endsWith('.') ||
    !PLAIN_BRANCH.test(name)
  )
    return false;
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}
