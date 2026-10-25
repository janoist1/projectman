import type { TimelineEvent } from './event';
import { canSeeAllTeamMessages, canSeeTeamMessage } from './message';
import type { TaskViewer } from './task';

/**
 * What a viewer sees of a timeline event. The pure rule below is shared by the server's
 * read paths (REST, websocket, MCP), the history search (PM-786) and the web's test fake.
 */
type TimelineViewer = TaskViewer & { via?: 'integrator' };

export function visibleTimelineEvent(
  viewer: TimelineViewer,
  event: TimelineEvent,
  messageParticipants: (id: string) => { from: string; to: string[] } | null,
): TimelineEvent {
  if (event.type !== 'session_started') return event;
  if (canSeeAllTeamMessages(viewer)) return event;
  const cause = event.data?.cause as { messageId?: string; quote?: string } | undefined;
  if (!cause?.quote || !cause.messageId) return event;
  const message = messageParticipants(cause.messageId);
  if (message && canSeeTeamMessage(viewer, message)) return event;
  const { quote: _quote, ...visible } = cause;
  return { ...event, data: { ...event.data, cause: visible } };
}
