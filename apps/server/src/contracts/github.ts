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
  pollIntervalMs: number;
  logger: FastifyBaseLogger;
}
