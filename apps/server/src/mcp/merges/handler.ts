import { isOperator, memberOf } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import type { MergeToolsHandler, ToolContext } from '../../contracts';
import { aiActor } from '../../domain/util';
import type { Merges } from '../../services/merges';
import type { ToolCaller } from '../caller';

export class MergeTools implements MergeToolsHandler {
  private readonly calls: ToolCaller;
  private readonly merges: Pick<Merges, 'start' | 'prioritize'>;
  constructor(deps: { calls: ToolCaller; merges: Pick<Merges, 'start' | 'prioritize'> }) {
    this.calls = deps.calls;
    this.merges = deps.merges;
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
