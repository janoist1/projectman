import { z } from 'zod';
import { EngineId } from './engine';
import { MemberHandle } from './member';

/** Why an otherwise ready card intentionally stays in its queue (PM-795). */
const ReadyHoldReason = z.enum([
  'ai_disabled',
  'team_paused',
  'ai_limit_reached',
  'engine_offline',
  'no_free_member',
  'senior_busy',
]);
type ReadyHoldReason = z.infer<typeof ReadyHoldReason>;

export const TaskReadyHold = z.object({
  reason: ReadyHoldReason,
  /** The Seniors this card waits for. */
  seniors: z.array(MemberHandle).optional(),
  /** The missing engine, when exactly one is known. */
  engine: EngineId.optional(),
  /** ISO time when the same reason first held. */
  since: z.string(),
});
export type TaskReadyHold = z.infer<typeof TaskReadyHold>;
