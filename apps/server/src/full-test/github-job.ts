import {
  COMPUTE_JOB_COMMAND_MAX,
  COMPUTE_JOB_NODE_VERSION,
  COMPUTE_JOB_TIMEOUT_MINUTES_MAX,
  COMPUTE_JOB_WORKFLOW,
  GITHUB_REPO_PATTERN,
  ComputeJobCommit,
  ComputeJobId,
  ComputeJobOutputPath,
  ComputeJobRunId,
  GithubJobRunner,
  computeJobRunTitle,
} from '@projectman/shared';
import type {
  FullTestExecutor,
  FullTestResult,
  FullTestSpec,
  GithubJobRun,
  WorkflowJobInfo,
  WorkflowRunInfo,
} from '../contracts';
import {
  abortableSleep,
  codeOf,
  followWorkflowRun,
  messageOf,
  type GithubActionsDeps,
} from './github-actions';
import { GITHUB_OUTPUT_TAIL_CHARS, withHeader } from './github-verdict';
import { outputTail } from './output';

/**
 * A compute job (PM-1144, PM-1147) run by the engine as the repository's `projectman-job.yml` workflow: the
 * workflow is dispatched from the default branch, followed with the merge check's loop, and the run gives the
 * same `FullTestResult` with the declared outputs, the artifact and the cost. Nothing here pushes a branch or
 * touches the step cache or the heavy-run queue.
 */

const OUTPUTS_MAX = 10;
const SHA256 = /^[0-9a-f]{64}$/;
const OUTPUT_LINE = /^projectman-job output (\S+) (\S+) (\S+)\s*$/;

/** The artifact the workflow uploads for a run id. */
const artifactNameOf = (runId: string): string => `projectman-job-${runId}`;

/** Why a request cannot be a compute job, or null. */
function problemOf(spec: FullTestSpec, job: GithubJobRun): string | null {
  if (spec.githubActions) return 'A request is either a merge check or a compute job.';
  if (spec.npmCi || spec.regenerate || spec.requireHeavyLock)
    return 'A compute job carries no checkout, installation or lock.';
  if (!ComputeJobRunId.safeParse(spec.runId).success) return 'The run id is not a compute job run id.';
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) return 'The time limit is not positive.';
  if (!GITHUB_REPO_PATTERN.test(job.repo)) return 'The GitHub repository is not owner/name.';
  if (!ComputeJobCommit.safeParse(job.commit).success) return 'The commit is not a 40 digit commit id.';
  if (job.workflow !== COMPUTE_JOB_WORKFLOW) return `The workflow is not ${COMPUTE_JOB_WORKFLOW}.`;
  if (!ComputeJobId.safeParse(job.job).success) return 'The job is not a compute job name.';
  if (job.command.trim() === '' || job.command.length > COMPUTE_JOB_COMMAND_MAX)
    return `The command is empty or longer than ${COMPUTE_JOB_COMMAND_MAX} characters.`;
  if (!GithubJobRunner.safeParse(job.runsOn).success) return 'The runner is not one the workflow offers.';
  if (
    job.outputs.length < 1 ||
    job.outputs.length > OUTPUTS_MAX ||
    new Set(job.outputs).size !== job.outputs.length ||
    !job.outputs.every((path) => ComputeJobOutputPath.safeParse(path).success)
  )
    return `The outputs are not 1 to ${OUTPUTS_MAX} different relative paths.`;
  if (job.node !== undefined && !COMPUTE_JOB_NODE_VERSION.test(job.node))
    return 'The node version is not a major version.';
  if (
    !Number.isInteger(job.timeoutMinutes) ||
    job.timeoutMinutes < 1 ||
    job.timeoutMinutes > COMPUTE_JOB_TIMEOUT_MINUTES_MAX
  )
    return `The job time limit is not 1 to ${COMPUTE_JOB_TIMEOUT_MINUTES_MAX} minutes.`;
  return null;
}

/**
 * The declared outputs with the digests the workflow's `Outputs` step printed, in the declared order, or why
 * they cannot be had. The last line of a path wins: that step runs after the command, which could print a line
 * of its own.
 */
export function parseJobOutputs(
  log: string,
  declared: readonly string[],
): { outputs: NonNullable<FullTestResult['outputs']> } | { problem: string } {
  const printed = new Map<string, { sha256: string; bytes: number }>();
  for (const line of log.split(/\r?\n/)) {
    const match = OUTPUT_LINE.exec(line);
    if (!match) continue;
    const [, path, sha256, bytes] = match;
    if (path === undefined || sha256 === undefined || bytes === undefined) continue;
    if (!declared.includes(path)) continue;
    if (!SHA256.test(sha256) || !/^\d{1,15}$/.test(bytes))
      return { problem: `The output line of ${path} is malformed.` };
    printed.set(path, { sha256, bytes: Number(bytes) });
  }
  const outputs: NonNullable<FullTestResult['outputs']> = [];
  for (const path of declared) {
    const found = printed.get(path);
    if (!found) return { problem: `The run did not report the output ${path}.` };
    outputs.push({ path, ...found });
  }
  return { outputs };
}

/** The wait in the queue, from the run's own times; null when GitHub gave no start time. */
function queuedMsOf(run: WorkflowRunInfo): number | null {
  if (!run.runStartedAt) return null;
  const queued = Date.parse(run.runStartedAt) - Date.parse(run.createdAt);
  return Number.isFinite(queued) ? Math.max(0, queued) : null;
}

/** The log of the run's jobs for people: one job as it is, several under their names. */
function logText(logs: readonly { job: WorkflowJobInfo; log: string }[]): string {
  if (logs.length === 1) return logs[0]?.log ?? '';
  return logs.map(({ job, log }) => `--- ${job.name} ---\n${log}`).join('\n');
}

/**
 * `inner` runs everything but the `githubJob` request; that goes the GitHub way. `available()` is the inner
 * executor's: the GitHub way needs no sandbox.
 */
export function withGithubJob(inner: FullTestExecutor, deps: GithubActionsDeps): FullTestExecutor {
  const { actions, branches, logger } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;

  async function runJob(
    spec: FullTestSpec,
    job: GithubJobRun,
    signal: AbortSignal,
    onStarted: (() => void) | undefined,
  ): Promise<FullTestResult> {
    const began = now();
    let run: WorkflowRunInfo | null = null;
    let runningSince: number | null = null;

    const error = (
      reason: 'github_unavailable' | 'github_run_error' | 'timeout' | 'killed',
      message: string,
    ) =>
      ({
        outcome: 'error',
        reason,
        exitCode: null,
        durationMs: Math.max(0, now() - (runningSince ?? began)),
        failedFiles: [],
        outputTail: withHeader(run, message),
        ...(run ? { externalUrl: run.htmlUrl } : {}),
      }) satisfies FullTestResult;
    const killed = () => error('killed', 'The job was stopped.');

    const problem = problemOf(spec, job);
    if (problem) return error('github_run_error', problem);
    if (signal.aborted) return killed();

    let upstream: string | null;
    try {
      upstream = await branches.upstreamRepo(job.ref, { base: job.base });
    } catch (err) {
      return error('github_unavailable', `The upstream remote could not be read: ${messageOf(err)}`);
    }
    if (upstream === null || upstream.toLowerCase() !== job.repo.toLowerCase())
      return error(
        'github_unavailable',
        `The upstream remote of ${job.base} is ${upstream ?? 'not a github.com repository'}, not ${job.repo}.`,
      );

    // The run is found by its title, which a run id names once: an earlier run of it would be mistaken for this one.
    const title = computeJobRunTitle(job.job, job.commit, spec.runId);
    const find = (own: AbortSignal) =>
      actions.findRunByTitle(job.repo, job.workflow, { branch: job.base, displayTitle: title }, own);
    try {
      if (await find(signal)) return error('github_run_error', 'A run with this run id exists already.');
    } catch (err) {
      if (signal.aborted) return killed();
      return error(
        'github_unavailable',
        `The run could not be looked up (${codeOf(err)}): ${messageOf(err)}`,
      );
    }
    if (signal.aborted) return killed();

    const followed = await followWorkflowRun(
      { actions, logger, now, sleep },
      {
        repo: job.repo,
        workflow: job.workflow,
        dispatchRef: job.base,
        inputs: {
          job: job.job,
          run_id: spec.runId,
          commit: job.commit,
          command: job.command,
          runs_on: job.runsOn,
          outputs: job.outputs.join(' '),
          timeout_minutes: String(job.timeoutMinutes),
          ...(job.node ? { node: job.node } : {}),
        },
        find,
        timeoutMs: spec.timeoutMs,
        stoppedMessage: 'The job was stopped.',
        ...(onStarted ? { onStarted } : {}),
      },
      signal,
      async (done): Promise<FullTestResult> => {
        run = done.run;
        runningSince = done.runningSince;
        const conclusion = done.run.conclusion;
        if (conclusion === 'cancelled') return error('killed', 'The run was cancelled on GitHub.');
        if (conclusion === 'timed_out') return error('timeout', 'The run timed out on GitHub.');
        if (conclusion !== 'success' && conclusion !== 'failure')
          return error('github_run_error', `The run ended as ${conclusion ?? 'unknown'}.`);

        const logs = await done.logs(done.jobs);
        const text = logText(logs);
        const durationMs = Math.max(0, now() - (done.runningSince ?? done.startedAt));
        // GitHub bills the run however it ended; what it cannot say is left out.
        let billableMs: number | null = null;
        try {
          billableMs = (await actions.runTiming(job.repo, done.run.id, signal)).billableMs;
        } catch (err) {
          if (signal.aborted) return killed();
          logger.warn({ err, runId: spec.runId }, 'github job: could not read the run timing');
        }
        const cost = { queuedMs: queuedMsOf(done.run), billableMs };
        const tail = withHeader(
          done.run,
          outputTail(text, GITHUB_OUTPUT_TAIL_CHARS - done.run.htmlUrl.length - 40),
        );

        if (conclusion === 'failure')
          return {
            outcome: 'failed',
            exitCode: 1,
            durationMs,
            failedFiles: [],
            outputTail: tail,
            externalUrl: done.run.htmlUrl,
            cost,
          };

        const reported = parseJobOutputs(text, job.outputs);
        if ('problem' in reported) return error('github_run_error', reported.problem);
        const name = artifactNameOf(spec.runId);
        const artifacts = await done.read('The artifacts', () =>
          actions.listArtifacts(job.repo, done.run.id, signal),
        );
        const artifact = artifacts.filter((item) => item.name === name && !item.expired);
        if (artifact.length !== 1)
          return error(
            'github_run_error',
            `The run has ${artifact.length} live artifacts named ${name}, not one.`,
          );
        return {
          outcome: 'passed',
          exitCode: 0,
          durationMs,
          failedFiles: [],
          outputTail: tail,
          externalUrl: done.run.htmlUrl,
          outputs: reported.outputs,
          artifact: { name, expiresAt: artifact[0]?.expiresAt ?? null },
          cost,
        };
      },
    );
    if (followed.ok) return followed.value;
    run = followed.failure.run;
    runningSince = followed.failure.runningSince;
    return error(followed.failure.reason, followed.failure.message);
  }

  return {
    available: () => inner.available(),
    run(spec, signal, onStarted, options) {
      if (!spec.githubJob) return inner.run(spec, signal, onStarted, options);
      return runJob(spec, spec.githubJob, signal, onStarted);
    },
  };
}
