/** "owner/name": the same rule as `RepoConfig.github` in the project configuration. */
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export function isValidRepo(repo: string): boolean {
  if (!REPO_PATTERN.test(repo)) return false;
  return repo.split('/').every((part) => part !== '.' && part !== '..');
}

export function isValidPullRequestNumber(number: number): boolean {
  return Number.isSafeInteger(number) && number > 0;
}

const PULL_REQUEST_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/**
 * Parses https://github.com/<owner>/<name>/pull/<n>, also with a trailing path (/files,
 * /checks …), query or fragment, and without the scheme. Other hosts are not supported.
 */
export function parsePullRequestUrl(url: string): { repo: string; number: number } | null {
  const match = PULL_REQUEST_URL.exec(url.trim());
  const [, owner, name, digits] = match ?? [];
  if (!owner || !name || !digits) return null;
  const repo = `${owner}/${name}`;
  const number = Number(digits);
  if (!isValidRepo(repo) || !isValidPullRequestNumber(number)) return null;
  return { repo, number };
}
