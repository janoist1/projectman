import { isCardComment, messageTextWithAttachments, stageOf } from '@projectman/shared';
import type {
  ProjectConfig,
  QuestionCloseRule,
  SessionStartCause,
  TeamMessage,
  TimelineEvent,
} from '@projectman/shared';

/**
 * The line before the text of a mention notice whose origin is a comment on the card (PM-1290): it says
 * what the text is, its event id, where the answer goes and who reads it. A mention in a note that is
 * not a comment (an AI's process note) gets no such line.
 */
function commentMentionFrame(taskKey: string | null, eventId: string): string {
  const card = taskKey ? ` on ${taskKey}` : ' on a card';
  return (
    `[Comment${card}, event_id: ${eventId}. To answer it, call update_task with note and reply_to "${eventId}": ` +
    'the reply lands in the comment thread, which every reader of the card sees, a client too. ' +
    'Do not send a separate acknowledgement.]'
  );
}

/**
 * The comment frame of a message, or null: only the mention notice of a comment of the card has one.
 * `findEvent` reads the timeline event the message names as its origin.
 */
export function commentFrameOf(
  message: Pick<TeamMessage, 'origin' | 'taskKey'>,
  findEvent: (eventId: string) => Pick<TimelineEvent, 'type' | 'data' | 'actor'> | null,
): string | null {
  const eventId = message.origin?.kind === 'note' ? message.origin.eventId : null;
  const event = eventId ? findEvent(eventId) : null;
  return eventId && event && isCardComment(event) ? commentMentionFrame(message.taskKey, eventId) : null;
}

/** What a recipient reads of a message: its text and files, with the comment frame above them when it has one. */
export function messageTextWithCommentFrame(
  message: Pick<TeamMessage, 'body' | 'attachments' | 'from' | 'email' | 'origin' | 'taskKey'>,
  findEvent: (eventId: string) => Pick<TimelineEvent, 'type' | 'data' | 'actor'> | null,
): string {
  const text = messageTextWithAttachments(message);
  const frame = commentFrameOf(message, findEvent);
  return frame ? `${frame}\n${text}` : text;
}

/** How much of a question and of its answer the notice to the card's other workers carries. */
export const QUESTION_NOTICE_LIMIT = 200;
export const ANSWER_NOTICE_LIMIT = 500;

/** How the asking member gets its question to a person after all, once the project manager handled it (PM-558). */
export function reaskHint(inboxItemId: string): string {
  return (
    `If that does not settle it, ask a person: call ask_human again with reask_of "${inboxItemId}" and ` +
    'reask_reason (why it is not settled); that question goes straight to a person, without screening.'
  );
}

/** Why a question was closed without an answer, as the asking member's notice says it (PM-556). */
export const QUESTION_CLOSE_REASONS: Record<QuestionCloseRule, string> = {
  task_done: 'the card it was about is done',
  task_cancelled: 'the card it was about was cancelled',
  handed_off: 'the card it was about was handed to someone else',
  assignee_changed: 'the card it was about has a new assignee',
  withdrawn: 'it was withdrawn',
  group_withdrawn: 'every asker withdrew the shared question',
  operator_moot: 'the project manager found it moot: nothing is left to answer',
  obligation_closed: 'the step it handed over was done or dropped meanwhile',
  signal_resolved: 'the signal it was asked about ended by itself: nothing is left to answer',
};

/** Why a team message was dropped before it reached its recipient, as the sender's notice says it (PM-1248). */
export const MESSAGE_DROP_REASONS: Record<'place_closed' | 'member_removed', string> = {
  place_closed: 'the card it was about closed before the message could reach them',
  member_removed: 'they are no longer a member of the team',
};

/** The notice to the AI sender of a team message that could not be delivered; it wakes nobody. */
export function messageDroppedNotice(args: {
  recipient: string;
  taskKey: string | null;
  reason: keyof typeof MESSAGE_DROP_REASONS;
  quote: string;
}): string {
  const card = args.taskKey ? ` about ${args.taskKey}` : '';
  return (
    `Your message to \`${args.recipient}\`${card} was not delivered: ${MESSAGE_DROP_REASONS[args.reason]}. ` +
    `It started with: ${args.quote}`
  );
}

/** Why a session joined a card, as the joined notice says it (empty when nothing is known). */
export function startReason(config: ProjectConfig, cause: SessionStartCause | null): string {
  if (!cause) return '';
  const sender = cause.by ? `\`${cause.by.handle}\`${cause.by.via ? ' via the integrator' : ''}` : null;
  switch (cause.kind) {
    case 'message':
      return ` (woken by a team message${sender ? ` from ${sender}` : ''})`;
    case 'mention':
    case 'answer':
      return ` (woken by ${cause.kind}${sender ? ` from ${sender}` : ''}${cause.quote ? `: ${cause.quote}` : ''})`;
    case 'hand_over':
      return ` (the card entered ${stageOf(config, cause.to ?? '')?.name ?? cause.to}${sender ? `, moved by ${sender}` : ''})`;
    case 'refinement':
      return ` (its refinement step for label ${cause.labels?.join(', ')})`;
    case 'start_button':
      return sender ? ` (started by ${sender})` : ' (started with the Start button)';
    default:
      return ` (${cause.kind})`;
  }
}
