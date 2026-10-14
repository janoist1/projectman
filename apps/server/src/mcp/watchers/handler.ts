import type { ToolContext } from '../../contracts';
import { type ToolCaller, toToolError } from '../caller';
import type { WatcherToolsHandler } from '../../contracts/team-tools';
import type { FixLimitDecision, FixLimitWatch } from '../../domain/fix-limit';

export class WatcherTools implements WatcherToolsHandler {
  private readonly calls: ToolCaller;
  private readonly fixLimit: Pick<FixLimitWatch, 'decide'>;
  constructor(deps: { calls: ToolCaller; fixLimit: Pick<FixLimitWatch, 'decide'> }) {
    this.calls = deps.calls;
    this.fixLimit = deps.fixLimit;
  }

  async decideFixLimit(
    ctx: ToolContext,
    args: { taskKey: string; decision: FixLimitDecision; reason: string },
  ) {
    try {
      await this.calls.caller(ctx, 'decide_fix_limit');
      return await this.fixLimit.decide(ctx.member, ctx.projectKey, args.taskKey, args.decision, args.reason);
    } catch (err) {
      throw toToolError(err);
    }
  }
}
