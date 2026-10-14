import type { FastifyBaseLogger } from 'fastify';

/**
 * GitHub is used for what it is best at: pull requests, reviews, checks, merges.
 * Tasks themselves live in our own database. Access goes through the `gh` CLI with the
 * owner's existing login. Owned by src/github.
 */

export interface PullRequestInfo {
  /** "owner/name" */
  repo: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  headRef: string;
  baseRef: string;
  checks: 'success' | 'failure' | 'pending' | 'none';
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  /** GitHub login of the PR author, when supplied by gh. */
  authorLogin?: string;
  /** SHA of the PR's head commit, when supplied by gh; it changes when new commits land. */
  headSha?: string;
}

export interface GithubService {
  /** gh is installed and authenticated. */
  isAvailable(): Promise<boolean>;
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  findPullRequestsForBranch(repo: string, branch: string): Promise<PullRequestInfo[]>;
  parsePullRequestUrl(url: string): { repo: string; number: number } | null;
  /** Polls the given PRs and reports every change; returns an unsubscribe function. */
  watch(
    targets: Array<{ repo: string; number: number }>,
    onChange: (pr: PullRequestInfo) => void,
  ): () => void;
}

export interface GithubModuleOptions {
  /** Path or name of the GitHub CLI (default "gh"). Tests pass a fake. */
  ghBin: string;
  /** Host whose `gh` login `isAvailable` checks (default "github.com"). */
  ghHost?: string;
  pollIntervalMs: number;
  logger: FastifyBaseLogger;
}

/** Why a GitHub call failed. Callers branch on `code`; `message` is meant for logs. */
export type GithubErrorCode =
  /** A bad repo, pull request number or branch was passed in; gh was not run. */
  | 'invalid_argument'
  /** The gh binary could not be started (not installed or not executable). */
  | 'not_installed'
  /** gh is not logged in, or its token is no longer valid. */
  | 'not_authenticated'
  /** GitHub API rate limit (primary or secondary). */
  | 'rate_limited'
  /** The repository or pull request does not exist, or the login cannot see it. */
  | 'not_found'
  /** gh did not finish in time and was killed. */
  | 'timeout'
  /** GitHub could not be reached (offline, DNS, connection refused …); usually temporary. */
  | 'unreachable'
  /** GitHub answered with a server error (5xx, failed query); usually temporary. */
  | 'server_error'
  /** gh printed something that is not the JSON we asked for. */
  | 'invalid_response'
  /** The caller cancelled the call (e.g. a watch was unsubscribed). */
  | 'aborted'
  /** Anything else. */
  | 'failed';

export class GithubError extends Error {
  readonly code: GithubErrorCode;
  /** Exit code of gh when it ran and failed; null otherwise. */
  readonly exitCode: number | null;
  /** Beginning of gh's stderr, for logs. */
  readonly stderr: string;

  constructor(
    code: GithubErrorCode,
    message: string,
    details: { exitCode?: number | null; stderr?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'GithubError';
    this.code = code;
    this.exitCode = details.exitCode ?? null;
    this.stderr = details.stderr ?? '';
  }
}
