import type { PublishRefusal } from '@projectman/shared';
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

/**
 * What the publishing gate asks the publisher to do (PM-142): put one commit on one branch of one
 * repository and make sure a pull request exists for it. Every field comes from the server's own
 * records (the authenticated session, the task, the workspace binding); the publisher checks the
 * branch and commit again (`checkPublishTarget` in the shared package) and never trusts more.
 */
export interface PublishRequest {
  /** "owner/name" of the GitHub repository. */
  repo: string;
  /** The task branch to create or fast-forward. */
  branch: string;
  /** The repository's default branch: the pull request's base, never written. */
  baseBranch: string;
  /** The full commit id the branch tip must be. */
  commit: string;
  /** A repository that holds the branch (the member's workspace clone); read, never written. */
  sourcePath: string;
  title: string;
  body: string;
  /** The task key, for the log only. */
  taskKey: string;
}

export interface PublishResult {
  repo: string;
  branch: string;
  commit: string;
  /** The remote branch already had this commit, so nothing was uploaded. */
  alreadyPublished: boolean;
  pullRequest: PullRequestInfo;
  /** False when an open pull request for the branch already existed and was reused. */
  pullRequestCreated: boolean;
}

/** Where the remote stands for a task branch (what the integrator and the reviewer read). */
export interface RemoteState {
  repo: string;
  baseBranch: string;
  /** The remote default branch's head; null when the branch does not exist there. */
  baseCommit: string | null;
  branch: string;
  /** The remote task branch's head; null when it was never published. */
  branchCommit: string | null;
  /** Commits of the task branch the default branch lacks, and the other way round; null when unknown. */
  ahead: number | null;
  behind: number | null;
  pullRequests: PullRequestInfo[];
}

/**
 * Publishing through a separate GitHub identity with narrow rights (PM-142). The identity's token
 * lives only in the server's process: no worker sees it, so neither a raw `git` or `gh` nor any
 * other HTTP client in a session holds more than this gate does. The identity cannot write the
 * default branch, force push, delete or merge either; the repository's protection says so too
 * (docs/GITHUB.md). Owned by src/github.
 */
export interface GithubPublisher {
  /** Pushes the commit to the task branch (not forced) and opens its pull request once. */
  publish(request: PublishRequest): Promise<PublishResult>;
  /** Remote base and task-branch heads, their distance and the branch's pull requests. */
  remoteState(repo: string, baseBranch: string, branch: string): Promise<RemoteState>;
}

/** A publication the publisher refuses or could not finish; the message never holds a credential. */
export class PublishError extends Error {
  readonly code: PublishRefusal;
  constructor(code: PublishRefusal, message: string) {
    super(message);
    this.code = code;
    this.name = 'PublishError';
  }
}

export interface GithubModuleOptions {
  /** Path or name of the GitHub CLI (default "gh"). Tests pass a fake. */
  ghBin: string;
  /** Host whose `gh` login `isAvailable` checks (default "github.com"). */
  ghHost?: string;
  pollIntervalMs: number;
  logger: FastifyBaseLogger;
}
