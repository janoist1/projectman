import { z } from 'zod';
import type { ProjectManagerSignalKind } from '../api/dto';
import type { ProjectConfig } from './schema';
import { teamSettingOf } from './team-settings';

export const OPERATOR_WATCH_LEVELS = ['report', 'unblock', 'drive'] as const;
export const ProjectManagerWatch = z.enum(OPERATOR_WATCH_LEVELS);
export type ProjectManagerWatch = z.infer<typeof ProjectManagerWatch>;

const COORDINATOR_ONLY_SIGNAL_KINDS: readonly ProjectManagerSignalKind[] = [
  'structural_pattern',
  'milestone_closed',
  'review_follow_ups',
];
/** The coordinator-only kinds as a list for the English agent texts: `a, b and c`. */
export function coordinatorOnlySignalKindsText(): string {
  const kinds = COORDINATOR_ONLY_SIGNAL_KINDS;
  return `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}`;
}
export function isCoordinatorOnlySignal(kind: ProjectManagerSignalKind): boolean {
  return COORDINATOR_ONLY_SIGNAL_KINDS.includes(kind);
}

/**
 * The signal kinds the owners never get a question about (PM-1243): the coordinator takes the signal's own
 * step (`unreleased`, a retired kind: a `release_due` integrator todo carries the case now) or closes it
 * (`dismiss_signal`). The server refuses an owner question tied to one (`ownerQuestionSignalRefusal`).
 */
export const OWNER_SILENT_SIGNAL_KINDS: readonly ProjectManagerSignalKind[] = [
  'unreleased',
  ...COORDINATOR_ONLY_SIGNAL_KINDS,
];

/** The refusal of an owner question about a signal of this kind, or null when the owners may be asked. */
export function ownerQuestionSignalRefusal(kind: ProjectManagerSignalKind): 'signal_not_for_owner' | null {
  return OWNER_SILENT_SIGNAL_KINDS.includes(kind) ? 'signal_not_for_owner' : null;
}

/** What the coordinator is told when `ownerQuestionSignalRefusal` refuses (English, as the tool errors are). */
export function ownerQuestionSignalRefusalMessage(kind: ProjectManagerSignalKind): string {
  return (
    `signal_not_for_owner: the owners do not get a question about a ${kind} signal. ` +
    (kind === 'unreleased'
      ? 'An unreleased signal is retired: the release_due integrator todo carries it, so leave it; '
      : 'It is for you only; ') +
    'a machine step belongs to open_integrator_todo, and a signal meant for you alone is closed with dismiss_signal.'
  );
}

/** The signal kinds the coordinator may close as needing nothing instead of presenting them. */
export const OPERATOR_DISMISSIBLE_SIGNAL_KINDS: readonly ProjectManagerSignalKind[] = [
  'obligation_overdue',
  'relation_check',
  ...COORDINATOR_ONLY_SIGNAL_KINDS,
];

/** How much the coordinator does on its own on a system signal (PM-545); absent means report. */
export function operatorWatchOf(config: Pick<ProjectConfig, 'team'>): ProjectManagerWatch {
  return teamSettingOf(config, 'operatorWatch');
}

/** How many own steps the coordinator may take on one signal at each level. */
export const OPERATOR_SIGNAL_STEPS: Record<ProjectManagerWatch, number> = { report: 0, unblock: 1, drive: 3 };
/** The least time between two own steps on one signal. */
export const OPERATOR_SIGNAL_STEP_GAP_MINUTES = 30;
/**
 * The signal kinds the coordinator may act on without an owner's request, per level.
 */
export const OPERATOR_SIGNAL_STEP_KINDS: Record<ProjectManagerWatch, readonly ProjectManagerSignalKind[]> = {
  report: [],
  unblock: ['obligation_overdue', 'merge_blocked', 'answer_stalled', 'start_blocked'],
  drive: ['obligation_overdue', 'merge_blocked', 'answer_stalled', 'start_blocked'],
};

/** Whether the kind is stepped on at this level: by the level's own list. */
export function operatorSignalStepAllowed(
  level: ProjectManagerWatch,
  kind: ProjectManagerSignalKind,
): boolean {
  return OPERATOR_SIGNAL_STEP_KINDS[level].includes(kind);
}

/** The least time between two own steps on a signal, in milliseconds. */
export function operatorSignalStepGapMs(): number {
  return OPERATOR_SIGNAL_STEP_GAP_MINUTES * 60_000;
}
/**
 * The signal kinds whose wake-ups go on the project's fast line (PM-694): at most one wake-up per
 * `OPERATOR_ANSWER_STALL_WAKE_MS`, apart from the general `OPERATOR_SIGNAL_WAKE_INTERVAL_MS` limit.
 */
export const OPERATOR_FAST_SIGNAL_KINDS: readonly ProjectManagerSignalKind[] = ['answer_stalled'];
/** The least time between two own steps on cards of one member after an `answer_stalled` step. */
export const OPERATOR_ANSWER_STALL_MUTE_MINUTES = OPERATOR_SIGNAL_STEP_GAP_MINUTES;
/** The `from` of the request row that carries the coordinator's own steps on signals; never a valid handle. */
export const OPERATOR_SIGNAL_ROUND_FROM = '@signals';

/** What a signal lets the coordinator start: `startTask` is the card `start_task` may start; `members` are for `start_member`. */
export type ProjectManagerSignalStepTargets = {
  startTask: string | null;
  members: string[];
  taskKey: string | null;
};

export type ProjectManagerSignalStepRefusal =
  | { code: 'operator_no_request'; reason: 'level' | 'kind' | 'tool' | 'target' }
  | { code: 'operator_signal_budget'; reason: 'used' | 'too_soon'; retryAt: string | null };

/** What is left of a signal's own steps: how many, and when the next one may be taken (null: now, or none left). */
export function operatorSignalBudget(
  level: ProjectManagerWatch,
  stepsAt: readonly string[],
  now: string,
): { left: number; nextAt: string | null } {
  const left = Math.max(0, OPERATOR_SIGNAL_STEPS[level] - stepsAt.length);
  const last = stepsAt.reduce<number | null>((max, at) => {
    const time = Date.parse(at);
    return max === null || time > max ? time : max;
  }, null);
  const next = last === null ? null : last + operatorSignalStepGapMs();
  return {
    left,
    nextAt: left > 0 && next !== null && Date.parse(now) < next ? new Date(next).toISOString() : null,
  };
}

/**
 * Why the coordinator may not take this step on a signal without an owner's request, or null when it may.
 * It decides in this order: the level, the signal kind, the tool, the target, then the budget.
 */
export function operatorSignalStepRefusal(input: {
  level: ProjectManagerWatch;
  kind: ProjectManagerSignalKind;
  tool: 'start_task' | 'start_member';
  target: { member: string | null; taskKey: string | null };
  allowed: ProjectManagerSignalStepTargets;
  stepsAt: readonly string[];
  now: string;
}): ProjectManagerSignalStepRefusal | null {
  const { level, tool, target, allowed } = input;
  if (level === 'report') return { code: 'operator_no_request', reason: 'level' };
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
  if (input.stepsAt.length >= OPERATOR_SIGNAL_STEPS[level])
    return { code: 'operator_signal_budget', reason: 'used', retryAt: null };
  const { nextAt } = operatorSignalBudget(level, input.stepsAt, input.now);
  return nextAt ? { code: 'operator_signal_budget', reason: 'too_soon', retryAt: nextAt } : null;
}
