import { ALERT_SEEN_OPTION, limitTokens, usageTotal } from '@projectman/shared';
import type { InboxItem, SessionTokensAlert, SessionUsageAlert } from '@projectman/shared';
import { ownerHandles } from './access';
import { isoNow } from './context';
import type { DomainContext } from './context';
import type { InboxService } from './inbox';
import type { ProjectService } from './projects';

/**
 * The warning limit of a session's tokens (PM-187): once a session's usage, as `limitTokens` counts
 * it, reaches the project's `warnAboveSessionTokens`, the owners get one `alert` in their inbox
 * pointing at the session, and the session is marked. Nothing else happens: the session keeps
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

  /** After the session's usage grew: the alert item when this raised one, else null. */
  check(sessionId: string): InboxItem | null {
    const session = this.ctx.repos.sessions.get(sessionId);
    if (!session?.usage || session.usageAlert) return null;
    const config = this.projects.cachedConfig(session.projectKey);
    const limit = config?.team.limits.warnAboveSessionTokens;
    if (!config || limit === undefined) return null;
    const counted = limitTokens(usageTotal(session.usage.rows));
    if (counted < limit) return null;
    const owners = ownerHandles(config);
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
      if (!this.ctx.repos.sessions.markUsageAlert(session.id, alert) || owners.length === 0) return null;
      return this.inbox.create({
        projectKey: session.projectKey,
        kind: 'alert',
        assignees: owners,
        source: session.member,
        sessionId: session.id,
        taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
        title: `Session used ${counted} tokens, above the warning limit of ${limit}`,
        payload,
        options: [ALERT_SEEN_OPTION],
      });
    });
  }
}
