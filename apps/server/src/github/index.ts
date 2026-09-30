import type { GithubModuleOptions, GithubService, PullRequestInfo } from '../contracts';
import { GithubError, toGithubError } from './errors';
import { createGhRunner } from './gh';
import { createPullRequestPoller } from './poller';
import { PULL_REQUEST_JSON_FIELDS, parsePullRequestJson, parsePullRequestListJson } from './pull-request';
import { isValidBranch, isValidPullRequestNumber, isValidRepo, parsePullRequestUrl } from './refs';

export { GithubError, type GithubErrorCode } from './errors';
export { parsePullRequestUrl, pullRequestLink, taskKeyFromBranch } from './refs';

/** Optional tuning on top of the contract options; the defaults suit production. */
export interface GithubServiceOptions extends GithubModuleOptions {
  /** gh is killed when a call takes longer than this. Default 20 s. */
  commandTimeoutMs?: number;
  /** Upper bound for polling backoff after errors. Default 10 min (never below pollIntervalMs). */
  maxBackoffMs?: number;
  /** Minimum polling pause after GitHub rate limiting. Default 60 s. */
  rateLimitBackoffMs?: number;
  /** Extra environment variables for gh (tests use it to configure the fake gh). */
  env?: Record<string, string>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BACKOFF_MS = 10 * 60_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;
/** A branch normally has one PR (a few if earlier ones were closed). */
const BRANCH_PULL_REQUEST_LIMIT = 30;

/**
 * Read-only GitHub access through the gh CLI and the owner's existing `gh auth login`.
 * Nothing on GitHub is ever changed. Errors are GithubError instances with a `code`.
 */
export function createGithubService(opts: GithubServiceOptions): GithubService {
  if (!(opts.pollIntervalMs > 0) || !Number.isFinite(opts.pollIntervalMs)) {
    throw new RangeError(`pollIntervalMs must be a positive number, got ${opts.pollIntervalMs}`);
  }
  const { logger } = opts;
  const run = createGhRunner({
    ghBin: opts.ghBin || 'gh',
    timeoutMs: opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    env: opts.env,
    logger,
  });
  const jsonFields = `--json=${PULL_REQUEST_JSON_FIELDS.join(',')}`;
  const host = opts.ghHost || opts.env?.GH_HOST || 'github.com';

  function assertRepo(repo: string): void {
    if (!isValidRepo(repo)) {
      throw new GithubError('invalid_argument', `invalid repository "${repo}", expected owner/name`);
    }
  }

  async function getPullRequest(
    repo: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<PullRequestInfo> {
    assertRepo(repo);
    if (!isValidPullRequestNumber(number)) {
      throw new GithubError('invalid_argument', `invalid pull request number: ${number}`);
    }
    const stdout = await run(['pr', 'view', String(number), `--repo=${repo}`, jsonFields], { signal });
    return parsePullRequestJson(repo, stdout);
  }

  async function findPullRequestsForBranch(repo: string, branch: string): Promise<PullRequestInfo[]> {
    assertRepo(repo);
    if (!isValidBranch(branch)) throw new GithubError('invalid_argument', `invalid branch name "${branch}"`);
    const stdout = await run([
      'pr',
      'list',
      `--repo=${repo}`,
      `--head=${branch}`,
      '--state=all',
      `--limit=${BRANCH_PULL_REQUEST_LIMIT}`,
      jsonFields,
    ]);
    return parsePullRequestListJson(repo, stdout);
  }

  async function isAvailable(): Promise<boolean> {
    try {
      // Exit code 0 only when gh is installed and its active account has a working token.
      await run(['auth', 'status', '--active', `--hostname=${host}`]);
      return true;
    } catch (err) {
      const error = toGithubError(err);
      logger.info({ code: error.code, err: error.message }, 'github: gh is not available');
      return false;
    }
  }

  const poller = createPullRequestPoller({
    intervalMs: opts.pollIntervalMs,
    maxBackoffMs: opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    rateLimitBackoffMs: opts.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS,
    fetch: (target, signal) => getPullRequest(target.repo, target.number, signal),
    logger,
  });

  return {
    isAvailable,
    getPullRequest: (repo, number) => getPullRequest(repo, number),
    findPullRequestsForBranch,
    parsePullRequestUrl,
    watch: (targets, onChange) => poller.watch(targets, onChange),
  };
}
