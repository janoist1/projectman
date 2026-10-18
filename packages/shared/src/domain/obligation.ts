import { z } from 'zod';
import type { TeamLimits } from '../config/schema';
import { MemberHandle } from './member';
import { TaskKey } from './task';

/**
 * An obligation (PM-806): an open step that an AI member has to carry out. It has a responsible and a
 * deadline of N minutes. At the first deadline the responsible gets one reminder; at the second one the
 * step becomes an integrator todo. The system never does the step, decides, or sets a label itself.
 */
export const ObligationKind = z.enum(['merge', 'fix_limit', 'refinement_turn', 'review_step', 'work']);
export type ObligationKind = z.infer<typeof ObligationKind>;

/** `handed_over`: the integrator todo is open; the row can still close, but never reminds again. */
export const ObligationState = z.enum(['open', 'handed_over', 'fulfilled', 'cancelled']);
export type ObligationState = z.infer<typeof ObligationState>;

/** Why the deadline clock stands still: a missed step is not counted while something else holds it. */
export const ObligationPauseReason = z.enum([
  /** A holding label (for example waiting-answer) or a blocked status. */
  'held',
  /** An open human item (question, permission, decision) on the card. */
  'inbox',
  /** The responsible's session on the card waits for a permission or an input. */
  'permission',
  /** Starting the responsible would be refused with a pausing refusal (`PAUSING_REFUSALS`). */
  'start_refused',
]);
export type ObligationPauseReason = z.infer<typeof ObligationPauseReason>;

const ProjectKey = z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/);
const IsoDateTime = z.iso.datetime();

export const Obligation = z.object({
  /** `obl_` and a nanoid. */
  id: z.string(),
  projectKey: ProjectKey,
  taskKey: TaskKey,
  kind: ObligationKind,
  responsible: MemberHandle,
  /** What opened it (the merge id, `<stage>@<time>`, ...): with the card, kind and responsible it is unique. */
  subject: z.string().max(200),
  openedAt: IsoDateTime,
  dueAt: IsoDateTime,
  pausedSince: IsoDateTime.nullable(),
  pauseReason: ObligationPauseReason.nullable(),
  wokenAt: IsoDateTime.nullable(),
  handedOverAt: IsoDateTime.nullable(),
  /** The integrator todo. */
  inboxItemId: z.string().nullable(),
  state: ObligationState,
  closedAt: IsoDateTime.nullable(),
});
export type Obligation = z.infer<typeof Obligation>;

/** The reference the integrator todo carries (`QuestionPayload.obligation`). */
export const ObligationRef = z.object({
  id: z.string(),
  kind: ObligationKind,
  responsible: MemberHandle,
  openedAt: IsoDateTime,
});
export type ObligationRef = z.infer<typeof ObligationRef>;

/** What the sweep reads about the card and the responsible; `planObligation` decides from it. */
export interface ObligationFacts {
  paused: ObligationPauseReason | null;
  /** The responsible has a session on the card in starting or working state, or the system works the step (merge queued/running). */
  active: boolean;
  /** The responsible's last timeline event or session activity on the card. */
  lastActivityAt: string | null;
}

export type ObligationStep =
  | { kind: 'none' }
  | { kind: 'pause'; reason: ObligationPauseReason }
  | { kind: 'resume'; dueAt: string }
  | { kind: 'extend'; dueAt: string }
  | { kind: 'wake'; dueAt: string }
  | { kind: 'hand_over' };

const plusMinutes = (at: string, minutes: number): string =>
  new Date(Date.parse(at) + minutes * 60_000).toISOString();

/**
 * The next step of an obligation (PM-806). The order is the rule:
 * 1. only an open row moves; 2. a pause starts once; 3. when it ends the clock restarts for N minutes;
 * 4. before the deadline nothing happens; 5. recent activity of the responsible moves the deadline to
 * activity + N; 6. a responsible at work gets N more minutes; 7. the first expiry is the one reminder;
 * 8. the second expiry hands the step to the integrator.
 */
export function planObligation(
  row: Obligation,
  facts: ObligationFacts,
  now: string,
  minutes: number,
): ObligationStep {
  if (row.state !== 'open') return { kind: 'none' };
  if (facts.paused) {
    return row.pausedSince === null ? { kind: 'pause', reason: facts.paused } : { kind: 'none' };
  }
  if (row.pausedSince !== null) return { kind: 'resume', dueAt: plusMinutes(now, minutes) };
  const nowMs = Date.parse(now);
  if (nowMs < Date.parse(row.dueAt)) return { kind: 'none' };
  if (facts.lastActivityAt) {
    const activityDue = Date.parse(facts.lastActivityAt) + minutes * 60_000;
    if (activityDue > nowMs) return { kind: 'extend', dueAt: new Date(activityDue).toISOString() };
  }
  if (facts.active) return { kind: 'extend', dueAt: plusMinutes(now, minutes) };
  if (row.wokenAt === null) return { kind: 'wake', dueAt: plusMinutes(now, minutes) };
  return { kind: 'hand_over' };
}

/**
 * The admission refusals under which the responsible cannot be started, so a missed step is no fault of
 * theirs and the clock stands still. `workspace_busy`, `member_at_capacity` and the other workspace
 * refusals do not pause: the responsible can clear them by finishing other work.
 */
export const PAUSING_REFUSALS: readonly string[] = [
  'ai_disabled',
  'team_paused',
  'plan_usage_paused',
  'provider_rate_limited',
  'ai_limit_reached',
  'disk_low',
  'engine_offline',
  'member_on_leave',
];

export const DEFAULT_OBLIGATION_MINUTES = 30;

/** Minutes an obligation waits before each of its two deadlines. */
export function obligationMinutesOf(limits: Pick<TeamLimits, 'obligationMinutes'>): number {
  return limits.obligationMinutes ?? DEFAULT_OBLIGATION_MINUTES;
}
