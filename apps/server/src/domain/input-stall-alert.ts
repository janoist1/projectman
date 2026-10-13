import { ALERT_SEEN_OPTION, alertPayloadOf } from '@projectman/shared';
import type { InboxItem, SessionInputAlert } from '@projectman/shared';
import { ownerHandles } from './access';
import type { DomainContext } from './context';
import type { InboxService } from './inbox';
import type { ProjectService } from './projects';

/**
 * A session that waits for input at its terminal for long (PM-199): messages for it are held back
 * while it does (nothing is typed into a waiting terminal), so a wait nobody can see must not stay
 * silent. A permission request waits in its own state with an inbox item, and a question of an AI
 * member goes to the inbox without a wait at all, so nothing but this alert explains `waiting_input`:
 * an open question of the session does not either. The owners get one `alert` for the wait, pointing
 * at the session. Nothing else happens: the session is not touched.
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
   * or null when the session no longer waits, or an open alert of this kind for it says so already.
   */
  raise(sessionId: string, since: string, minutes: number): InboxItem | null {
    const session = this.ctx.repos.sessions.get(sessionId);
    if (session?.state !== 'waiting_input') return null;
    const config = this.projects.cachedConfig(session.projectKey);
    const owners = config ? ownerHandles(config) : [];
    if (owners.length === 0) return null;
    // Only this alert of the session itself says it already: a question (ask_human) never explains a
    // wait at the terminal, and one that is still open is what a stray hook hides behind (PM-192).
    const told = this.inbox
      .list(session.projectKey, { state: 'open', kind: 'alert' })
      .some((item) => item.sessionId === session.id && alertPayloadOf(item)?.alert === 'session_input');
    if (told) return null;
    const payload: SessionInputAlert = {
      alert: 'session_input',
      workItem: session.workItem,
      since,
      minutes,
      activity: session.activity,
    };
    const item = this.inbox.create({
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
    void this.ctx.events.emit('session_input_stalled', {
      projectKey: session.projectKey,
      sessionId,
      inboxItemId: item.id,
    });
    return item;
  }
}
