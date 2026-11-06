import type { InboxItem, Session, SessionInputAlert } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { InboxService } from '../../core/inbox';

/**
 * A session that waits for input at its terminal for long (PM-199): messages for it are held back
 * while it does (nothing is typed into a waiting terminal), so a wait nobody can see must not stay
 * silent. A permission request waits in its own state with an inbox item, and a question of an AI
 * member goes to the inbox without a wait at all, so nothing but this alert explains `waiting_input`:
 * an open question of the session does not either. The integrator gets one todo for the wait (PM-1250), pointing
 * at the session. Nothing else happens: the session is not touched.
 */
export class InputStallAlerts {
  private readonly ctx: DomainContext;
  private readonly inbox: InboxService;

  constructor(deps: { ctx: DomainContext; inbox: InboxService }) {
    this.ctx = deps.ctx;
    this.inbox = deps.inbox;
  }

  /**
   * The wait of `sessionId` that began at `since` (ISO time) has lasted `minutes`: the todo item,
   * or null when the session no longer waits, or an open todo of this kind for its card says so already.
   */
  raise(sessionId: string, since: string, minutes: number): InboxItem | null {
    const session = this.ctx.repos.sessions.get(sessionId);
    if (session?.state !== 'waiting_input') return null;
    const payload: SessionInputAlert = {
      alert: 'session_input',
      workItem: session.workItem,
      since,
      minutes,
      activity: session.activity,
    };
    // One todo for the card (`raiseAlert`): a question (ask_human) never explains a wait at the terminal, and one
    // that is still open is what a stray hook hides behind (PM-192).
    const item = this.inbox.raiseAlert({
      projectKey: session.projectKey,
      source: session.member,
      sessionId: session.id,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      title: `Session of ${session.member} waits for input without a question, for ${minutes} minutes`,
      payload,
    });
    if (!item) return null;
    void this.ctx.events.emit('session_input_stalled', {
      projectKey: session.projectKey,
      sessionId,
      inboxItemId: item.id,
    });
    return item;
  }

  /** The session no longer waits for input: the integrator's todo about the wait is moot and closes. */
  settle(session: Session): void {
    this.inbox.settleAlert(session.projectKey, 'session_input', {
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      sessionId: session.id,
    });
  }
}
