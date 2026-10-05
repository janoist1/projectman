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
