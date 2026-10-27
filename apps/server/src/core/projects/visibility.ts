import {
  canSeeAllTeamMessages,
  canSeeInboxItem,
  canSeeOperatorSessions,
  canSeeTeamMessage,
  isCoordinatorOnlySignal,
  visibleQuestionItem,
  visibleTimelineEvent,
} from '@projectman/shared';
import type { ServerEvent, Session, TaskDetail } from '@projectman/shared';
import type { ProjectAccess } from '../members';

/**
 * What a member sees of their project. Every project member, a client included, reads the whole
 * project (PM-79); the REST routes and the websocket both decide here.
 *
 * Team messages are the exception (PM-78): an owner and an admin see every message, every other
 * member (a developer, a read-only member and a client too) only what they sent or got. So are the
 * Operator's sessions (PM-475): the owner and the admin see them.
 */
export type Viewer = Pick<ProjectAccess, 'access' | 'handle' | 'via'>;

/** The timeline rule lives in `packages/shared` (the history search uses it too, PM-786). */
export { visibleTimelineEvent };

export function visibleSession(
  viewer: Viewer,
  session: Session,
  messageParticipants: (id: string) => { from: string; to: string[] } | null,
): Session {
  if (canSeeAllTeamMessages(viewer)) return session;
  const cause = session.startCause;
  if (!cause?.messageId || !cause.quote) return session;
  const message = messageParticipants(cause.messageId);
  if (message && canSeeTeamMessage(viewer, message)) return session;
  const { quote: _quote, ...visible } = cause;
  return { ...session, startCause: visible };
}

/** Events of a subscribed project (everything but the connection and terminal events). */
export type ProjectEvent = Exclude<
  ServerEvent,
  {
    type:
      'hello' | 'error' | 'terminal_data' | 'terminal_snapshot' | 'engine_changed' | 'operator_grant_changed';
  }
>;

/** Inbox privacy is shared by REST, websocket delivery and the web fake. */
export { canSeeInboxItem };

/** Team messages: an owner and an admin see all of them, everyone else only their own (the rule lives in `packages/shared`). */

/**
 * The member a message listing is narrowed to (sent or received) whatever else it filters by:
 * the viewer for everyone but an owner and an admin, who may see every message.
 */
export function teamMessageParticipant(viewer: Viewer): string | undefined {
  return canSeeAllTeamMessages(viewer) ? undefined : viewer.handle;
}

/**
 * What the viewer may see of a task detail: the quote of a team message that started a session
 * is cut when the viewer is not a party to it.
 */
export function visibleTaskDetail(
  viewer: Viewer,
  detail: TaskDetail,
  messageParticipants: (id: string) => { from: string; to: string[] } | null = () => null,
): TaskDetail {
  const timeline = detail.timeline.map((event) => visibleTimelineEvent(viewer, event, messageParticipants));
  const sessions = detail.sessions.map((session) => visibleSession(viewer, session, messageParticipants));
  if (
    timeline.some((event, index) => event !== detail.timeline[index]) ||
    sessions.some((session, index) => session !== detail.sessions[index])
  )
    return { ...detail, timeline, sessions };
  return detail;
}

/** The event as the viewer sees it, once `canSeeProjectEvent` let it through. */
export function visibleProjectEvent(
  viewer: Viewer,
  event: ProjectEvent,
  messageParticipants: (id: string) => { from: string; to: string[] } | null = () => null,
): ProjectEvent {
  if (event.type === 'inbox_upserted')
    return { ...event, item: visibleQuestionItem(viewer, event.item, () => true) };
  if (event.type === 'timeline_appended')
    return { ...event, event: visibleTimelineEvent(viewer, event.event, messageParticipants) };
  if (event.type === 'session_upserted')
    return { ...event, session: visibleSession(viewer, event.session, messageParticipants) };
  return event;
}

/** Whether a live event of the viewer's project reaches them (websocket). */
export function canSeeProjectEvent(
  viewer: Viewer,
  event: ProjectEvent,
  isRestrictedSession?: (sessionId: string) => boolean,
): boolean {
  // A team message reaches only those it concerns (and an owner and an admin), whatever their access.
  if (event.type === 'project_checklist_changed')
    return viewer.access === 'owner' || viewer.access === 'admin';
  if (event.type === 'operator_signal')
    return viewer.access === 'owner' && !isCoordinatorOnlySignal(event.signal.kind);
  if (event.type === 'inbox_upserted') return canSeeInboxItem(viewer, event.item);
  if (event.type === 'team_message' || event.type === 'team_message_updated')
    return canSeeTeamMessage(viewer, event.message);
  // The Operator's sessions and the PM's conversations with others are the owner's and the admin's to see
  // (PM-475, PM-1080).
  if (!canSeeOperatorSessions(viewer) && isRestrictedSession) {
    if (event.type === 'session_upserted' && isRestrictedSession(event.session.id)) return false;
    if (event.type === 'chat_appended' && isRestrictedSession(event.sessionId)) return false;
  }
  return true;
}
