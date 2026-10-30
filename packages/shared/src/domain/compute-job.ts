import { z } from 'zod';

/**
 * Heavy machine work run on GitHub Actions (PM-1144, PM-1145): one general workflow file, started by hand
 * (`workflow_dispatch`), runs a shell command on a hosted runner and publishes attested output files as an
 * artifact. The run's title names the job, the commit and the run id, so a later step finds its run from it.
 */
export const COMPUTE_JOB_WORKFLOW = 'projectman-job.yml';

/** The limits of a job definition, shared by the hub's settings, the engine's registration and the wire. */
export const COMPUTE_JOB_COMMAND_MAX = 2000;
export const COMPUTE_JOB_TIMEOUT_MINUTES_MAX = 360;
export const COMPUTE_JOB_NODE_VERSION = /^\d{1,2}$/;
/** A GitHub repository, `owner/name`. */
export const GITHUB_REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** The name of a job kind, for example `cloud-image`. */
export const ComputeJobId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export type ComputeJobId = z.infer<typeof ComputeJobId>;

/** The id of one run of a job; the artifact is named `projectman-job-<id>`. */
export const ComputeJobRunId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export type ComputeJobRunId = z.infer<typeof ComputeJobRunId>;

/** The commit a job runs on: a full lowercase SHA-1. */
export const ComputeJobCommit = z.string().regex(/^[0-9a-f]{40}$/);
export type ComputeJobCommit = z.infer<typeof ComputeJobCommit>;

/** A declared output file: a relative path of plain segments (no `.` or `..`), at most 200 characters. */
export const ComputeJobOutputPath = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine((value) => value.split('/').every((segment) => segment !== '.' && segment !== '..'));
export type ComputeJobOutputPath = z.infer<typeof ComputeJobOutputPath>;

/** The runner labels the general workflow offers (its `runs_on` options are exactly these). */
export const GithubJobRunner = z.enum(['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15']);
export type GithubJobRunner = z.infer<typeof GithubJobRunner>;

/**
 * A compute job a repository may run (PM-1147): what the owner registers in the engine's `engine.json`. The
 * workflow runs with the right to attest its outputs, so an engine starts only a job it has registered, with
 * exactly these values.
 */
export const ComputeJobDefinition = z.strictObject({
  id: ComputeJobId,
  command: z.string().min(1).max(COMPUTE_JOB_COMMAND_MAX),
  runsOn: GithubJobRunner,
  outputs: z
    .array(ComputeJobOutputPath)
    .min(1)
    .max(10)
    .refine((paths) => new Set(paths).size === paths.length, 'The outputs are not unique'),
  node: z.string().regex(COMPUTE_JOB_NODE_VERSION).optional(),
  timeoutMinutes: z.number().int().min(1).max(COMPUTE_JOB_TIMEOUT_MINUTES_MAX).default(60),
});
export type ComputeJobDefinition = z.infer<typeof ComputeJobDefinition>;

/** The jobs of one repository: at most 20, with unique ids. */
export const ComputeJobDefinitions = z
  .array(ComputeJobDefinition)
  .max(20)
  .refine((jobs) => new Set(jobs.map((job) => job.id)).size === jobs.length, 'The job ids are not unique');
export type ComputeJobDefinitions = z.infer<typeof ComputeJobDefinitions>;

export const ComputeJobRunStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'error', 'cancelled']);
export type ComputeJobRunStatus = z.infer<typeof ComputeJobRunStatus>;

/** Where a run goes: the repository's GitHub workflow today; `engine` is reserved for a later runner. */
export const ComputeJobRunner = z.enum(['github_actions', 'engine']);
export type ComputeJobRunner = z.infer<typeof ComputeJobRunner>;

/** One recorded run of a compute job, as the hub shows it (PM-1148). */
export const ComputeJobRunView = z.strictObject({
  id: ComputeJobRunId,
  projectKey: z.string(),
  repo: z.string(),
  job: ComputeJobId,
  commit: ComputeJobCommit,
  runner: ComputeJobRunner,
  status: ComputeJobRunStatus,
  reason: z.string().nullable(),
  requestedBy: z.string(),
  taskKey: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  queuedMs: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  billableMs: z.number().int().nullable(),
  externalUrl: z.string().nullable(),
  outputTail: z.string().nullable(),
  outputs: z.array(z.strictObject({ path: z.string(), sha256: z.string(), bytes: z.number().int() })),
  artifact: z.strictObject({ name: z.string(), expiresAt: z.string().nullable() }).nullable(),
});
export type ComputeJobRunView = z.infer<typeof ComputeJobRunView>;

/** The title of a run (the workflow's `run-name`). */
export function computeJobRunTitle(job: string, commit: string, runId: string): string {
  return `projectman-job ${job} ${commit} ${runId}`;
}

const RUN_TITLE = /^projectman-job (\S+) (\S+) (\S+)$/;

/** The parts of a run title, or null when it is not a valid one. */
export function parseComputeJobRunTitle(
  title: string,
): { job: ComputeJobId; commit: ComputeJobCommit; runId: ComputeJobRunId } | null {
  const match = RUN_TITLE.exec(title);
  if (!match) return null;
  const job = ComputeJobId.safeParse(match[1]);
  const commit = ComputeJobCommit.safeParse(match[2]);
  const runId = ComputeJobRunId.safeParse(match[3]);
  if (!job.success || !commit.success || !runId.success) return null;
  return { job: job.data, commit: commit.data, runId: runId.data };
}
