import {
  isBuiltInRole,
  roleHolders,
  DEFAULT_PERMISSION_LEVEL,
  DEFAULT_PROVIDER_MODELS,
  cliPermissionMode,
  type AiBuiltInRoleId,
  type BuiltInRoleId,
  type CustomRoleDefinition,
  type PermissionLevel,
  type PermissionMode,
  type RoleOverrides,
} from '@projectman/shared';

/** Defaults used when an AI member is hired for a role. */
export interface AiRoleDefaults {
  /** English role instructions appended to the member's system prompt. */
  instructions: string;
  model: string;
  /** Every new member starts with the default level, whatever its role or provider. */
  permissionLevel: PermissionLevel;
  /** The agent CLI mode that level maps to (kept for configurations and readers of the old field). */
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
 * Defaults for a new AI member: the default permission level for every role. No instructions
 * are copied: the context pack reads the duty fragments and the role's own instructions, so
 * editing the role reaches every member; a member's `instructions` add to them.
 */
function defaultsFor(capacity = 1): AiRoleDefaults {
  return {
    instructions: '',
    model: DEFAULT_PROVIDER_MODELS.claude,
    permissionLevel: DEFAULT_PERMISSION_LEVEL,
    permissionMode: cliPermissionMode(DEFAULT_PERMISSION_LEVEL),
    capacity,
  };
}

/** Defaults for an AI member hired for a built-in role (roles only humans hold have none). */
export function aiRoleDefaults(role: AiBuiltInRoleId): AiRoleDefaults {
  return defaultsFor(ROLE_CAPACITY[role]);
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
  return defaultsFor(isBuiltInRole(role) ? ROLE_CAPACITY[role] : undefined);
}
