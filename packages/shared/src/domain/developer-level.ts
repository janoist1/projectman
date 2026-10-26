import type { TeamLimits } from '../config/schema';

/** Minutes a scored card waits for a suitable developer before the owners are asked. */
export const DEFAULT_SENIOR_WAIT_MINUTES = 30;
export function seniorWaitMinutesOf(limits: Pick<TeamLimits, 'seniorWaitMinutes'>): number {
  return limits.seniorWaitMinutes ?? DEFAULT_SENIOR_WAIT_MINUTES;
}
