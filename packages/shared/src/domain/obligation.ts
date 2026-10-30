import { z } from 'zod';
import type { ErrorCode } from '../api/error-codes';
import type { TeamLimits } from '../config/schema';
import { MemberHandle } from './member';
import { TaskKey } from './task';

/**
 * An obligation (PM-806): an open step that an AI member has to carry out. It has a responsible and a
 * deadline of N minutes. At the first deadline the responsible gets one reminder; at the second one the
 * project manager is told (PM-1152); at the third the step becomes an integrator todo or goes to the
 * owner. The system never does the step, decides, or sets a label itself.
 */
export const ObligationKind = z.enum([
  'merge',
  'fix_limit',
  'refinement_turn',
  'review_step',
  'work',
  /** The offer to start a ready card (PM-804): its responsible is asked to move it to development. */
  'start',
  /** A scored card that waits for a developer whose limit reaches its points (PM-348, PM-1150): nobody holds the step. */
  'senior_wait',
]);
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
  /** Null: nobody holds the step, the system waits for it (`senior_wait`). */
  responsible: MemberHandle.nullable(),
  /** What opened it (the merge id, `<stage>@<time>`, ...): with the card, kind and responsible it is unique. */
  subject: z.string().max(200),
  openedAt: IsoDateTime,
  dueAt: IsoDateTime,
  pausedSince: IsoDateTime.nullable(),
  pauseReason: ObligationPauseReason.nullable(),
  wokenAt: IsoDateTime.nullable(),
  /** When the project manager was told (PM-1152): the `tell_pm` rung. */
  pmToldAt: IsoDateTime.nullable(),
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
  responsible: MemberHandle.nullable(),
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
  | { kind: 'tell_pm'; dueAt: string }
  | { kind: 'hand_over' };

const plusMinutes = (at: string, minutes: number): string =>
  new Date(Date.parse(at) + minutes * 60_000).toISOString();

/**
 * The rungs of the ladder a kind climbs (PM-1152): the responsible's reminder, a word to the project
 * manager, then the hand-over to a person.
 */
export const ObligationRung = z.enum(['wake', 'tell_pm', 'hand_over']);
export type ObligationRung = z.infer<typeof ObligationRung>;

export const OBLIGATION_RUNGS: readonly ObligationRung[] = ['wake', 'tell_pm', 'hand_over'];

/**
 * The ladder of one row: the source's rungs without those that cannot be climbed. `wake` falls out
 * when nobody is responsible, `tell_pm` when there is no project manager to tell or the project manager
 * is the responsible (they were just reminded).
 */
export function obligationRungsOf(
  rungs: readonly ObligationRung[],
  who: { responsible: string | null; projectManager: string | null },
): ObligationRung[] {
  return rungs.filter((rung) =>
    rung === 'wake'
      ? who.responsible !== null
      : rung === 'tell_pm'
        ? who.projectManager !== null && who.projectManager !== who.responsible
        : true,
  );
}

const rungDone = (row: Obligation, rung: ObligationRung): boolean =>
  rung === 'wake' ? row.wokenAt !== null : rung === 'tell_pm' ? row.pmToldAt !== null : false;

const nextRungOf = (row: Obligation, rungs: readonly ObligationRung[]): ObligationRung =>
  rungs.find((rung) => !rungDone(row, rung)) ?? 'hand_over';

/**
 * The minutes before the next due rung. A missing project manager rung must not shorten the time before
 * a person: when the hand-over follows the reminder directly, the gap is 2N (so the hand-over comes at 3N
 * as on a full ladder); every other gap is N.
 */
function gapMinutesOf(row: Obligation, rungs: readonly ObligationRung[], minutes: number): number {
  return nextRungOf(row, rungs) === 'hand_over' &&
    rungs.includes('wake') &&
    !rungs.includes('tell_pm') &&
    row.pmToldAt === null
    ? 2 * minutes
    : minutes;
}

/**
 * The next step of an obligation (PM-806, PM-1152). The order is the rule:
 * 1. only an open row moves; 2. a pause starts once; 3. when it ends the clock restarts for one gap;
 * 4. before the deadline nothing happens; 5. recent activity of the responsible moves the deadline to
 * activity + gap; 6. a responsible at work gets one more gap; 7. a hand-over that follows the reminder
 * directly is never earlier than the reminder + 2N; 8. the expiry climbs to the first rung not done
 * yet: the reminder, the word to the project manager, the hand-over to a person. `rungs` is the row's
 * ladder (`obligationRungsOf`); the gap is N, or 2N before a hand-over when the project manager rung is missing.
 */
export function planObligation(
  row: Obligation,
  facts: ObligationFacts,
  now: string,
  minutes: number,
  rungs: readonly ObligationRung[] = OBLIGATION_RUNGS,
): ObligationStep {
  if (row.state !== 'open') return { kind: 'none' };
  if (facts.paused) {
    return row.pausedSince === null ? { kind: 'pause', reason: facts.paused } : { kind: 'none' };
  }
  const gap = gapMinutesOf(row, rungs, minutes);
  if (row.pausedSince !== null) return { kind: 'resume', dueAt: plusMinutes(now, gap) };
  const nowMs = Date.parse(now);
  if (nowMs < Date.parse(row.dueAt)) return { kind: 'none' };
  if (facts.lastActivityAt) {
    const activityDue = Date.parse(facts.lastActivityAt) + gap * 60_000;
    if (activityDue > nowMs) return { kind: 'extend', dueAt: new Date(activityDue).toISOString() };
  }
  if (facts.active) return { kind: 'extend', dueAt: plusMinutes(now, gap) };
  const next = nextRungOf(row, rungs);
  if (next === 'hand_over') {
    // The project manager rung fell out between the reminder and now: the person still waits 2N after it.
    const afterReminder = row.wokenAt !== null ? Date.parse(row.wokenAt) + gap * 60_000 : 0;
    if (afterReminder > nowMs && gap !== minutes)
      return { kind: 'extend', dueAt: new Date(afterReminder).toISOString() };
    return { kind: 'hand_over' };
  }
  const after: Obligation = next === 'wake' ? { ...row, wokenAt: now } : { ...row, pmToldAt: now };
  return { kind: next, dueAt: plusMinutes(now, gapMinutesOf(after, rungs, minutes)) };
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
] satisfies readonly ErrorCode[];

export const DEFAULT_OBLIGATION_MINUTES = 20;

/** Minutes an obligation waits before each of its rungs (the reminder, the project manager, the hand-over). */
export function obligationMinutesOf(limits: Pick<TeamLimits, 'obligationMinutes'>): number {
  return limits.obligationMinutes ?? DEFAULT_OBLIGATION_MINUTES;
}
