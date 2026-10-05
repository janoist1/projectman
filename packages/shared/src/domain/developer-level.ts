import { z } from 'zod';
import type { MemberConfig, TeamLimits } from '../config/schema';
import { MemberHandle } from './member';
import type { Task } from './task';

/*
 * Only types come from `task.ts` and the configuration schema: `task.ts` imports this file for
 * `TaskDeveloperLevel`, so a value import back would be a cycle. The rules that read the
 * configuration (`seniorsOf`, `canSetDeveloperLevel`, ...) are in `config/senior.ts`.
 */

/**
 * The developer a card is recommended for (PM-347): `senior` is a task that suits the team's Senior
 * (the runner, the sandbox, security, delicate concurrency, debugging), `any` is a task any developer
 * may take. A card without a recommendation counts as `any`.
 */
export const DeveloperLevel = z.enum(['senior', 'any']);
export type DeveloperLevel = z.infer<typeof DeveloperLevel>;

export const DEVELOPER_LEVEL_REASON_MAX = 300;

/** The recommendation on a card: who set it, when, and why (the reason is required for `senior`). */
export const TaskDeveloperLevel = z.object({
  level: DeveloperLevel,
  reason: z.string().max(DEVELOPER_LEVEL_REASON_MAX).nullable(),
  setBy: MemberHandle,
  /** ISO time. */
  setAt: z.string(),
});
export type TaskDeveloperLevel = z.infer<typeof TaskDeveloperLevel>;

/** How long a Senior card waits for a Senior when the limits name no time (PM-338). */
export const DEFAULT_SENIOR_WAIT_MINUTES = 30;

/** The recommendation of the card; a missing one is `any`. */
export function developerLevelOf(task: Pick<Task, 'developerLevel'>): DeveloperLevel {
  return task.developerLevel?.level ?? 'any';
}

/** The recommendation as one line of prompt text: `senior (reason)`. */
export function developerLevelText(level: Pick<TaskDeveloperLevel, 'level' | 'reason'>): string {
  return level.reason ? `${level.level} (${level.reason.replace(/\s+/g, ' ')})` : level.level;
}

/** An AI member marked as the Senior, and not a temp worker (a stand-in is never one). */
export function isSenior(member: MemberConfig | undefined): boolean {
  return member?.kind === 'ai' && member.senior === true && !member.temp;
}

/** Minutes a Senior card waits for a Senior before it may go to another developer. */
export function seniorWaitMinutesOf(limits: Pick<TeamLimits, 'seniorWaitMinutes'>): number {
  return limits.seniorWaitMinutes ?? DEFAULT_SENIOR_WAIT_MINUTES;
}

/** A free AI owner of the work stage, as the automatic choice sees it (PM-348). */
export interface DeveloperCandidate {
  handle: string;
  senior: boolean;
  temp: boolean;
  /** What the member works on now. */
  load: number;
  /** The member's place in the team list: the tie-break. */
  index: number;
}

/**
 * The outcome of the automatic choice: a member; `senior_busy` a Senior card that waits for one of
 * the `seniors` (none is free); `none` nobody is free (a temp worker may be hired when `tempAllowed`).
 */
export type DeveloperPick =
  | { kind: 'member'; handle: string }
  | { kind: 'senior_busy'; seniors: string[] }
  | { kind: 'none'; tempAllowed: boolean };

const byLoad = (a: DeveloperCandidate, b: DeveloperCandidate) => a.load - b.load || a.index - b.index;

/**
 * The automatic choice of the developer among the free AI owners of the work stage (PM-348).
 * A Senior card goes to the least loaded free Senior; with none free it waits (`senior_busy`),
 * unless a person decided that any developer may take it (`anyDecided`) or the team has no Senior.
 * Any other card, and a Senior card that does not wait, goes to the least loaded free member, a
 * Senior last (a Senior is taken only when no other developer is free); a Senior card never goes
 * to a temp worker. `seniors` are all the work stage's Seniors, free or not, on leave or not.
 */
export function pickDeveloper(input: {
  level: DeveloperLevel;
  /** The owners chose that a free developer may take the Senior card. */
  anyDecided: boolean;
  seniors: string[];
  free: DeveloperCandidate[];
}): DeveloperPick {
  const { level, anyDecided, seniors, free } = input;
  if (level === 'senior' && !anyDecided && seniors.length > 0) {
    const senior = free.filter((c) => c.senior).sort(byLoad)[0];
    return senior ? { kind: 'member', handle: senior.handle } : { kind: 'senior_busy', seniors };
  }
  const pick = free
    .filter((c) => level !== 'senior' || !c.temp)
    .sort((a, b) => Number(a.senior) - Number(b.senior) || byLoad(a, b))[0];
  return pick ? { kind: 'member', handle: pick.handle } : { kind: 'none', tempAllowed: level !== 'senior' };
}
