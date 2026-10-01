import {
  customRoleDuties,
  isBuiltInRole,
  roleHolders,
  BUILT_IN_ROLE_DUTIES,
  DEFAULT_PROVIDER_MODELS,
  DUTIES,
  type AiBuiltInRoleId,
  type BuiltInRoleId,
  type CustomRoleDefinition,
  type DutyId,
  type PermissionMode,
  type RoleOverrides,
} from '@projectman/shared';

/** Defaults used when an AI member is hired for a role. */
export interface AiRoleDefaults {
  /** English role instructions appended to the member's system prompt. */
  instructions: string;
  model: string;
  permissionMode: PermissionMode;
  capacity: number;
}

/** Built-in roles whose members run more than one work item at a time by default. */
const ROLE_CAPACITY: Partial<Record<BuiltInRoleId, number>> = {
  business_analyst: 2,
  architect: 2,
  code_review: 2,
  lead_developer: 2,
  communication: 2,
  researcher: 2,
};

/**
 * Defaults for a member holding these duties. Members that change files in the task's
 * worktree accept edits; everyone else asks. No instructions are copied: the context pack
 * reads the duty fragments and the role's own instructions, so editing the role reaches every
 * member; a member's `instructions` add to them.
 */
function defaultsFor(duties: readonly DutyId[], capacity = 1): AiRoleDefaults {
  return {
    instructions: '',
    model: DEFAULT_PROVIDER_MODELS.claude,
    permissionMode: duties.some((id) => DUTIES[id].toolPolicy === 'task_worktree')
      ? 'acceptEdits'
      : 'default',
    capacity,
  };
}

/** Defaults for an AI member hired for a built-in role (roles only humans hold have none). */
export function aiRoleDefaults(role: AiBuiltInRoleId): AiRoleDefaults {
  return defaultsFor(BUILT_IN_ROLE_DUTIES[role], ROLE_CAPACITY[role]);
}

/**
 * Defaults for an AI member of any role: the built-in role's defaults (with the team's
 * override of its duties), or the generic ones for a custom role that AI members may hold.
 * Null when the role is unknown or only humans may hold it.
 */
export function aiMemberDefaults(
  role: string,
  customRoles: readonly Pick<CustomRoleDefinition, 'id' | 'holders' | 'duties'>[] = [],
  overrides: RoleOverrides = {},
): AiRoleDefaults | null {
  const holders = roleHolders(role, customRoles, overrides);
  if (!holders || holders === 'human') return null;
  if (isBuiltInRole(role))
    return defaultsFor(overrides[role]?.duties ?? BUILT_IN_ROLE_DUTIES[role], ROLE_CAPACITY[role]);
  const custom = customRoles.find((r) => r.id === role);
  return defaultsFor(custom ? customRoleDuties(custom) : []);
}
