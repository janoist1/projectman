import type { ComputeJobRunView } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type {
  ComputeJobToolsHandler,
  ListComputeJobsArgs,
  RunComputeJobArgs,
  ToolContext,
} from '../../contracts';
import { DomainError } from '../../kernel';
import type { ComputeJobService } from '../../services/compute-jobs';
import type { ToolCaller } from '../caller';

/** The agent reads the code: it says what to do (the commit is not pushed, two jobs run already). */
export function asToolError(err: unknown): unknown {
  if (
    err instanceof DomainError &&
    (err.code.startsWith('compute_job_') || err.code === 'engine_offline' || err.code === 'release_no_github')
  )
    return new TeamToolError(err.status === 403 ? 'forbidden' : 'invalid', `${err.code}: ${err.message}`);
  return err;
}

export class ComputeJobTools implements ComputeJobToolsHandler {
  private readonly calls: ToolCaller;
  private readonly jobs: Pick<ComputeJobService, 'start' | 'get' | 'list'>;

  constructor(deps: { calls: ToolCaller; jobs: Pick<ComputeJobService, 'start' | 'get' | 'list'> }) {
    this.calls = deps.calls;
    this.jobs = deps.jobs;
  }

  async runComputeJob(ctx: ToolContext, args: RunComputeJobArgs): Promise<ComputeJobRunView> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'run_compute_job');
      try {
        return await this.jobs.start(
          { kind: 'ai', handle: ctx.member },
          {
            projectKey: ctx.projectKey,
            job: args.job,
            commit: args.commit,
            repo: args.repo,
            force: args.force,
            taskKey: args.taskKey,
          },
        );
      } catch (err) {
        throw asToolError(err);
      }
    });
  }

  async getComputeJob(ctx: ToolContext, args: { id: string }): Promise<ComputeJobRunView> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'get_compute_job');
      return this.jobs.get(ctx.projectKey, args.id);
    });
  }

  async listComputeJobs(ctx: ToolContext, args: ListComputeJobsArgs): Promise<ComputeJobRunView[]> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'list_compute_jobs');
      return this.jobs.list(ctx.projectKey, args);
    });
  }
}
