import { canSeeCommentHistory, withoutRevisions } from './comments';
import type { TimelineEvent } from './event';
import { canSeeAllTeamMessages, canSeeTeamMessage } from './message';
import type { TaskViewer } from './task';

/**
 * What a viewer sees of a timeline event. The pure rule below is shared by the server's
 * read paths (REST, websocket, MCP), the history search (PM-786) and the web's test fake.
 */
type TimelineViewer = TaskViewer & { via?: 'integrator' };

/** Only clients lose private message events; other roles keep the existing machine history. */
export function canSeeTimelineEvent(
  viewer: TimelineViewer,
  event: TimelineEvent,
  participants: (id: string) => { from: string; to: string[] } | null,
): boolean {
  if (viewer.access !== 'client' || !['team_message', 'message_dropped'].includes(event.type)) return true;
  const id = event.data?.messageId;
  const message = typeof id === 'string' ? participants(id) : null;
  return !!message && canSeeTeamMessage(viewer, message);
}

export function visibleTimelineEvent(
  viewer: TimelineViewer,
  event: TimelineEvent,
  messageParticipants: (id: string) => { from: string; to: string[] } | null,
): TimelineEvent {
  if (event.type === 'task_note') {
    if (event.data?.revisions === undefined) return event;
    return canSeeCommentHistory(viewer, event) ? event : withoutRevisions(event);
  }
  // The edit's text is the earlier text's twin: readers get it through the projected comment only (PM-1277).
  if (event.type === 'task_note_edited') return { ...event, data: { noteId: event.data?.noteId } };
  if (event.type !== 'session_started') return event;
  if (canSeeAllTeamMessages(viewer)) return event;
  const cause = event.data?.cause as { messageId?: string; quote?: string } | undefined;
  if (!cause?.quote || !cause.messageId) return event;
  const message = messageParticipants(cause.messageId);
  if (message && canSeeTeamMessage(viewer, message)) return event;
  const { quote: _quote, ...visible } = cause;
  return { ...event, data: { ...event.data, cause: visible } };
}
