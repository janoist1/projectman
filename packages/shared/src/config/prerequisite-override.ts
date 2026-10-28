import type { Actor } from '../domain/event';
import { isCoordinatorSuperActor } from './operator-member';
import { isCoordinationActor } from './project-manager';
import type { PrerequisiteOverride, ProjectConfig } from './schema';

/** Today's rule (PM-204): only people override an open prerequisite. */
export const DEFAULT_PREREQUISITE_OVERRIDE: PrerequisiteOverride = 'people';

export function prerequisiteOverrideOf(config: Pick<ProjectConfig, 'team'>): PrerequisiteOverride {
  return config.team.prerequisiteOverride ?? DEFAULT_PREREQUISITE_OVERRIDE;
}

/**
 * Whether the actor's `despitePrerequisites` flag is honored (PM-204, PM-1099): a person, the coordinator
 * acting on the owner's request, or the selected project manager acting directly when the project allows it.
 * Everyone else's flag is dropped silently, as before.
 */
export function mayOverridePrerequisites(config: Pick<ProjectConfig, 'team'>, actor: Actor): boolean {
  return (
    actor.kind === 'human' ||
    isCoordinatorSuperActor(config, actor) ||
    (prerequisiteOverrideOf(config) === 'people_and_project_manager' && isCoordinationActor(config, actor))
  );
}
