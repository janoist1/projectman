import { ERROR_CODES, isOperator, memberOf } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type { SystemFeedbackToolsHandler, ToolContext } from '../../contracts';
import { DomainError } from '../../kernel';
import type { ProjectService } from '../../core/projects';
import type { SystemFeedbackService } from '../../services/feedback';
import type { ToolCaller } from '../caller';

/** A refusal in words the agent reads: the error code first (`code: message`). */
function systemFeedbackToolError(err: unknown): unknown {
  if (err instanceof TeamToolError) return err;
  if (err instanceof DomainError)
    return new TeamToolError(
      err.status === 403 ? 'forbidden' : 'invalid',
      (ERROR_CODES as readonly string[]).includes(err.code) ? `${err.code}: ${err.message}` : err.message,
    );
  return err;
}

/**
 * The Operator's tools for recording gaps in projectman (PM-472, PM-479). Only the project's Operator calls
 * them; they need no open owner request (a gap is recorded when it is found), but under an approval
 * continuation and in a guest conversation they stay refused (`ToolCaller.callerWithRequest`).
 */
export class SystemFeedbackTools implements SystemFeedbackToolsHandler {
  private readonly calls: ToolCaller;
  private readonly projects: Pick<ProjectService, 'config'>;
  private readonly systemFeedback: Pick<SystemFeedbackService, 'listForOperator' | 'record'>;

  constructor(deps: {
    calls: ToolCaller;
    projects: Pick<ProjectService, 'config'>;
    systemFeedback: Pick<SystemFeedbackService, 'listForOperator' | 'record'>;
  }) {
    this.calls = deps.calls;
    this.projects = deps.projects;
    this.systemFeedback = deps.systemFeedback;
  }

  private async requireOperator(ctx: ToolContext, tool: string): Promise<void> {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        `system_feedback_operator_only: only the Operator may use ${tool}.`,
      );
  }

  async listSystemFeedback(ctx: ToolContext) {
    await this.requireOperator(ctx, 'list_system_feedback');
    await this.calls.callerWithRequest(ctx, 'list_system_feedback');
    return {
      items: this.systemFeedback.listForOperator(ctx.projectKey).map((row) => ({
        id: row.id,
        state: row.state,
        title: row.title,
        occurrences: row.occurrences,
        last_seen_at: row.lastSeenAt,
      })),
    };
  }

  async recordSystemFeedback(
    ctx: ToolContext,
    args: { title: string; what: string; workaround: string; fix: string; sameAs?: string },
  ) {
    await this.requireOperator(ctx, 'record_system_feedback');
    const caller = await this.calls.callerWithRequest(ctx, 'record_system_feedback');
    return this.calls
      .recorded(
        caller,
        {
          action: 'system_feedback',
          madeSystemFeedback: (result) => ({
            id: result.id,
            title: result.title,
            occurrence: result.occurrences,
          }),
        },
        async () => {
          const item = await this.systemFeedback.record(ctx.projectKey, ctx.member, ctx.sessionId, args);
          return {
            id: item.id,
            state: item.state,
            title: item.title,
            created: args.sameAs === undefined,
            occurrences: item.occurrences.length,
          };
        },
      )
      .then(({ id, state, created, occurrences }) => ({ id, state, created, occurrences }))
      .catch((err: unknown) => {
        throw systemFeedbackToolError(err);
      });
  }
}
