import { z } from 'zod';
import { ComputeJobCommit, ComputeJobId, TaskKey } from '@projectman/shared';
import type { ComputeJobRunView } from '@projectman/shared';
import { defineTool, type TeamToolGroup } from '../kit';

const REPO_ARG = z
  .string()
  .min(1)
  .max(100)
  .optional()
  .describe('The repository name in the project; default: the only repository (required with several).');

/** One run for a person or an agent: the state first, then what is known of the result. */
function formatRun(run: ComputeJobRunView): string {
  const lines = [
    `id=${run.id} job=${run.job} repo=${run.repo} commit=${run.commit} status=${run.status}${run.reason ? ` reason=${run.reason}` : ''}`,
  ];
  const times = [
    `created=${run.createdAt}`,
    run.startedAt ? `started=${run.startedAt}` : null,
    run.finishedAt ? `finished=${run.finishedAt}` : null,
  ].filter((part) => part !== null);
  lines.push(times.join(' '));
  const cost = [
    run.durationMs !== null ? `durationMs=${run.durationMs}` : null,
    run.queuedMs !== null ? `queuedMs=${run.queuedMs}` : null,
    run.billableMs !== null ? `billableMs=${run.billableMs}` : null,
  ].filter((part) => part !== null);
  if (cost.length > 0) lines.push(cost.join(' '));
  if (run.externalUrl) lines.push(`url=${run.externalUrl}`);
  for (const output of run.outputs)
    lines.push(`output ${output.path} sha256=${output.sha256} bytes=${output.bytes}`);
  if (run.artifact)
    lines.push(
      `artifact ${run.artifact.name}${run.artifact.expiresAt ? ` expires=${run.artifact.expiresAt}` : ''}`,
    );
  if (run.outputTail) lines.push(`--- log tail ---\n${run.outputTail}`);
  return lines.join('\n');
}

const formatList = (runs: readonly ComputeJobRunView[]): string =>
  runs.length === 0
    ? 'no compute job runs'
    : runs
        .map((run) => `${run.id} ${run.job} ${run.commit.slice(0, 12)} ${run.status} ${run.createdAt}`)
        .join('\n');

export const COMPUTE_JOB_TOOL_GROUP: TeamToolGroup = {
  module: 'services/compute-jobs',
  tools: [
    defineTool({
      name: 'run_compute_job',
      audience: { duties: ['deployment'] },
      title: 'Run a compute job on GitHub Actions',
      readOnly: false,
      description:
        'Start a job of the repository settings (`computeJobs`) on GitHub Actions, on a commit on the remote ' +
        'default branch. Answers with the queued run; follow it with get_compute_job. A going or live-artifact ' +
        'run of the same commit is returned unless `force`. Costs GitHub minutes: only on request.',
      input: {
        job: ComputeJobId.describe('The job name in the repository settings.'),
        commit: ComputeJobCommit.describe(
          'The full 40-character commit id; it must be on the remote default branch.',
        ),
        repo: REPO_ARG,
        force: z
          .boolean()
          .optional()
          .describe('Start a new run even if the commit has a live run or artifact already (default false).'),
        task_key: TaskKey.optional().describe('A card of this project that gets a note when the run ends.'),
      },
      external: {
        access: 'write',
        modes: ['super'],
        async run({ ctx, args, handler }) {
          const run = await handler.runComputeJob(ctx, {
            job: args.job,
            commit: args.commit,
            ...(args.repo ? { repo: args.repo } : {}),
            ...(args.force !== undefined ? { force: args.force } : {}),
            ...(args.task_key ? { taskKey: args.task_key } : {}),
          });
          return { structured: { run }, text: formatRun(run) };
        },
      },
      async run({ ctx, args, handler }) {
        const run = await handler.runComputeJob(ctx, {
          job: args.job,
          commit: args.commit,
          ...(args.repo ? { repo: args.repo } : {}),
          ...(args.force !== undefined ? { force: args.force } : {}),
          ...(args.task_key ? { taskKey: args.task_key } : {}),
        });
        return formatRun(run);
      },
    }),
    defineTool({
      name: 'get_compute_job',
      audience: { duties: ['deployment'] },
      title: 'Read a compute job run',
      readOnly: true,
      description:
        'Read one run of a compute job: its state, times, cost (GitHub billable time), run link, the declared ' +
        'outputs with their digests, the artifact and the tail of the log.',
      input: { id: z.string().min(1).max(100).describe('The run id run_compute_job answered.') },
      external: {
        access: 'read',
        modes: ['super', 'read'],
        async run({ ctx, args, handler }) {
          const run = await handler.getComputeJob(ctx, { id: args.id });
          return { structured: { run }, text: formatRun(run) };
        },
      },
      async run({ ctx, args, handler }) {
        return formatRun(await handler.getComputeJob(ctx, { id: args.id }));
      },
    }),
    defineTool({
      name: 'list_compute_jobs',
      audience: { duties: ['deployment'] },
      title: 'List compute job runs',
      readOnly: true,
      description: "The project's compute job runs, newest first; filter by repository or job.",
      input: {
        repo: REPO_ARG,
        job: ComputeJobId.optional().describe('Only the runs of this job.'),
        limit: z.number().int().min(1).max(100).optional().describe('How many runs (default 20).'),
      },
      external: {
        access: 'read',
        modes: ['super', 'read'],
        async run({ ctx, args, handler }) {
          const runs = await handler.listComputeJobs(ctx, {
            ...(args.repo ? { repo: args.repo } : {}),
            ...(args.job ? { job: args.job } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          });
          return { structured: { runs }, text: formatList(runs) };
        },
      },
      async run({ ctx, args, handler }) {
        return formatList(
          await handler.listComputeJobs(ctx, {
            ...(args.repo ? { repo: args.repo } : {}),
            ...(args.job ? { job: args.job } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          }),
        );
      },
    }),
  ],
};
