import { z } from 'zod';
import type {
  GithubActionsClient,
  GithubModuleOptions,
  WorkflowJobInfo,
  WorkflowRunInfo,
} from '../../contracts';
import { GithubError } from './errors';
import { createGhRunner } from './gh';
import { isValidBranch, isValidRepo } from './refs';

/** One GitHub call may be slower than a pull request lookup (a job log is big). */
const DEFAULT_TIMEOUT_MS = 30_000;
const WORKFLOW_NAME = /^[\w.-]{1,100}$/;
const RUNS_PER_PAGE = 10;
const JOBS_PER_PAGE = 100;

const RunSchema = z.object({
  id: z.number().int().positive(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  head_sha: z.string(),
  head_branch: z.string().nullish(),
  html_url: z.string(),
  created_at: z.string(),
});
const RunsSchema = z.object({ workflow_runs: z.array(RunSchema) });
const StepSchema = z.object({
  name: z.string(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
});
const JobSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
  steps: z.array(StepSchema).nullish(),
});
const JobsSchema = z.object({ jobs: z.array(JobSchema) });

type GhRun = z.infer<typeof RunSchema>;

function toRunInfo(run: GhRun): WorkflowRunInfo {
  return {
    id: run.id,
    status: run.status ?? '',
    conclusion: run.conclusion ?? null,
    headSha: run.head_sha,
    headBranch: run.head_branch ?? '',
    htmlUrl: run.html_url,
    createdAt: run.created_at,
  };
}

function toJobInfo(job: z.infer<typeof JobSchema>): WorkflowJobInfo {
  return {
    id: job.id,
    name: job.name,
    status: job.status ?? '',
    conclusion: job.conclusion ?? null,
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
    steps: (job.steps ?? []).map((step) => ({
      name: step.name,
      status: step.status ?? '',
      conclusion: step.conclusion ?? null,
      startedAt: step.started_at ?? null,
      completedAt: step.completed_at ?? null,
    })),
  };
}

function parse<S extends z.ZodType>(schema: S, stdout: string, what: string): z.output<S> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (err) {
    throw new GithubError('invalid_response', `${what} did not print JSON`, { cause: err });
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new GithubError('invalid_response', `${what} printed unexpected JSON: ${issues}`, {
      cause: result.error,
    });
  }
  return result.data;
}

/** The repository and workflow of a call, checked: they become part of the API path. */
function assertTarget(repo: string, workflow?: string): void {
  if (!isValidRepo(repo))
    throw new GithubError('invalid_argument', `invalid repository "${repo}", expected owner/name`);
  if (workflow !== undefined && !WORKFLOW_NAME.test(workflow))
    throw new GithubError('invalid_argument', `invalid workflow "${workflow}"`);
}

function assertId(id: number, what: string): void {
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new GithubError('invalid_argument', `invalid ${what} id: ${id}`);
}

/** gh answers cancelling a finished run with HTTP 409. */
const ALREADY_COMPLETED = /HTTP 409/;
const UNKNOWN_ESCAPE_FLAG = /unknown flag:?\s+--allow-escape-sequences/i;

/**
 * GitHub Actions through `gh api` (PM-900): the machine's own `gh` login, started without a shell with
 * every argument as its own argv entry. Nothing here uses a token of its own.
 */
export function createGithubActionsClient(
  opts: GithubModuleOptions & { timeoutMs?: number; env?: Record<string, string> },
): GithubActionsClient {
  const run = createGhRunner({
    ghBin: opts.ghBin || 'gh',
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(opts.env ? { env: opts.env } : {}),
    logger: opts.logger,
  });

  return {
    async dispatchWorkflow(repo, workflow, input, signal) {
      assertTarget(repo, workflow);
      if (!isValidBranch(input.ref)) throw new GithubError('invalid_argument', `invalid ref "${input.ref}"`);
      const fields = [
        `ref=${input.ref}`,
        ...Object.entries(input.inputs).map(([name, value]) => `inputs[${name}]=${value}`),
      ].flatMap((field) => ['--raw-field', field]);
      await run(
        ['api', '--method=POST', `repos/${repo}/actions/workflows/${workflow}/dispatches`, ...fields],
        { signal },
      );
    },

    async findDispatchedRun(repo, workflow, input, signal) {
      assertTarget(repo, workflow);
      if (!isValidBranch(input.branch))
        throw new GithubError('invalid_argument', `invalid branch "${input.branch}"`);
      const query = `branch=${encodeURIComponent(input.branch)}&event=workflow_dispatch&per_page=${RUNS_PER_PAGE}`;
      const stdout = await run(['api', `repos/${repo}/actions/workflows/${workflow}/runs?${query}`], {
        signal,
      });
      const wanted = input.headSha.toLowerCase();
      const found = parse(RunsSchema, stdout, 'gh api workflow runs')
        .workflow_runs.filter((item) => item.head_sha.toLowerCase() === wanted)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      return found ? toRunInfo(found) : null;
    },

    async getRun(repo, runId, signal) {
      assertTarget(repo);
      assertId(runId, 'run');
      const stdout = await run(['api', `repos/${repo}/actions/runs/${runId}`], { signal });
      return toRunInfo(parse(RunSchema, stdout, 'gh api workflow run'));
    },

    async listJobs(repo, runId, signal) {
      assertTarget(repo);
      assertId(runId, 'run');
      const stdout = await run(
        ['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=${JOBS_PER_PAGE}`],
        { signal },
      );
      return parse(JobsSchema, stdout, 'gh api workflow jobs').jobs.map(toJobInfo);
    },

    async jobLog(repo, jobId, signal) {
      assertTarget(repo);
      assertId(jobId, 'job');
      const endpoint = `repos/${repo}/actions/jobs/${jobId}/logs`;
      // A newer gh refuses a response with terminal escape sequences (a job log has colours) unless told
      // to allow them; an older gh does not know the flag, so it is retried without.
      try {
        return await run(['api', '--allow-escape-sequences', endpoint], { signal });
      } catch (err) {
        if (err instanceof GithubError && UNKNOWN_ESCAPE_FLAG.test(`${err.message}\n${err.stderr}`)) {
          return run(['api', endpoint], { signal });
        }
        throw err;
      }
    },

    async cancelRun(repo, runId, signal) {
      assertTarget(repo);
      assertId(runId, 'run');
      try {
        await run(['api', '--method=POST', `repos/${repo}/actions/runs/${runId}/cancel`], { signal });
      } catch (err) {
        if (err instanceof GithubError && ALREADY_COMPLETED.test(`${err.message}\n${err.stderr}`)) return;
        throw err;
      }
    },
  };
}
