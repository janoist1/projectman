import type { TimelineEvent } from './event';
import { canSeeAllTeamMessages, canSeeTeamMessage } from './message';
import type { TaskViewer } from './task';

/**
 * What a viewer sees of a timeline event. The two pure rules below are shared by the server's
 * read paths (REST, websocket, MCP), the history search (PM-786) and the web's test fake.
 */
type TimelineViewer = TaskViewer & { via?: 'integrator' };

const isClientViewer = (viewer: Pick<TaskViewer, 'access'>) => viewer.access === 'client';

export function visibleTimelineEvent(
  viewer: TimelineViewer,
  event: TimelineEvent,
  messageParticipants: (id: string) => { from: string; to: string[] } | null,
): TimelineEvent {
  // Why a card was pulled into a stage (PM-427) is the team's: a client sees the move, not the reason.
  // The subtasks a collecting card closed with (PM-647) are internal cards' keys.
  if (
    event.type === 'task_stage_changed' &&
    isClientViewer(viewer) &&
    event.data &&
    ('pulled' in event.data || 'partsClosed' in event.data)
  ) {
    const { pulled: _pulled, partsClosed: _partsClosed, ...visible } = event.data;
    return { ...event, data: visible };
  }
  if (event.type !== 'session_started') return event;
  if (canSeeAllTeamMessages(viewer)) return event;
  const cause = event.data?.cause as { messageId?: string; quote?: string } | undefined;
  if (!cause?.quote || !cause.messageId) return event;
  const message = messageParticipants(cause.messageId);
  if (message && canSeeTeamMessage(viewer, message)) return event;
  const { quote: _quote, ...visible } = cause;
  return { ...event, data: { ...event.data, cause: visible } };
}

const CLIENT_TASK_TIMELINE = new Set<TimelineEvent['type']>([
  'task_created',
  'task_stage_changed',
  'task_check_changed',
  'attachment_added',
  'attachment_deleted',
]);

/** The main milestones of a task, the part of its timeline a client sees in the task detail. */
export function clientCanSeeTimelineEvent(event: TimelineEvent): boolean {
  return CLIENT_TASK_TIMELINE.has(event.type);
}
