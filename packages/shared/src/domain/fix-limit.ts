import { dutyMembers } from '../config/duties';
import { isOnLeave } from '../config/leave';
import { DEFAULT_MAX_FIX_ROUNDS } from '../config/schema';
import type { ProjectConfig, TeamLimits } from '../config/schema';
import { countCardRounds } from './card-measure';
import type { DutyId } from './duty';
import type { TimelineEvent } from './event';

/**
 * The upper limit on a card's fix rounds (PM-262), shared by the server and the web's fake backend. A fix
 * round is a change request of the code review, a change request of the UI/UX review or a send-back into a
 * work stage; they are counted from the card's timeline by the counter of PM-222 (`countCardRounds`).
 * When they reach the limit the next round does not go to the implementer by itself: the lead developer
 * decides, and a person when the lead cannot or when it goes on after the lead.
 */

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
  const { changeRequests, designChangeRequests, sendBacks } = countCardRounds(counted, config);
  return {
    rounds: changeRequests + designChangeRequests + sendBacks,
    changeRequests,
    designChangeRequests,
    sendBacks,
  };
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
 * The people who decide when it reaches a person: the owners and admins who hold the technical direction
 * duty; when there is none, `owners`.
 */
export function fixLimitDeciders(config: Pick<ProjectConfig, 'team'>, owners: readonly string[]): string[] {
  const holders = dutyMembers(config, FIX_LIMIT_DECISION_DUTY)
    .filter((member) => member.kind === 'human' && (member.access === 'owner' || member.access === 'admin'))
    .map((member) => member.handle);
  return holders.length > 0 ? holders : [...owners];
}
