import {
  isBuiltInRole,
  roleHolders,
  DEFAULT_NEW_MEMBER_APPROVER,
  DEFAULT_OUTBOUND_NETWORK,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_PROVIDER_MODELS,
  type AiBuiltInRoleId,
  type Approver,
  type BuiltInRoleId,
  type CustomRoleDefinition,
  type PermissionMode,
  type RoleOverrides,
} from '@projectman/shared';

/** Defaults used when an AI member is hired for a role. */
export interface AiRoleDefaults {
  /** English role instructions appended to the member's system prompt. */
  instructions: string;
  model: string;
  /** Every new member starts in the default mode (Auto), whatever its role or provider. */
  permissionMode: PermissionMode;
  /** Who answers when the CLI asks: nobody for a new member (`DEFAULT_NEW_MEMBER_APPROVER`). */
  approver: Approver;
  capacity: number;
  /** Whether a new member's commands can reach the network (`DEFAULT_OUTBOUND_NETWORK`, PM-355). */
  outboundNetwork: boolean;
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
 * Defaults for a new AI member: the default permission mode for every role. No instructions
 * are copied: the context pack reads the duty fragments and the role's own instructions, so
 * editing the role reaches every member; a member's `instructions` add to them.
 */
function defaultsFor(capacity = 1): AiRoleDefaults {
  return {
    instructions: '',
    model: DEFAULT_PROVIDER_MODELS.claude,
    permissionMode: DEFAULT_PERMISSION_MODE,
    approver: DEFAULT_NEW_MEMBER_APPROVER,
    capacity,
    outboundNetwork: DEFAULT_OUTBOUND_NETWORK,
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
