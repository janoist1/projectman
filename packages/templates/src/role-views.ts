import { BUILT_IN_ROLE_IDS, customRoleDuties, roleBundle, roleHolders } from '@projectman/shared';
import type { ProjectConfig, RoleView } from '@projectman/shared';
import { getLocale } from './locales';

/**
 * The role catalogue of a project: the built-in roles with their texts in the project's
 * language (English when the language has no locale), then the team's custom roles.
 */
export function roleViews(config: Pick<ProjectConfig, 'project' | 'team'>): RoleView[] {
  const locale = getLocale(config.project.language);
  const builtIn = BUILT_IN_ROLE_IDS.map((id): RoleView => ({
    id,
    name: locale.roles[id].name,
    summary: locale.roles[id].summary,
    notTheirJob: locale.roles[id].notTheirJob,
    holders: roleHolders(id, config.team.roles, config.team.roleOverrides)!,
    duties: roleBundle(config, id).duties,
    instructions: roleBundle(config, id).instructions,
    builtIn: true,
  }));
  const custom = config.team.roles.map((role): RoleView => ({
    id: role.id,
    name: role.name,
    summary: role.summary,
    notTheirJob: role.notTheirJob,
    holders: roleHolders(role.id, config.team.roles)!,
    duties: customRoleDuties(role),
    instructions: role.instructions,
    builtIn: false,
  }));
  return [...builtIn, ...custom];
}
