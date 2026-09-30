import type { AgentProvider, ErrorCode, ProjectConfig, TaskStartWaiting } from '@projectman/shared';
import { conflict, DomainError } from '../errors';

/** The project's AI master switch: while it is off, no AI session starts or resumes. */
export function assertAiEnabled(config: ProjectConfig): void {
  if (!config.team.limits.aiEnabled) throw conflict('ai_disabled', 'AI work is switched off in this project');
}

/** Admission refusals that a later retry can overcome; an automatic start waits for them. */
const DEFERRABLE = new Set<ErrorCode>([
  'ai_limit_reached',
  'plan_usage_paused',
  'ai_disabled',
  'member_at_capacity',
] satisfies Array<TaskStartWaiting['reason']>);

export function isDeferrable(err: unknown): err is DomainError & { code: TaskStartWaiting['reason'] } {
  return err instanceof DomainError && DEFERRABLE.has(err.code);
}

/**
 * Why a refused automatic start waits, as its task shows it: the refusal, the member it waits
 * for, and since when (kept from the previous refusal of the same start).
 */
export function waitingOf(
  err: DomainError & { code: TaskStartWaiting['reason'] },
  opts: { member?: string; previous?: TaskStartWaiting; at: string },
): TaskStartWaiting {
  const details = err.details as { provider?: AgentProvider; threshold?: number } | undefined;
  return {
    reason: err.code,
    member: opts.member,
    ...(err.code === 'plan_usage_paused'
      ? { provider: details?.provider, threshold: details?.threshold }
      : {}),
    since: opts.previous?.since ?? opts.at,
  };
}
