import { ALERT_SEEN_OPTION } from '@projectman/shared';
import type { InboxItem, SessionInputAlert } from '@projectman/shared';
import { ownerHandles } from './access';
import type { DomainContext } from './context';
import type { InboxService } from './inbox';
import type { ProjectService } from './projects';

/**
 * A session that waits for input at its terminal for long (PM-199): messages for it are held back
 * while it does (nothing is typed into a waiting terminal), so a wait nobody can see must not stay
 * silent. A permission request waits in its own state with an inbox item; a question of an AI member
 * goes to the inbox as well. What is left here is a dialog or a question that has no item, and the
 * owners get one `alert` for the wait, pointing at the session. Nothing else happens: the session is
 * not touched.
 */
export class InputStallAlerts {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly inbox: InboxService;

  constructor(deps: { ctx: DomainContext; projects: ProjectService; inbox: InboxService }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.inbox = deps.inbox;
  }

  /**
   * The wait of `sessionId` that began at `since` (ISO time) has lasted `minutes`: the alert item,
   * or null when the session no longer waits, or an open question or alert of it already says so.
   */
  raise(sessionId: string, since: string, minutes: number): InboxItem | null {
    const session = this.ctx.repos.sessions.get(sessionId);
    if (session?.state !== 'waiting_input') return null;
    const config = this.projects.cachedConfig(session.projectKey);
    const owners = config ? ownerHandles(config) : [];
    if (owners.length === 0) return null;
    const visible = this.inbox
      .list(session.projectKey, { state: 'open' })
      .some((item) => item.sessionId === session.id && (item.kind === 'question' || item.kind === 'alert'));
    if (visible) return null;
    const payload: SessionInputAlert = {
      alert: 'session_input',
      workItem: session.workItem,
      since,
      minutes,
      activity: session.activity,
    };
    return this.inbox.create({
      projectKey: session.projectKey,
      kind: 'alert',
      assignees: owners,
      source: session.member,
      sessionId: session.id,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      title: `Session of ${session.member} waits for input without a question, for ${minutes} minutes`,
      payload,
      options: [ALERT_SEEN_OPTION],
    });
  }
}
