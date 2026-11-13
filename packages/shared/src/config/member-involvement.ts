import type { Actor } from '../domain/event';
import { isCoordinatorSuperActor } from './operator-member';
import { isCoordinationActor } from './project-manager';
import type { MemberInvolvement, ProjectConfig } from './schema';
import { teamSettingOf } from './team-settings';

export function memberInvolvementOf(config: Pick<ProjectConfig, 'team'>): MemberInvolvement {
  return teamSettingOf(config, 'memberInvolvement');
}

/**
 * Whether the actor may involve an AI member on a card it has no role on (PM-1267): a person, the coordinator
 * acting on the owner's request, or the selected project manager acting directly when the project allows it.
 */
export function mayInvolveMembers(config: Pick<ProjectConfig, 'team'>, actor: Actor): boolean {
  return (
    actor.kind === 'human' ||
    isCoordinatorSuperActor(config, actor) ||
    (memberInvolvementOf(config) === 'people_and_project_manager' && isCoordinationActor(config, actor))
  );
}
