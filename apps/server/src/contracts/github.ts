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

/**
 * GitHub through one machine's `gh` login: what the engine runs and what the engine RPC carries. It does not
 * know projects; the domain's `GithubService` adds the project, which chooses the machine (PM-1059).
 */
export interface MachineGithubService {
  /** gh is installed and authenticated. */
  isAvailable(): Promise<boolean>;
  getPullRequest(repo: string, number: number): Promise<PullRequestInfo>;
  findPullRequestsForBranch(repo: string, branch: string): Promise<PullRequestInfo[]>;
  parsePullRequestUrl(url: string): { repo: string; number: number } | null;
  /**
   * The public GitHub release of `tag`, which must be on the remote already (PM-968). A release that exists
   * is returned as is, so a repeated call is safe. The only write of this service.
   */
  publishRelease(
    repo: string,
    input: { tag: string; title: string; notes: string },
  ): Promise<{ url: string }>;
  /** Polls the given PRs and reports every change; returns an unsubscribe function. */
  watch(
    targets: Array<{ repo: string; number: number }>,
    onChange: (pr: PullRequestInfo) => void,
  ): () => void;
}

/**
 * GitHub as the domain uses it: every call names the project, whose engine runs `gh` (PM-1059). With one
 * machine the project makes no difference (`createProjectGithubService` ignores it).
 */
export interface GithubService {
  /** gh is installed and authenticated on the project's machine. */
  isAvailable(projectKey: string): Promise<boolean>;
  getPullRequest(projectKey: string, repo: string, number: number): Promise<PullRequestInfo>;
  findPullRequestsForBranch(projectKey: string, repo: string, branch: string): Promise<PullRequestInfo[]>;
  parsePullRequestUrl(url: string): { repo: string; number: number } | null;
  publishRelease(
    projectKey: string,
    repo: string,
    input: { tag: string; title: string; notes: string },
  ): Promise<{ url: string }>;
  /** Polls the given PRs and reports every change; returns an unsubscribe function. */
  watch(
    projectKey: string,
    targets: Array<{ repo: string; number: number }>,
    onChange: (pr: PullRequestInfo) => void,
  ): () => void;
}

export interface WorkflowRunInfo {
  id: number;
  /** GitHub's status as is: queued, in_progress, completed, waiting, requested, pending … */
  status: string;
  /** success, failure, cancelled, timed_out, skipped, startup_failure …; null until completed. */
  conclusion: string | null;
  headSha: string;
  headBranch: string;
  htmlUrl: string;
  createdAt: string;
}

export interface WorkflowStepInfo {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowJobInfo {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: WorkflowStepInfo[];
}

/** GitHub Actions through this machine's `gh` login (PM-900). Rejects with GithubError. */
export interface GithubActionsClient {
  dispatchWorkflow(
    repo: string,
    workflow: string,
    input: { ref: string; inputs: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<void>;
  /** The newest workflow_dispatch run of `workflow` on `branch` whose head is `headSha`; null: none yet. */
  findDispatchedRun(
    repo: string,
    workflow: string,
    input: { branch: string; headSha: string },
    signal?: AbortSignal,
  ): Promise<WorkflowRunInfo | null>;
  getRun(repo: string, runId: number, signal?: AbortSignal): Promise<WorkflowRunInfo>;
  /** The run's jobs (at most 100). */
  listJobs(repo: string, runId: number, signal?: AbortSignal): Promise<WorkflowJobInfo[]>;
  /** The job's plain log; GithubError not_found until GitHub has it. */
  jobLog(repo: string, jobId: number, signal?: AbortSignal): Promise<string>;
  /** Asks GitHub to cancel; an already completed run is fine. */
  cancelRun(repo: string, runId: number, signal?: AbortSignal): Promise<void>;
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
