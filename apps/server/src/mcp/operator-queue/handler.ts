import { isOperator, memberOf } from '@projectman/shared';
import type { OperatorQueueToolsHandler, ToolContext } from '../../contracts';
import type { OperatorQueueFinisher } from '../../core/member-queue';
import type { ProjectService } from '../../core/projects';
import { forbidden } from '../../kernel';
import { toToolError } from '../caller';

export class OperatorQueueTools implements OperatorQueueToolsHandler {
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly finisher: Pick<OperatorQueueFinisher, 'finish'>;

  constructor(deps: {
    projects: Pick<ProjectService, 'config'>;
    finisher: Pick<OperatorQueueFinisher, 'finish'>;
  }) {
    this.projects = deps.projects;
    this.finisher = deps.finisher;
  }

  async finishQueueItem(ctx: ToolContext, args: Parameters<OperatorQueueToolsHandler['finishQueueItem']>[1]) {
    try {
      // Not `callerWithRequest`: the item itself says whether the session may end it, and it is the Operator's alone.
      const config = await this.projects.config(ctx.projectKey);
      if (!isOperator(memberOf(config, ctx.member)))
        throw forbidden('operator_only', 'only the Operator ends the items of its work queue');
      const item = await this.finisher.finish({
        projectKey: ctx.projectKey,
        member: ctx.member,
        sessionId: ctx.sessionId,
        itemId: args.itemId,
        outcome: args.outcome,
        summary: args.summary,
        ...(args.answer ? { answer: args.answer } : {}),
        operationIds: args.operationIds,
        ...(args.fixLimitOption ? { fixLimitOption: args.fixLimitOption } : {}),
        ...(args.handoff ? { handoff: args.handoff } : {}),
      });
      return { item };
    } catch (err) {
      throw toToolError(err);
    }
  }
}
