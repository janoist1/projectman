import type { Session } from '@projectman/shared';
import type { SessionCleanup } from '../../contracts';
import type { DomainContext } from '../../core/base';
import { isoNow } from '../../core/base';
import type { MemberWorkspaces } from './workspaces';

/** One transaction records scope failure/recovery together with its workspace reservation. */
export class CleanupFailures {
  private readonly ctx: DomainContext;
  constructor(ctx: DomainContext) {
    this.ctx = ctx;
  }

  observe(session: Session, cleanup: SessionCleanup | undefined, workspaces: MemberWorkspaces | null): void {
    this.ctx.repos.transaction(() => {
      if (cleanup?.outcome === 'failed')
        this.ctx.repos.sessionCleanups.failed({
          scopeId: cleanup.scopeId,
          sessionId: session.id,
          projectKey: session.projectKey,
          taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
          kind: cleanup.kind,
          survivors: cleanup.survivors,
          failedAt: isoNow(this.ctx),
          lastAttemptAt: null,
          attempts: 0,
        });
      if (cleanup?.outcome === 'clean') this.ctx.repos.sessionCleanups.recovered(session.id, cleanup.scopeId);
      workspaces?.ended(session.id, cleanup);
    });
  }
  hasSession(sessionId: string): boolean {
    return this.ctx.repos.sessionCleanups.forSession(sessionId).length > 0;
  }
  pending() {
    return this.ctx.repos.sessionCleanups.list();
  }
  attempted(scopeId: string): void {
    this.ctx.repos.sessionCleanups.attempted(scopeId, isoNow(this.ctx));
  }
}
