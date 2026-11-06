import { memberOf } from './lookup';
import type { MemberConfig, ProjectConfig } from './schema';

/**
 * Whether a member is on leave (decision 23): only an AI member can be. Nothing starts a session
 * for a member on leave (task start, stage hand-over, message wake-up, schedule run, a person
 * writing into a stopped session), and it is not picked or named as an assignee.
 */
export function isOnLeave(
  member: { kind: MemberConfig['kind']; onLeave?: boolean | undefined } | null | undefined,
): boolean {
  return member?.kind === 'ai' && member.onLeave === true;
}

/** Whether the member with this handle is on leave. */
export function isHandleOnLeave(
  config: Pick<ProjectConfig, 'team'>,
  handle: string | null | undefined,
): boolean {
  return isOnLeave(memberOf(config, handle));
}

/**
 * The handles of the members a configuration change sent on leave (PM-1300): members of the team before
 * who were not on leave then and are now. A new configuration (no `previous`) sends nobody.
 */
export function membersSentOnLeave(
  previous: Pick<ProjectConfig, 'team'> | null | undefined,
  next: Pick<ProjectConfig, 'team'>,
): string[] {
  if (!previous) return [];
  return next.team.members
    .filter((member) => {
      const before = memberOf(previous, member.handle);
      return isOnLeave(member) && before !== undefined && !isOnLeave(before);
    })
    .map((member) => member.handle);
}

/**
 * Whether `busy` working AI sessions reach the project's cap. There is no cap unless the limits
 * name one (decision 23).
 */
export function aiLimitReached(config: Pick<ProjectConfig, 'team'>, busy: number): boolean {
  const max = config.team.limits.maxConcurrentAi;
  return max !== undefined && busy >= max;
}
