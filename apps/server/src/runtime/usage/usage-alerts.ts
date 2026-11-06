import { limitTokens, usageTotal } from '@projectman/shared';
import type { SessionTokensAlert, SessionUsageAlert } from '@projectman/shared';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import type { InboxService } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';

/**
 * The warning limit of a session's tokens (PM-187): once a session's usage, as `limitTokens` counts
 * it, reaches the project's `warnAboveSessionTokens`, the owners get one `system_notice` message
 * about the session (PM-1250), and the session is marked. Nothing else happens: the session keeps
 * running. It is checked when the session reports usage, so changing the limit raises nothing about
 * sessions that no longer run.
 */
export class UsageAlerts {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly inbox: InboxService;

  constructor(deps: { ctx: DomainContext; projects: ProjectService; inbox: InboxService }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.inbox = deps.inbox;
  }

  /** After the session's usage grew: whether this raised the warning (the session is marked, the owners are told). */
  check(sessionId: string): boolean {
    const session = this.ctx.repos.sessions.get(sessionId);
    if (!session?.usage || session.usageAlert) return false;
    const config = this.projects.cachedConfig(session.projectKey);
    const limit = config?.team.limits.warnAboveSessionTokens;
    if (!config || limit === undefined) return false;
    const counted = limitTokens(usageTotal(session.usage.rows));
    if (counted < limit) return false;
    const alert: SessionUsageAlert = { at: isoNow(this.ctx), countedTokens: counted, limitTokens: limit };
    const payload: SessionTokensAlert = {
      alert: 'session_tokens',
      countedTokens: counted,
      limitTokens: limit,
      workItem: session.workItem,
      sessionStartedAt: session.startedAt,
    };
    return this.ctx.unitOfWork(() => {
      // Two usage events close together: only the one that marks the session raises the warning.
      if (!this.ctx.repos.sessions.markUsageAlert(session.id, alert)) return false;
      this.inbox.raiseAlert({
        projectKey: session.projectKey,
        source: session.member,
        sessionId: session.id,
        taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
        title: `Session used ${counted} tokens, above the warning limit of ${limit}`,
        payload,
      });
      return true;
    });
  }
}
