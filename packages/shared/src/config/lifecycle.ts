import type { Actor } from '../domain/event';
import { hasAccess } from '../domain/member';
import { memberOf } from './lookup';
import { isCoordinationActor } from './project-manager';
import type { ProjectConfig, ProjectManagerLifecycleAction } from './schema';
import { teamSettingOf } from './team-settings';

/** The lifecycle actions the PM takes on its own (PM-1098). */
export function projectManagerLifecycleOf(
  config: Pick<ProjectConfig, 'team'>,
): readonly ProjectManagerLifecycleAction[] {
  return teamSettingOf(config, 'projectManagerLifecycle');
}

/** The selected PM acting directly (no integrator) may take the action when the setting lists it. */
export function projectManagerMayLifecycle(
  config: Pick<ProjectConfig, 'team'>,
  actor: Pick<Actor, 'kind' | 'handle' | 'via'>,
  action: ProjectManagerLifecycleAction,
): boolean {
  return isCoordinationActor(config, actor) && projectManagerLifecycleOf(config).includes(action);
}

/**
 * Who may take a lifecycle action on a card that is not a theme: a human member of admin access (the owner
 * included), or the project manager as `projectManagerMayLifecycle` says.
 */
export function lifecycleAllowed(
  config: Pick<ProjectConfig, 'team'>,
  actor: Pick<Actor, 'kind' | 'handle' | 'via'>,
  action: ProjectManagerLifecycleAction,
): boolean {
  if (actor.kind === 'human') {
    const member = memberOf(config, actor.handle);
    return member?.kind === 'human' && hasAccess(member.access, 'admin');
  }
  return projectManagerMayLifecycle(config, actor, action);
}
