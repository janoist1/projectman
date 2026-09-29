import { TaskKey, type TaskLink } from '@projectman/shared';
import type { PullRequestInfo } from '../contracts';

/** "owner/name": the same rule as `RepoConfig.github` in the project configuration. */
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export function isValidRepo(repo: string): boolean {
  if (!REPO_PATTERN.test(repo)) return false;
  return repo.split('/').every((part) => part !== '.' && part !== '..');
}

export function isValidPullRequestNumber(number: number): boolean {
  return Number.isSafeInteger(number) && number > 0;
}

/** A light sanity check; git's own rules are stricter. Branches never start with "-". */
export function isValidBranch(branch: string): boolean {
  return (
    branch.length > 0 && branch.length <= 255 && !branch.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(branch)
  );
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

/** Task-key-like prefixes that come from the old ClickUp workflow ("CU-<clickup id>-name"). */
const LEGACY_PREFIXES = new Set(['CU']);
const KEY_AT_SEGMENT_START = /^([A-Z][A-Z0-9]{0,9})-(\d+)(?=$|[-_.])/;

/**
 * The task a branch belongs to: "AR-21-short-name" → "AR-21". The key may also follow a
 * prefix such as "feature/AR-21-x". Legacy ClickUp branches ("CU-869f4byk9-name") give null.
 *
 * Pass `projectKey` whenever it is known: then only keys of that project are accepted, which
 * also rules out look-alikes such as "UTF-8-fix".
 */
export function taskKeyFromBranch(branch: string, projectKey?: string): string | null {
  for (const segment of branch.trim().split('/')) {
    const [, prefix, digits] = KEY_AT_SEGMENT_START.exec(segment) ?? [];
    if (!prefix || !digits) continue;
    if (projectKey ? prefix !== projectKey : LEGACY_PREFIXES.has(prefix)) continue;
    const number = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    const key = `${prefix}-${number}`;
    if (TaskKey.safeParse(key).success) return key;
  }
  return null;
}

/** The task link for a pull request: `ref` is the PR number, `state` its last known state. */
export function pullRequestLink(pr: Pick<PullRequestInfo, 'repo' | 'number' | 'title' | 'state'>): TaskLink {
  return { kind: 'pull_request', ref: String(pr.number), repo: pr.repo, title: pr.title, state: pr.state };
}
