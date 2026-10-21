import { dutyMembers } from '../config/duties';
import { isOnLeave } from '../config/leave';
import { DEFAULT_MAX_FIX_ROUNDS } from '../config/schema';
import type { ProjectConfig, TeamLimits } from '../config/schema';
import { z } from 'zod';
import { CardRoundKind, classifyCardRoundEvent, countCardRounds } from './card-measure';
import type { DutyId } from './duty';
import { Actor, timelineNoteExcerpt } from './event';
import type { TimelineEvent, TimelineEventData } from './event';

/**
 * The upper limit on a card's fix rounds (PM-262), shared by the server and the web's fake backend. A fix
 * round is a change request of the code review, a change request of the UI/UX review or a send-back into a
 * work stage; they are counted from the card's timeline by the counter of PM-222 (`countCardRounds`).
 * When they reach the limit the next round does not go to the implementer by itself: the lead developer
 * decides, and a person when the lead cannot or when it goes on after the lead.
 */

/**
 * The most extra rounds ("one more round") the lead developer may hand out within one count (PM-714): after
 * that, every time the card reaches the limit a person decides. A fixed rule, not a project setting. People
 * may allow more; the stored count is never cut to this value.
 */
export const MAX_FIX_EXTRA_ROUNDS = 3;

/** The extra rounds still left for the lead developer to give, given the `extraRounds` handed out so far. */
export function remainingFixExtraRounds(extraRounds: number): number {
  return Math.max(0, MAX_FIX_EXTRA_ROUNDS - extraRounds);
}

/** The outcomes of a fix limit decision; `replan` and `reassign` may be left out of an item when nobody can take them. */
export const FixLimitOptionId = z.enum(['replan', 'reassign', 'another_round']);
export type FixLimitOptionId = z.infer<typeof FixLimitOptionId>;

const AssessmentText = z.string().trim().min(1).max(2000);

/**
 * The lead developer's judgement when it passes a held card to the people (`decide_fix_limit` `to_owner`,
 * required there): whether the same fault comes back (one sentence), where the work stands now, and the
 * outcome it recommends with a reason. The system does not judge the fault itself.
 */
export const FixLimitAssessment = z.object({
  recurrence: AssessmentText,
  currentState: AssessmentText,
  recommendation: z.object({ optionId: FixLimitOptionId, reason: AssessmentText }),
});
export type FixLimitAssessment = z.infer<typeof FixLimitAssessment>;

/** The duty of the lead developer who decides first, and the duty the lead also has to hold. */
export const FIX_LIMIT_DECISION_DUTY: DutyId = 'technical_direction';
export const FIX_LIMIT_LEAD_DUTY: DutyId = 'code_review';

/** The rounds counted on a card. */
export interface FixRounds {
  /** All of them: `changeRequests + designChangeRequests + sendBacks`. */
  rounds: number;
  changeRequests: number;
  designChangeRequests: number;
  sendBacks: number;
  /** Failed full tests, already included in sendBacks. */
  testsFailed: number;
}

/**
 * The fix rounds in `events` (a card's stage changes and label changes, in any order, other types are
 * ignored) made after `since` (ISO time; null: from the beginning). A fresh start of the count (a decision
 * to give the card to somebody else, or the planner's release) is a `since`.
 */
export function countFixRounds(
  events: readonly Pick<TimelineEvent, 'type' | 'data' | 'createdAt'>[],
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  since: string | null,
): FixRounds {
  const counted = since === null ? events : events.filter((event) => event.createdAt > since);
  const { changeRequests, designChangeRequests, sendBacks, testsFailed } = countCardRounds(counted, config);
  return {
    rounds: changeRequests + designChangeRequests + sendBacks,
    changeRequests,
    designChangeRequests,
    sendBacks,
    testsFailed,
  };
}

export const FixRoundHistoryEntry = z.object({
  eventId: z.string(),
  at: z.string(),
  kind: z.union([CardRoundKind, z.literal('extra_round')]),
  round: z.number().int().positive().nullable(),
  actor: Actor,
  note: z.string().max(500).nullable(),
  runId: z.string().optional(),
  command: z.string().optional(),
  failedFiles: z.array(z.string()).optional(),
  commit: z.string().optional(),
  branch: z.string().optional(),
  pinned: z.string().optional(),
  head: z.string().optional(),
  extraRound: z.number().int().positive().optional(),
});
export type FixRoundHistoryEntry = z.infer<typeof FixRoundHistoryEntry>;

/** Source order is authoritative, including when several events have the same timestamp. */
export function fixRoundHistory(
  events: readonly TimelineEvent[],
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  since: string | null,
): FixRoundHistoryEntry[] {
  const results = new Map<string, TimelineEventData['task_full_test']>();
  for (const event of events) {
    if (event.type === 'task_full_test') {
      const result = event.data as TimelineEventData['task_full_test'];
      results.set(result.runId, result);
    }
  }
  const history: FixRoundHistoryEntry[] = [];
  let round = 0;
  let extraRound = 0;
  for (const event of events) {
    if (since !== null && event.createdAt <= since) continue;
    const base = { eventId: event.id, at: event.createdAt, actor: event.actor };
    if (
      event.type === 'task_fix_limit' &&
      event.data.phase === 'decided' &&
      event.data.decision === 'another_round'
    ) {
      extraRound += 1;
      history.push({
        ...base,
        kind: 'extra_round',
        round: null,
        note: timelineNoteExcerpt(event.data.note) ?? null,
        extraRound,
      });
    }
    for (const kind of classifyCardRoundEvent(event, config)) {
      const entry: FixRoundHistoryEntry = {
        ...base,
        kind,
        round: kind === 'branch_moved' ? null : ++round,
        note: timelineNoteExcerpt(event.data.noteExcerpt) ?? null,
      };
      if (kind === 'branch_moved') Object.assign(entry, event.data.branchMoved);
      if (kind === 'tests_failed') {
        const source = event.data.testsFailed as TimelineEventData['task_stage_changed']['testsFailed'];
        if (source) {
          Object.assign(entry, source);
          const result = results.get(source.runId);
          if (result?.command !== undefined) entry.command = result.command;
          if (result?.failedFiles !== undefined) entry.failedFiles = result.failedFiles;
        }
      }
      history.push(entry);
    }
  }
  return history;
}

/** The limit a project's limits set, else the default. */
export function maxFixRoundsOf(limits: Pick<TeamLimits, 'maxFixRounds'> | undefined): number {
  return limits?.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS;
}

/**
 * Whether the card is held: its `rounds` reached `limit` plus the `extraRounds` people let it have. With
 * a limit of 3 the implementer gets two rounds by itself and the third goes to a decision.
 */
export function fixLimitReached(rounds: number, limit: number, extraRounds: number): boolean {
  return rounds >= limit + extraRounds;
}

/** AI members who hold `duty`, in the configuration's order, not on leave and not in `exclude`. */
function aiHolders(config: Pick<ProjectConfig, 'team'>, duty: DutyId, exclude: readonly string[]): string[] {
  return dutyMembers(config, duty)
    .filter((member) => member.kind === 'ai' && !isOnLeave(member) && !exclude.includes(member.handle))
    .map((member) => member.handle);
}

/**
 * The lead developer who decides first: an AI member who holds the technical direction duty and also
 * the code review duty, not on leave and not in `exclude` (the card's assignee); null when there is none.
 */
export function fixLimitLead(config: Pick<ProjectConfig, 'team'>, exclude: readonly string[]): string | null {
  const reviewers = new Set(aiHolders(config, FIX_LIMIT_LEAD_DUTY, exclude));
  return aiHolders(config, FIX_LIMIT_DECISION_DUTY, exclude).find((handle) => reviewers.has(handle)) ?? null;
}

/**
 * Who a "more exact plan" goes to: another AI member who holds the technical direction duty, not on
 * leave and not in `exclude` (the lead and the card's assignee); null when there is none.
 */
export function fixLimitPlanner(
  config: Pick<ProjectConfig, 'team'>,
  exclude: readonly string[],
): string | null {
  return aiHolders(config, FIX_LIMIT_DECISION_DUTY, exclude)[0] ?? null;
}

/**
 * Who makes the more exact plan when a person asks for one: the planner that is not the card's assignee
 * and not the lead who would have decided (the lead has already passed the card on); null when there is none.
 */
export function fixLimitPlannerForOwner(
  config: Pick<ProjectConfig, 'team'>,
  assignee: string | null,
): string | null {
  const exclude = assignee ? [assignee] : [];
  const lead = fixLimitLead(config, exclude);
  return fixLimitPlanner(config, lead ? [...exclude, lead] : exclude);
}

/**
 * The people who decide when it reaches a person: the owners and admins who hold the technical direction
 * duty; when there is none, `owners`.
 */
export function fixLimitDeciders(config: Pick<ProjectConfig, 'team'>, owners: readonly string[]): string[] {
  const holders = dutyMembers(config, FIX_LIMIT_DECISION_DUTY)
    .filter((member) => member.kind === 'human' && (member.access === 'owner' || member.access === 'admin'))
    .map((member) => member.handle);
  return holders.length > 0 ? holders : [...owners];
}
