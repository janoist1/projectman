import { z } from 'zod';
import { MemberHandle } from './member';

export const ScheduleSkipReason = z.enum([
  'previous_run_live',
  'member_at_capacity',
  'ai_limit_reached',
  'plan_usage_paused',
  'provider_not_logged_in',
]);
export type ScheduleSkipReason = z.infer<typeof ScheduleSkipReason>;
export const ScheduleRun = z.object({
  id: z.string(),
  projectKey: z.string(),
  member: MemberHandle,
  scheduledFor: z.string(),
  startedAt: z.string().nullable(),
  sessionId: z.string().nullable(),
  status: z.enum(['started', 'skipped', 'failed', 'done']),
  reason: z.string().nullable(),
});
export type ScheduleRun = z.infer<typeof ScheduleRun>;
export const SchedulesView = z.object({
  timezone: z.string(),
  members: z.array(
    z.object({
      member: MemberHandle,
      cron: z.string(),
      promptSummary: z.string(),
      nextRun: z.string().nullable(),
    }),
  ),
  runs: z.array(ScheduleRun),
});
export type SchedulesView = z.infer<typeof SchedulesView>;
