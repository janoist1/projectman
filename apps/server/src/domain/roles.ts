import {
  roleHolders,
  roleBundle,
  dutyHolders,
  customRoleDuties,
  BUILT_IN_ROLE_IDS,
  holdersAllow,
  isBuiltInRole,
} from '@projectman/shared';
import type {
  Actor,
  CustomRoleDefinition,
  MemberConfig,
  ProjectConfig,
  RoleView,
  RolesView,
} from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { conflict, invalid, notFound } from './errors';
import type { Author, ProjectService } from './projects';

/**
 * The role catalogue of a project: the built-in roles with their texts in the project's
 * language (English when the language has no locale), then the team's custom roles.
 */
export function roleViews(config: ProjectConfig): RoleView[] {
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
    holders: dutyHolders(customRoleDuties(role))!,
    duties: customRoleDuties(role),
    instructions: role.instructions,
    builtIn: false,
  }));
  return [...builtIn, ...custom];
}

/** Members holding a role: AI members of that role and humans who hold it among their roles. */
function membersHolding(config: ProjectConfig, roleId: string): MemberConfig[] {
  return config.team.members.filter((m) => (m.kind === 'ai' ? m.role === roleId : m.roles.includes(roleId)));
}

/** Who holds a role, and whether temp workers are hired for it. */
export function roleUsage(
  config: ProjectConfig,
  roleId: string,
): { members: string[]; tempWorkers: boolean } {
  return {
    members: membersHolding(config, roleId).map((m) => m.handle),
    tempWorkers: config.team.limits.tempWorkers.role === roleId,
  };
}

/**
 * The role catalogue and the team's custom roles. Custom roles live in the customization
 * repository like the rest of the configuration: every change is a commit.
 */
export class RoleService {
  private readonly projects: ProjectService;

  constructor(deps: { projects: ProjectService }) {
    this.projects = deps.projects;
  }

  async list(projectKey: string): Promise<RolesView> {
    return { roles: roleViews(await this.projects.config(projectKey)) };
  }

  async create(
    projectKey: string,
    role: CustomRoleDefinition,
    by: { actor: Actor; author: Author },
  ): Promise<RoleView> {
    await this.projects.update(projectKey, by, (draft) => {
      if (isBuiltInRole(role.id)) {
        throw conflict('custom_role_shadows_builtin', `${role.id} is a built-in role`, { role: role.id });
      }
      if (draft.team.roles.some((r) => r.id === role.id)) {
        throw conflict('duplicate_role', `role already exists: ${role.id}`, { role: role.id });
      }
      draft.team.roles.push(role);
      return `Add role ${role.id}`;
    });
    return this.view(projectKey, role.id);
  }

  /** Replaces a custom role; its members must still be allowed to hold it. */
  async update(
    projectKey: string,
    roleId: string,
    role: CustomRoleDefinition,
    by: { actor: Actor; author: Author },
  ): Promise<RoleView> {
    if (role.id !== roleId) {
      throw invalid('role_id_mismatch', `the role id in the body (${role.id}) differs from ${roleId}`);
    }
    if (isBuiltInRole(roleId)) throw invalid('builtin_role', `built-in roles cannot be changed: ${roleId}`);
    await this.projects.update(projectKey, by, (draft) => {
      const index = draft.team.roles.findIndex((r) => r.id === roleId);
      if (index < 0) throw notFound('role', roleId);
      const excluded = membersHolding(draft, roleId)
        .filter((m) => !holdersAllow(dutyHolders(customRoleDuties(role))!, m.kind))
        .map((m) => m.handle);
      const tempWorkers =
        draft.team.limits.tempWorkers.role === roleId &&
        !holdersAllow(dutyHolders(customRoleDuties(role))!, 'ai');
      if (excluded.length > 0 || tempWorkers) {
        throw conflict('role_in_use', `members hold ${roleId} who could not hold it any more`, {
          members: excluded,
          tempWorkers,
        });
      }
      draft.team.roles[index] = role;
      return `Update role ${roleId}`;
    });
    return this.view(projectKey, roleId);
  }

  /** Removes a custom role that nobody holds. */
  async remove(projectKey: string, roleId: string, by: { actor: Actor; author: Author }): Promise<void> {
    if (isBuiltInRole(roleId)) throw invalid('builtin_role', `built-in roles cannot be removed: ${roleId}`);
    await this.projects.update(projectKey, by, (draft) => {
      if (!draft.team.roles.some((r) => r.id === roleId)) throw notFound('role', roleId);
      const usage = roleUsage(draft, roleId);
      if (usage.members.length > 0 || usage.tempWorkers) {
        throw conflict('role_in_use', `the role ${roleId} is still held`, usage);
      }
      draft.team.roles = draft.team.roles.filter((r) => r.id !== roleId);
      return `Remove role ${roleId}`;
    });
  }

  private async view(projectKey: string, roleId: string): Promise<RoleView> {
    const view = roleViews(await this.projects.config(projectKey)).find((r) => r.id === roleId);
    if (!view) throw notFound('role', roleId);
    return view;
  }
}
