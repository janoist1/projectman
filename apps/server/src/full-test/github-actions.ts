import type { FastifyBaseLogger } from 'fastify';
import { isRepoFilePath, MERGE_CHECK_WORKFLOW } from '@projectman/shared';
import {
  GithubError,
  type CheckBranchGit,
  type FullTestExecutor,
  type FullTestResult,
  type FullTestSpec,
  type GithubActionsCheck,
  type GithubActionsClient,
  type GithubErrorCode,
  type WorkflowJobInfo,
  type WorkflowRunInfo,
} from '../contracts';
import {
  failedResult,
  fullScopeProblem,
  judge,
  passedResult,
  stripGithubTimestamps,
  withHeader,
  type FinishedRun,
} from './github-verdict';

/**
 * The GitHub Actions merge check (PM-900), run by the engine: the merge commit goes to a check branch
 * of the upstream remote, the repository's `merge-check.yml` workflow is dispatched on it and followed,
 * and the jobs' logs give the same `FullTestResult` the local run would have. The branch is deleted at
 * every end. Nothing here touches the step cache or the heavy-run queue: the machine does not run the
 * tests.
 */

const CHECK_BRANCH_PREFIX = 'pm-check/';
/** How often, and for how long, the dispatched run is looked for. */
const RUN_APPEAR_POLL_MS = 5_000;
export const RUN_APPEAR_MAX_MS = 120_000;
/** How often a running workflow is looked at. */
const RUN_POLL_MS = 10_000;
/** GitHub may finish the run before its shard jobs expose their terminal states. */
export const JOB_WAIT_MAX_MS = 120_000;
/** How long the logs of a finished run are waited for (GitHub has them a little later). */
const LOG_WAIT_MAX_MS = 30_000;
export const LOG_POLL_MS = 5_000;
/** The most time a cancelling takes (best effort). */
export const CANCEL_WAIT_MS = 15_000;
/** A check branch older than this belongs to a run that is gone; each run removes a few of them. */
export const STALE_BRANCH_MS = 7_200_000;
export const STALE_BRANCHES_PER_SWEEP = 10;
export const DISPATCH_RETRIES = 3;
const DISPATCH_RETRY_MS = 5_000;

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const COMMIT = /^[0-9a-f]{40}$/i;
const FILES_MAX = 20;
const CHECK_BRANCH_TIME = /^pm-check\/([0-9a-z]{1,12})\/[A-Za-z0-9_-]{1,64}$/;
/** Failures that may pass by themselves. */
const TRANSIENT: ReadonlySet<GithubErrorCode> = new Set([
  'rate_limited',
  'unreachable',
  'server_error',
  'timeout',
]);
/** Failures that will not: GitHub cannot be used for this check. */
const FATAL: ReadonlySet<GithubErrorCode> = new Set(['not_found', 'not_authenticated', 'not_installed']);

export interface GithubActionsDeps {
  actions: GithubActionsClient;
  branches: CheckBranchGit;
  logger: FastifyBaseLogger;
  now?: () => number;
  /** Resolves after `ms`, or at once when the signal aborts. Tests advance their clock here. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

export const codeOf = (err: unknown): GithubErrorCode => (err instanceof GithubError ? err.code : 'failed');
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Why a request cannot be a check, or null. */
function problemOf(spec: FullTestSpec, check: GithubActionsCheck): string | null {
  if (!RUN_ID.test(spec.runId)) return 'The run id is not usable as a check branch name.';
  if (!REPO.test(check.repo)) return 'The GitHub repository is not owner/name.';
  if (!COMMIT.test(check.commit)) return 'The commit is not a 40 digit commit id.';
  if (check.workflow !== MERGE_CHECK_WORKFLOW) return `The workflow is not ${MERGE_CHECK_WORKFLOW}.`;
  if (
    check.files &&
    (check.files.length < 1 || check.files.length > FILES_MAX || !check.files.every(isRepoFilePath))
  )
    return `The files are not 1 to ${FILES_MAX} repository paths.`;
  if (check.all && check.files && check.files.length > 0)
    return 'A full check of the whole tree cannot take a list of files.';
  return null;
}

type FollowFailureReason = 'github_unavailable' | 'github_run_error' | 'timeout' | 'killed';

/** A read of the finished run that did not give an answer; thrown by `finish` it ends the follow too. */
class ReadFailure extends Error {
  readonly reason: FollowFailureReason;
  constructor(reason: FollowFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface FollowDeps {
  actions: GithubActionsClient;
  logger: FastifyBaseLogger;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface FollowRequest {
  repo: string;
  workflow: string;
  /** The branch the workflow is dispatched on. */
  dispatchRef: string;
  inputs: Record<string, string>;
  /** Looks up the dispatched run; null: it does not exist (yet). */
  find: (signal: AbortSignal) => Promise<WorkflowRunInfo | null>;
  /** The time limit from the call; at its end the run is cancelled. */
  timeoutMs: number;
  /** The text of a run that was stopped by the caller's signal. */
  stoppedMessage: string;
  /** Called once the run is in progress or has ended. */
  onStarted?: () => void;
  /** Whether to wait for the jobs of a completed run to settle; default: always. */
  settleJobs?: (run: WorkflowRunInfo) => boolean;
}

/** A completed run with its jobs, as the caller's `finish` gets it. */
export interface FollowedRun {
  run: WorkflowRunInfo;
  jobs: readonly WorkflowJobInfo[];
  startedAt: number;
  runningSince: number | null;
  /** Reads the plain logs of `jobs` (timestamps removed); a failed read ends the follow as a `ReadFailure`. */
  logs: (jobs: readonly WorkflowJobInfo[]) => Promise<{ job: WorkflowJobInfo; log: string }[]>;
  /** Another read of the finished run, tried again for as long as the logs are: for what GitHub shows late. */
  read: <R>(what: string, call: () => Promise<R>) => Promise<R>;
}

interface FollowFailure {
  reason: FollowFailureReason;
  message: string;
  /** The last run seen, if the run appeared. */
  run: WorkflowRunInfo | null;
  startedAt: number;
  runningSince: number | null;
}

export type Followed<T> = { ok: true; value: T } | { ok: false; failure: FollowFailure };

/**
 * The part of a GitHub Actions run both the merge check (PM-900) and the compute jobs (PM-1147) share:
 * dispatches the workflow (temporary failures tried again), waits for the run to appear, follows it to its
 * end (cancelling at the signal or the time limit), then reads its jobs once they settle. `finish` turns the
 * completed run into the caller's value and may read the logs; it throws a `ReadFailure` to end it as an error.
 */
export async function followWorkflowRun<T>(
  deps: FollowDeps,
  req: FollowRequest,
  signal: AbortSignal,
  finish: (followed: FollowedRun) => Promise<T>,
): Promise<Followed<T>> {
  const { actions, logger, now, sleep } = deps;
  const startedAt = now();
  const deadline = startedAt + req.timeoutMs;
  let run: WorkflowRunInfo | null = null;
  let runningSince: number | null = null;
  let started = false;
  const markStarted = () => {
    if (started) return;
    started = true;
    req.onStarted?.();
  };
  const stop = (reason: FollowFailureReason, message: string): Followed<T> => ({
    ok: false,
    failure: { reason, message, run, startedAt, runningSince },
  });
  const killed = () => stop('killed', req.stoppedMessage);
  if (signal.aborted) return killed();

  // Asks GitHub to cancel, for at most CANCEL_WAIT_MS; it never fails the result.
  const cancel = async (id: number): Promise<void> => {
    const own = new AbortController();
    const timer = setTimeout(() => own.abort(), CANCEL_WAIT_MS);
    try {
      await actions.cancelRun(req.repo, id, own.signal);
    } catch (err) {
      logger.warn({ err, workflow: req.workflow }, 'github actions: could not cancel the run');
    } finally {
      clearTimeout(timer);
    }
  };

  // Dispatch: temporary failures are tried again a few times.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await actions.dispatchWorkflow(
        req.repo,
        req.workflow,
        { ref: req.dispatchRef, inputs: req.inputs },
        signal,
      );
      break;
    } catch (err) {
      if (signal.aborted) return killed();
      const code = codeOf(err);
      if (!TRANSIENT.has(code) || attempt >= DISPATCH_RETRIES)
        return stop('github_unavailable', `The workflow could not be started (${code}): ${messageOf(err)}`);
      await sleep(DISPATCH_RETRY_MS, signal);
      if (signal.aborted) return killed();
    }
  }

  // The dispatched run takes a moment to show up.
  const lookStarted = now();
  for (;;) {
    try {
      run = await req.find(signal);
    } catch (err) {
      if (signal.aborted) return killed();
      const code = codeOf(err);
      if (!TRANSIENT.has(code))
        return stop(
          'github_unavailable',
          `The dispatched run could not be looked up (${code}): ${messageOf(err)}`,
        );
    }
    if (run) break;
    if (signal.aborted) return killed();
    if (now() - lookStarted >= RUN_APPEAR_MAX_MS || now() >= deadline)
      return stop('github_unavailable', 'The dispatched run did not appear.');
    await sleep(RUN_APPEAR_POLL_MS, signal);
  }

  // Follow it to its end.
  let reads = 0;
  let failedReads = 0;
  for (;;) {
    if (run.status === 'in_progress' && runningSince === null) {
      runningSince = now();
      markStarted();
    }
    if (run.status === 'completed') break;
    if (signal.aborted) {
      await cancel(run.id);
      return killed();
    }
    if (now() >= deadline) {
      await cancel(run.id);
      // GitHub never answered after the run was found: the state of the run is not known.
      return reads === 0 && failedReads > 0
        ? stop('github_unavailable', 'GitHub could not be reached until the time limit.')
        : stop(
            'timeout',
            `The run did not finish within ${Math.round(req.timeoutMs / 1000)} s and was cancelled.`,
          );
    }
    await sleep(RUN_POLL_MS, signal);
    if (signal.aborted) continue;
    try {
      run = await actions.getRun(req.repo, run.id, signal);
      reads += 1;
    } catch (err) {
      if (signal.aborted) continue;
      const code = codeOf(err);
      if (FATAL.has(code)) {
        await cancel(run.id);
        return stop('github_unavailable', `The run could not be followed (${code}): ${messageOf(err)}`);
      }
      failedReads += 1;
      logger.warn({ err, workflow: req.workflow }, 'github actions: could not read the run; trying again');
    }
  }
  markStarted();
  const finishedRun = run;

  // The jobs, and on request their logs.
  let logStarted = now();
  const read = async <R>(what: string, call: () => Promise<R>): Promise<R> => {
    for (;;) {
      try {
        return await call();
      } catch (err) {
        if (signal.aborted) throw new ReadFailure('killed', req.stoppedMessage);
        const code = codeOf(err);
        const retry = code === 'not_found' || TRANSIENT.has(code);
        if (!retry || now() - logStarted + LOG_POLL_MS > LOG_WAIT_MAX_MS)
          throw new ReadFailure(
            code === 'not_found' ? 'github_run_error' : 'github_unavailable',
            `${what} could not be read (${code}): ${messageOf(err)}`,
          );
        await sleep(LOG_POLL_MS, signal);
      }
    }
  };
  try {
    let jobs = await read('The jobs', () => actions.listJobs(req.repo, finishedRun.id, signal));
    const jobsDeadline = Math.min(deadline, now() + JOB_WAIT_MAX_MS);
    // A completed run can temporarily expose queued/running shards, or no jobs at all.
    // Wait for the job view to settle before treating a missing verdict as an error.
    while (
      (req.settleJobs?.(finishedRun) ?? true) &&
      (jobs.length === 0 || jobs.some((job) => job.status !== 'completed' || job.conclusion === null)) &&
      now() < jobsDeadline
    ) {
      if (signal.aborted) return killed();
      await sleep(Math.min(LOG_POLL_MS, jobsDeadline - now()), signal);
      if (signal.aborted) return killed();
      jobs = await read('The jobs', () => actions.listJobs(req.repo, finishedRun.id, signal));
    }
    if (signal.aborted) return killed();
    const value = await finish({
      run: finishedRun,
      jobs,
      startedAt,
      runningSince,
      read: (what, call) => {
        logStarted = now();
        return read(what, call);
      },
      logs: async (list) => {
        logStarted = now();
        const withLogs: { job: WorkflowJobInfo; log: string }[] = [];
        for (const job of list) {
          const log = await read(`The log of "${job.name}"`, () => actions.jobLog(req.repo, job.id, signal));
          withLogs.push({ job, log: stripGithubTimestamps(log) });
        }
        return withLogs;
      },
    });
    return { ok: true, value };
  } catch (err) {
    if (err instanceof ReadFailure) return stop(err.reason, err.message);
    throw err;
  }
}

/**
 * `local` runs everything but the `githubActions` check; that goes the GitHub way. `available()` is the
 * local executor's: the GitHub way needs no sandbox.
 */
export function withGithubActions(local: FullTestExecutor, deps: GithubActionsDeps): FullTestExecutor {
  const { actions, branches, logger } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  /** The check branches of the runs in progress here: a sweep never removes them. */
  const active = new Set<string>();

  const isStale = (name: string): boolean => {
    const stamp = CHECK_BRANCH_TIME.exec(name)?.[1];
    if (!stamp) return false;
    const pushedAt = Number.parseInt(stamp, 36);
    return Number.isFinite(pushedAt) && now() - pushedAt > STALE_BRANCH_MS && !active.has(name);
  };

  /** Removes a few check branches nobody follows any more; its failures are only logged. */
  async function sweep(check: GithubActionsCheck): Promise<void> {
    try {
      const names = await branches.list(check.ref, { base: check.base, prefix: CHECK_BRANCH_PREFIX });
      for (const branch of names.filter(isStale).slice(0, STALE_BRANCHES_PER_SWEEP)) {
        try {
          await branches.remove(check.ref, { base: check.base, branch });
        } catch (err) {
          logger.warn({ err, branch }, 'github actions: could not remove a stale check branch');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'github actions: could not list the check branches');
    }
  }

  async function runCheck(
    spec: FullTestSpec,
    check: GithubActionsCheck,
    signal: AbortSignal,
    onStarted: (() => void) | undefined,
  ): Promise<FullTestResult> {
    const began = now();
    let run: WorkflowRunInfo | null = null;
    let pushedAt: number | null = null;
    let runningSince: number | null = null;

    const error = (
      reason: 'github_unavailable' | 'github_run_error' | 'timeout' | 'killed',
      message: string,
    ) =>
      ({
        outcome: 'error',
        reason,
        exitCode: null,
        durationMs: Math.max(0, now() - (runningSince ?? pushedAt ?? began)),
        failedFiles: [],
        outputTail: withHeader(run, message),
        ...(run ? { externalUrl: run.htmlUrl } : {}),
      }) satisfies FullTestResult;
    const killed = () => error('killed', 'The merge check was stopped.');

    const problem = problemOf(spec, check);
    if (problem) return error('github_run_error', problem);
    if (signal.aborted) return killed();

    let upstream: string | null;
    try {
      upstream = await branches.upstreamRepo(check.ref, { base: check.base });
    } catch (err) {
      return error('github_unavailable', `The upstream remote could not be read: ${messageOf(err)}`);
    }
    if (upstream === null || upstream.toLowerCase() !== check.repo.toLowerCase())
      return error(
        'github_unavailable',
        `The upstream remote of ${check.base} is ${upstream ?? 'not a github.com repository'}, not ${check.repo}.`,
      );

    await sweep(check);
    if (signal.aborted) return killed();

    const branch = `${CHECK_BRANCH_PREFIX}${now().toString(36)}/${spec.runId}`;
    active.add(branch);
    try {
      let pushed;
      try {
        pushed = await branches.push(check.ref, { base: check.base, commit: check.commit, branch });
      } catch (err) {
        return error('github_unavailable', `The check branch could not be pushed: ${messageOf(err)}`);
      }
      if (!pushed.ok)
        return error(
          'github_unavailable',
          `The check branch could not be pushed (${pushed.reason}): ${pushed.message}`,
        );
      pushedAt = now();
      if (signal.aborted) return killed();

      const inputs: Record<string, string> = {
        check_id: spec.runId,
        files: check.files ? JSON.stringify(check.files) : '',
        // Left out of merge calls, so that a workflow without the input still accepts them.
        ...(check.all ? { all: 'true' } : {}),
      };
      const followed = await followWorkflowRun(
        { actions, logger, now, sleep },
        {
          repo: check.repo,
          workflow: check.workflow,
          dispatchRef: branch,
          inputs,
          find: (own) =>
            actions.findDispatchedRun(check.repo, check.workflow, { branch, headSha: check.commit }, own),
          timeoutMs: spec.timeoutMs,
          stoppedMessage: 'The merge check was stopped.',
          ...(onStarted ? { onStarted } : {}),
          // A run of another commit is judged an error at once, so there is nothing to wait for.
          settleJobs: (finishedRun) => finishedRun.headSha.toLowerCase() === check.commit.toLowerCase(),
        },
        signal,
        async (done): Promise<FullTestResult> => {
          run = done.run;
          runningSince = done.runningSince;
          const judgement = judge(done.run, check.commit, done.jobs);
          if (judgement.kind === 'error') return error('github_run_error', judgement.message);
          if (judgement.kind === 'timeout') return error('timeout', 'A job of the run timed out on GitHub.');
          const finished: FinishedRun = {
            run: done.run,
            jobs: await done.logs(done.jobs),
            durationMs: Math.max(0, now() - (done.runningSince ?? done.startedAt)),
          };
          if (judgement.kind === 'passed') {
            const unproven = check.all ? fullScopeProblem(finished) : null;
            return unproven ? error('github_run_error', unproven) : passedResult(finished);
          }
          return failedResult(finished, judgement.failed);
        },
      );
      if (followed.ok) return followed.value;
      run = followed.failure.run;
      runningSince = followed.failure.runningSince;
      return error(followed.failure.reason, followed.failure.message);
    } finally {
      active.delete(branch);
      try {
        await branches.remove(check.ref, { base: check.base, branch });
      } catch (err) {
        logger.warn({ err, branch }, 'github actions: could not remove the check branch');
      }
    }
  }

  return {
    available: () => local.available(),
    run(spec, signal, onStarted, options) {
      if (!spec.githubActions) return local.run(spec, signal, onStarted, options);
      return runCheck(spec, spec.githubActions, signal, onStarted);
    },
  };
}
