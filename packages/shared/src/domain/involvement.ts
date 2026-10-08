import { z } from 'zod';
import { Actor } from './event';
import { TaskKey } from './task';
import { LabelId } from './label';

export const SessionStartCauseKind = z.enum([
  'start_button',
  'label_wait',
  'hand_over',
  'sent_back',
  'refinement',
  'schedule',
  'message',
  'mention',
  'answer',
  'conversation',
  'fix_limit',
  'loop',
  'permission_change',
  'description_changed',
  'provider_resume',
  'pause_resume',
  /** The card changed assignee (PM-342): the old session is asked for its note, or the new one takes over. */
  'handoff',
]);
export const SessionStartCause = z.object({
  kind: SessionStartCauseKind,
  by: Actor.optional(),
  eventId: z.string().optional(),
  messageId: z.string().optional(),
  inboxItemId: z.string().optional(),
  quote: z.string().max(80).optional(),
  labels: z.array(LabelId).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  runId: z.string().optional(),
  rounds: z.number().int().optional(),
  limit: z.number().int().optional(),
  loopId: z.string().optional(),
});
export type SessionStartCause = z.infer<typeof SessionStartCause>;

export const MessageOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('note'), eventId: z.string() }),
  z.object({ kind: z.literal('label'), labels: z.array(LabelId).min(1), eventId: z.string().optional() }),
  z.object({ kind: z.literal('answer'), inboxItemId: z.string() }),
]);
export type MessageOrigin = z.infer<typeof MessageOrigin>;

export const QUOTE_MAX = 60;
/** The first sentence of the first nonempty line, truncated at a word boundary. */
export function quoteOf(text: string, max = QUOTE_MAX): string {
  const line = (text.split(/\r?\n/).find((part) => part.trim()) ?? '')
    .trim()
    .replace(/^[#>\-*`\s]+/, '')
    .replace(/\s+/g, ' ');
  const sentence = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, Math.max(0, max - 1));
  const boundary = cut.lastIndexOf(' ');
  return (sentence[cut.length] === ' ' ? cut : boundary > 0 ? cut.slice(0, boundary) : cut) + '…';
}

/**
 * Why a session stopped. The kinds of PM-274 (involvement) and PM-288 (closing) share one schema, so
 * the timeline event and the session carry the same reason.
 */
export const SessionStopKind = z.enum([
  // PM-274
  'manual',
  'assignee_change',
  'task_cancelled',
  'member_retired',
  'member_on_leave',
  'loop_stopped',
  'fix_limit_reassign',
  'restart',
  'sent_back',
  'card_done',
  'workspace',
  'exited',
  'failed',
  'login_lost',
  'server_restart',
  // PM-288
  /** The member's step on the card is done. */
  'step_done',
  /** `SESSION_IDLE_CLOSE_MINUTES` of silence. */
  'idle',
  /** The process stopped under a pause (PM-219), also in the pause before it ended. */
  'pause',
  // PM-342
  /** The member wrote their handoff note (or the transcript summary stands in) and the session closed. */
  'handed_off',
  /** The member did not write a handoff note in time. */
  'handoff_timeout',
]);
export type SessionStopKind = z.infer<typeof SessionStopKind>;

export const SessionStop = z.object({
  kind: SessionStopKind,
  /** Who stopped it; absent: the system. */
  by: Actor.optional(),
  /** PM-274: manual and assignee_change. */
  note: z.string().trim().min(1).max(200).optional(),
  /** PM-274: restart. */
  restartFor: z.enum(['permission', 'description', 'new_round']).optional(),
  /** step_done, sent_back, card_done, task_cancelled. */
  taskKey: TaskKey.optional(),
  /** step_done: the stage the card moved to (none for a refinement step); sent_back: where it went back to. */
  stageId: z.string().optional(),
  /** idle: the whole minutes of silence at the close. */
  idleMinutes: z.number().int().positive().optional(),
});
export type SessionStop = z.infer<typeof SessionStop>;
