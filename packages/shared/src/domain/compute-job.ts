import { z } from 'zod';

/**
 * Heavy machine work run on GitHub Actions (PM-1144, PM-1145): one general workflow file, started by hand
 * (`workflow_dispatch`), runs a shell command on a hosted runner and publishes attested output files as an
 * artifact. The run's title names the job, the commit and the run id, so a later step finds its run from it.
 */
export const COMPUTE_JOB_WORKFLOW = 'projectman-job.yml';

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
