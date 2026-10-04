import { z } from 'zod';
import { Actor } from './event';
import { TaskKey } from './task';

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
