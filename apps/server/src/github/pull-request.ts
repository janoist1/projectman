import { z } from 'zod';
import type { PullRequestInfo } from '../contracts';
import { GithubError } from './errors';

/** Fields requested from `gh pr view --json` and `gh pr list --json`. */
export const PULL_REQUEST_JSON_FIELDS = [
  'author',
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'headRefName',
  'headRefOid',
  'baseRefName',
  'statusCheckRollup',
  'reviewDecision',
  'additions',
  'deletions',
  'changedFiles',
  'updatedAt',
  'mergedAt',
] as const;

/**
 * One entry of `statusCheckRollup` (the checks of the PR's head commit). gh exports two shapes:
 * - `CheckRun` (GitHub Actions and other check apps): name, workflowName, status, conclusion,
 *   startedAt, completedAt, detailsUrl;
 * - `StatusContext` (classic commit statuses): context, state, targetUrl, startedAt.
 * Everything is optional so that a partial or future shape degrades to "pending" instead of
 * breaking the whole lookup.
 */
export const GhCheckContext = z.object({
  __typename: z.string().nullish(),
  name: z.string().nullish(),
  workflowName: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  context: z.string().nullish(),
  state: z.string().nullish(),
  startedAt: z.string().nullish(),
});
export type GhCheckContext = z.infer<typeof GhCheckContext>;

export const GhPullRequest = z.object({
  author: z.object({ login: z.string() }).nullish(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  headRefName: z.string(),
  headRefOid: z.string().nullish(),
  baseRefName: z.string(),
  statusCheckRollup: z.array(GhCheckContext).nullish(),
  /** "" when the base branch does not require reviews. */
  reviewDecision: z.string().nullish(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  updatedAt: z.string(),
  mergedAt: z.string().nullish(),
});
export type GhPullRequest = z.infer<typeof GhPullRequest>;

/** `repo` is echoed back as given, so callers can match results against their own links. */
export function toPullRequestInfo(repo: string, pr: GhPullRequest): PullRequestInfo {
  return {
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state === 'MERGED' || pr.mergedAt ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed',
    draft: pr.isDraft,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    checks: summarizeChecks(pr.statusCheckRollup ?? []),
    reviewDecision: mapReviewDecision(pr.reviewDecision),
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    updatedAt: pr.updatedAt,
    authorLogin: pr.author?.login,
    headSha: pr.headRefOid ?? undefined,
  };
}

export function parsePullRequestJson(repo: string, stdout: string): PullRequestInfo {
  return toPullRequestInfo(repo, parseJson(GhPullRequest, stdout, 'gh pr view'));
}

export function parsePullRequestListJson(repo: string, stdout: string): PullRequestInfo[] {
  return parseJson(z.array(GhPullRequest), stdout, 'gh pr list').map((pr) => toPullRequestInfo(repo, pr));
}

function parseJson<S extends z.ZodType>(schema: S, stdout: string, command: string): z.output<S> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (err) {
    throw new GithubError('invalid_response', `${command} did not print JSON`, { cause: err });
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new GithubError('invalid_response', `${command} printed unexpected JSON: ${issues}`, {
      cause: result.error,
    });
  }
  return result.data;
}

export function mapReviewDecision(value: string | null | undefined): PullRequestInfo['reviewDecision'] {
  switch (value?.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
    default:
      // "" / null: the base branch does not require reviews; unknown values are ignored.
      return null;
  }
}

type CheckOutcome = 'pass' | 'fail' | 'pending';

/** Neutral and skipped runs do not block a merge, so they count as passing (as on GitHub). */
const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILING = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

/**
 * Rolls the PR's checks up into one value: any failing check → "failure"; otherwise any
 * unfinished one → "pending"; otherwise "success"; no checks at all → "none". When a check ran
 * more than once (re-runs), only its latest run counts.
 */
export function summarizeChecks(contexts: readonly GhCheckContext[]): PullRequestInfo['checks'] {
  const latest = latestRuns(contexts);
  if (latest.length === 0) return 'none';
  const outcomes = latest.map(checkOutcome);
  if (outcomes.includes('fail')) return 'failure';
  if (outcomes.includes('pending')) return 'pending';
  return 'success';
}

export function checkOutcome(ctx: GhCheckContext): CheckOutcome {
  const state = (isStatusContext(ctx) ? ctx.state : checkRunState(ctx))?.toUpperCase() ?? '';
  if (PASSING.has(state)) return 'pass';
  if (FAILING.has(state)) return 'fail';
  // QUEUED, IN_PROGRESS, WAITING, PENDING, REQUESTED, EXPECTED, STALE and anything unknown.
  return 'pending';
}

function isStatusContext(ctx: GhCheckContext): boolean {
  if (ctx.__typename) return ctx.__typename === 'StatusContext';
  return ctx.status == null && ctx.conclusion == null && ctx.state != null;
}

/** A check run has a conclusion only once its status is COMPLETED. */
function checkRunState(ctx: GhCheckContext): string | null | undefined {
  const status = ctx.status?.toUpperCase();
  if (status && status !== 'COMPLETED') return status;
  return ctx.conclusion || status;
}

function latestRuns(contexts: readonly GhCheckContext[]): GhCheckContext[] {
  const byCheck = new Map<string, GhCheckContext>();
  for (const ctx of contexts) {
    const key = isStatusContext(ctx)
      ? `status:${ctx.context ?? ''}`
      : `check:${ctx.workflowName ?? ''}:${ctx.name ?? ''}`;
    const previous = byCheck.get(key);
    if (!previous || startedAtMs(ctx) >= startedAtMs(previous)) byCheck.set(key, ctx);
  }
  return [...byCheck.values()];
}

/** A run that has not started yet (missing date or Go's zero time) is a queued re-run: the newest. */
function startedAtMs(ctx: GhCheckContext): number {
  const time = ctx.startedAt ? Date.parse(ctx.startedAt) : Number.NaN;
  return Number.isFinite(time) && time > 0 ? time : Number.POSITIVE_INFINITY;
}

/**
 * What counts as a change while watching: every field except `updatedAt`, which moves on each
 * comment and would turn every poll into a notification. Pushes, reviews, check results and
 * merges all change other fields.
 */
export function pullRequestFingerprint(pr: PullRequestInfo): string {
  const { updatedAt: _updatedAt, ...rest } = pr;
  return JSON.stringify(rest, Object.keys(rest).sort());
}
