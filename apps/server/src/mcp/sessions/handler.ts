import type { ToolContext } from '../../contracts';
import { TeamToolError } from '../../contracts';
import type { ToolCaller } from '../caller';
import type { SessionToolsHandler } from '../../contracts/team-tools';
import type { WorkDoing } from '@projectman/shared';
import type { DomainContext } from '../../domain/context';
import type { SessionOrchestrator } from '../../runtime/sessions';

export class SessionTools implements SessionToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: DomainContext;
  private readonly sessions: Pick<SessionOrchestrator, 'setDoing'>;
  constructor(deps: {
    calls: ToolCaller;
    ctx: DomainContext;
    sessions: Pick<SessionOrchestrator, 'setDoing'>;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.sessions = deps.sessions;
  }

  async setCurrentWork(ctx: ToolContext, args: WorkDoing): Promise<{ recorded: boolean }> {
    return this.calls.guard(async () => {
      await this.calls.caller(ctx, 'set_current_work');
      const session = this.ctx.repos.sessions.get(ctx.sessionId);
      if (
        !session ||
        session.projectKey !== ctx.projectKey ||
        session.member !== ctx.member ||
        session.workItem.type !== 'task'
      )
        throw new TeamToolError(
          'invalid',
          'set_current_work is only for a session working on a task: this one is a meeting, a general chat or a scheduled run.',
        );
      return { recorded: this.sessions.setDoing(ctx.sessionId, args) };
    });
  }
}
