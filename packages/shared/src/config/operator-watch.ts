import { z } from 'zod';
import type { OperatorSignalKind } from '../api/dto';
import type { ProjectConfig } from './schema';
import { teamSettingOf } from './team-settings';

export const OPERATOR_WATCH_LEVELS = ['report', 'unblock', 'drive'] as const;
export const OperatorWatch = z.enum(OPERATOR_WATCH_LEVELS);
export type OperatorWatch = z.infer<typeof OperatorWatch>;

const COORDINATOR_ONLY_SIGNAL_KINDS: readonly OperatorSignalKind[] = [
  'structural_pattern',
  'milestone_closed',
];
export function isCoordinatorOnlySignal(kind: OperatorSignalKind): boolean {
  return COORDINATOR_ONLY_SIGNAL_KINDS.includes(kind);
}

/** The signal kinds the coordinator may close as needing nothing instead of presenting them. */
export const OPERATOR_DISMISSIBLE_SIGNAL_KINDS: readonly OperatorSignalKind[] = [
  'obligation_overdue',
  ...COORDINATOR_ONLY_SIGNAL_KINDS,
];

/** How much the coordinator does on its own on a system signal (PM-545); absent means report. */
export function operatorWatchOf(config: Pick<ProjectConfig, 'team'>): OperatorWatch {
  return teamSettingOf(config, 'operatorWatch');
}

/** How many own steps the coordinator may take on one signal at each level. */
export const OPERATOR_SIGNAL_STEPS: Record<OperatorWatch, number> = { report: 0, unblock: 1, drive: 3 };
/** The least time between two own steps on one signal. */
export const OPERATOR_SIGNAL_STEP_GAP_MINUTES = 30;
/**
 * The signal kinds the coordinator may act on without an owner's request, per level.
 */
export const OPERATOR_SIGNAL_STEP_KINDS: Record<OperatorWatch, readonly OperatorSignalKind[]> = {
  report: [],
  unblock: ['obligation_overdue', 'merge_blocked', 'answer_stalled', 'start_blocked'],
  drive: ['obligation_overdue', 'merge_blocked', 'answer_stalled', 'start_blocked'],
};
/**
 * The signal kinds whose one step the owner has granted at every level, `report` too (PM-1201): an `unreleased`
 * signal lets the coordinator start the deployment duty's member, who asks the owner for the release. The step
 * only starts one question; nothing live changes before the owner's yes.
 */
const OPERATOR_OWNER_GRANTED_STEP_KINDS: readonly OperatorSignalKind[] = ['unreleased'];
/** The least time between two steps on one granted signal; such a signal has no limit on their number. */
export const OPERATOR_UNRELEASED_STEP_GAP_HOURS = 24;

/** Whether the kind is stepped on at this level: by the owner's grant, or by the level's own list. */
export function operatorSignalStepAllowed(level: OperatorWatch, kind: OperatorSignalKind): boolean {
  return OPERATOR_OWNER_GRANTED_STEP_KINDS.includes(kind) || OPERATOR_SIGNAL_STEP_KINDS[level].includes(kind);
}

/** The least time between two own steps on a signal of this kind, in milliseconds. */
export function operatorSignalStepGapMs(kind: OperatorSignalKind): number {
  return OPERATOR_OWNER_GRANTED_STEP_KINDS.includes(kind)
    ? OPERATOR_UNRELEASED_STEP_GAP_HOURS * 3_600_000
    : OPERATOR_SIGNAL_STEP_GAP_MINUTES * 60_000;
}
/**
 * The signal kinds whose wake-ups go on the project's fast line (PM-694): at most one wake-up per
 * `OPERATOR_ANSWER_STALL_WAKE_MS`, apart from the general `OPERATOR_SIGNAL_WAKE_INTERVAL_MS` limit.
 */
export const OPERATOR_FAST_SIGNAL_KINDS: readonly OperatorSignalKind[] = ['answer_stalled'];
/** The least time between two own steps on cards of one member after an `answer_stalled` step. */
export const OPERATOR_ANSWER_STALL_MUTE_MINUTES = OPERATOR_SIGNAL_STEP_GAP_MINUTES;
/** The `from` of the request row that carries the coordinator's own steps on signals; never a valid handle. */
export const OPERATOR_SIGNAL_ROUND_FROM = '@signals';

/** What a signal lets the coordinator start: `startTask` is the card `start_task` may start; `members` are for `start_member`. */
export type OperatorSignalStepTargets = {
  startTask: string | null;
  members: string[];
  taskKey: string | null;
};

export type OperatorSignalStepRefusal =
  | { code: 'operator_no_request'; reason: 'level' | 'kind' | 'tool' | 'target' }
  | { code: 'operator_signal_budget'; reason: 'used' | 'too_soon'; retryAt: string | null };

/** What is left of a signal's own steps: how many, and when the next one may be taken (null: now, or none left). */
export function operatorSignalBudget(
  level: OperatorWatch,
  stepsAt: readonly string[],
  now: string,
  kind?: OperatorSignalKind,
): { left: number; nextAt: string | null } {
  // A granted signal has no limit on the number of its steps: one is always left, once its gap has passed.
  const granted = kind !== undefined && OPERATOR_OWNER_GRANTED_STEP_KINDS.includes(kind);
  const left = granted ? 1 : Math.max(0, OPERATOR_SIGNAL_STEPS[level] - stepsAt.length);
  const last = stepsAt.reduce<number | null>((max, at) => {
    const time = Date.parse(at);
    return max === null || time > max ? time : max;
  }, null);
  const next =
    last === null
      ? null
      : last + (kind ? operatorSignalStepGapMs(kind) : OPERATOR_SIGNAL_STEP_GAP_MINUTES * 60_000);
  return {
    left,
    nextAt: left > 0 && next !== null && Date.parse(now) < next ? new Date(next).toISOString() : null,
  };
}

/**
 * Why the coordinator may not take this step on a signal without an owner's request, or null when it may.
 * It decides in this order: the level, the signal kind, the tool, the target, then the budget. A kind the owner
 * granted (`OPERATOR_OWNER_GRANTED_STEP_KINDS`) passes the level check and has a gap but no count limit.
 */
export function operatorSignalStepRefusal(input: {
  level: OperatorWatch;
  kind: OperatorSignalKind;
  tool: 'start_task' | 'start_member';
  target: { member: string | null; taskKey: string | null };
  allowed: OperatorSignalStepTargets;
  stepsAt: readonly string[];
  now: string;
}): OperatorSignalStepRefusal | null {
  const { level, tool, target, allowed } = input;
  const granted = OPERATOR_OWNER_GRANTED_STEP_KINDS.includes(input.kind);
  if (level === 'report' && !granted) return { code: 'operator_no_request', reason: 'level' };
  if (!operatorSignalStepAllowed(level, input.kind)) return { code: 'operator_no_request', reason: 'kind' };
  if (tool === 'start_task' ? allowed.startTask === null : allowed.members.length === 0)
    return { code: 'operator_no_request', reason: 'tool' };
  const onTarget =
    tool === 'start_task'
      ? target.taskKey === allowed.startTask && target.member === null
      : target.member !== null &&
        allowed.members.includes(target.member) &&
        target.taskKey === allowed.taskKey;
  if (!onTarget) return { code: 'operator_no_request', reason: 'target' };
  if (!granted && input.stepsAt.length >= OPERATOR_SIGNAL_STEPS[level])
    return { code: 'operator_signal_budget', reason: 'used', retryAt: null };
  const { nextAt } = operatorSignalBudget(level, input.stepsAt, input.now, input.kind);
  return nextAt ? { code: 'operator_signal_budget', reason: 'too_soon', retryAt: nextAt } : null;
}
