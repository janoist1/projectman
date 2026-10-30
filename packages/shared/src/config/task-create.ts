import { hasAccess } from '../domain/member';
import type { HumanAccess } from '../domain/member';
import type { ProjectConfig, TaskCreateAccess } from './schema';
import { teamSettingOf } from './team-settings';

/** The lowest human access that may open a new card (PM-1100). */
export function taskCreateAccessOf(config: Pick<ProjectConfig, 'team'>): TaskCreateAccess {
  return teamSettingOf(config, 'taskCreateAccess');
}

/**
 * Whether a human may open a new card. A viewer never may: the rank table puts viewer and client
 * at the same level, so `hasAccess(access, 'client')` alone would let the read-only viewer in.
 */
export function canCreateTasks(
  config: Pick<ProjectConfig, 'team'>,
  access: HumanAccess | undefined,
): boolean {
  if (access === undefined || access === 'viewer') return false;
  const minimum = taskCreateAccessOf(config);
  return minimum === 'client' || hasAccess(access, minimum);
}

/** A client's card always starts in the first stage, so the owners still triage it. */
export function createsInFirstStageOnly(access: HumanAccess): boolean {
  return !hasAccess(access, 'developer');
}
