import { isOperator, memberOf } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import type { MergeCheckRun } from '@projectman/shared';
import type { ListMergeChecksInput, MergeCheckList, MergeToolsHandler, ToolContext } from '../../contracts';
import { canSeeTask } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { aiActor } from '../../kernel';
import type { Merges } from '../../services/merges';
import type { ToolCaller } from '../caller';

/** The runs list_merge_checks returns when it is not told how many. */
export const MERGE_CHECKS_DEFAULT_LIMIT = 30;

export class MergeTools implements MergeToolsHandler {
  private readonly calls: ToolCaller;
  private readonly merges: Pick<Merges, 'start' | 'prioritize' | 'checkRuns'>;
  private readonly tasks: Pick<TaskService, 'find'>;
  constructor(deps: {
    calls: ToolCaller;
    merges: Pick<Merges, 'start' | 'prioritize' | 'checkRuns'>;
    tasks: Pick<TaskService, 'find'>;
  }) {
    this.calls = deps.calls;
    this.merges = deps.merges;
    this.tasks = deps.tasks;
  }

  async listMergeChecks(ctx: ToolContext, args: ListMergeChecksInput): Promise<MergeCheckList> {
    return this.calls.guard(async () => {
      const { guest } = await this.calls.callerWithRequest(ctx, 'list_merge_checks');
      const taskKey =
        args.taskKey === undefined ? undefined : this.calls.visibleTaskKey(ctx, guest, args.taskKey);
      const limit = args.limit ?? MERGE_CHECKS_DEFAULT_LIMIT;
      const kind = args.kind ?? 'checks';
      const query = {
        projectKey: ctx.projectKey,
        ...(taskKey ? { taskKey } : {}),
        ...(args.outcome && args.outcome !== 'any' ? { outcome: args.outcome } : {}),
        ...(kind === 'any' ? {} : { kinds: kind === 'checks' ? (['merge', 'train'] as const) : [kind] }),
        ...(args.since ? { since: new Date(args.since).toISOString() } : {}),
        ...(args.until ? { until: new Date(args.until).toISOString() } : {}),
        limit,
      };
      const visible = (run: MergeCheckRun) =>
        !guest ||
        run.taskKeys.every((key) => {
          const task = this.tasks.find(ctx.projectKey, key);
          return !!task && canSeeTask(guest.viewer, task);
        });
      // A run with a card the caller may not see is left out after the page is read, so page on until the limit is full.
      const runs: MergeCheckRun[] = [];
      for (let offset = 0; ; offset += limit) {
        const page = this.merges.checkRuns({ ...query, offset });
        for (const run of page.runs) {
          if (!visible(run)) continue;
          if (runs.length === limit) return { runs, hasMore: true };
          runs.push(run);
        }
        if (!page.hasMore) return { runs, hasMore: false };
      }
    });
  }

  async mergeTask(
    ctx: ToolContext,
    args: { taskKey: string; fixConflict?: boolean; resolution?: string },
  ): Promise<{ task: Task }> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'merge_task');
      return {
        task: await this.merges.start(
          ctx.projectKey,
          this.calls.validTaskKey(ctx, args.taskKey),
          aiActor(ctx.member),
          args,
        ),
      };
    });
  }

  async prioritizeMerge(
    ctx: ToolContext,
    args: { taskKey: string; reason: string },
  ): Promise<{ task: Task; moved: boolean }> {
    return this.calls.guard(async () => {
      const caller = await this.calls.callerWithRequest(ctx, 'prioritize_merge');
      const taskKey = this.calls.validTaskKey(ctx, args.taskKey);
      const operator = isOperator(memberOf(caller.config, ctx.member));
      return this.calls.recorded(caller, operator ? { action: 'task_update', taskKey } : null, () =>
        this.merges.prioritize(ctx.projectKey, taskKey, aiActor(ctx.member), args.reason),
      );
    });
  }
}
