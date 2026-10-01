import { BUILT_IN_ROLE_IDS, customRoleDuties, roleBundle, roleHolders } from '@projectman/shared';
import type { ProjectConfig, RoleView } from '@projectman/shared';
import { getLocale } from './locales';

/**
 * The role catalogue of a project: the built-in roles with their texts in the project's
 * language (English when the language has no locale), then the team's custom roles. A
 * project's own text of a built-in role (`roleOverrides`) replaces the default unless empty.
 */
export function roleViews(config: Pick<ProjectConfig, 'project' | 'team'>): RoleView[] {
  const locale = getLocale(config.project.language);
  const builtIn = BUILT_IN_ROLE_IDS.map((id): RoleView => {
    const bundle = roleBundle(config, id);
    const text = (field: 'summary' | 'notTheirJob' | 'whenToAsk') =>
      config.team.roleOverrides?.[id]?.[field]?.trim() || locale.roles[id][field];
    return {
      id,
      name: locale.roles[id].name,
      summary: text('summary'),
      notTheirJob: text('notTheirJob'),
      whenToAsk: text('whenToAsk'),
      holders: roleHolders(id, config.team.roles, config.team.roleOverrides)!,
      duties: bundle.duties,
      instructions: bundle.instructions,
      builtIn: true,
    };
  });
  const custom = config.team.roles.map((role): RoleView => ({
    id: role.id,
    name: role.name,
    summary: role.summary,
    notTheirJob: role.notTheirJob,
    whenToAsk: role.whenToAsk ?? '',
    holders: roleHolders(role.id, config.team.roles)!,
    duties: customRoleDuties(role),
    instructions: role.instructions,
    builtIn: false,
  }));
  return [...builtIn, ...custom];
}
