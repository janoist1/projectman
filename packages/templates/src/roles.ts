import {
  isBuiltInRole,
  roleHolders,
  BUILT_IN_ROLE_DUTIES,
  DUTIES,
  type RoleOverrides,
  type AiBuiltInRoleId,
  type CustomRoleDefinition,
  type PermissionMode,
} from '@projectman/shared';

/** Defaults used when an AI member is hired for a role. */
export interface AiRoleDefaults {
  /** English role instructions appended to the member's system prompt. */
  instructions: string;
  model: string;
  permissionMode: PermissionMode;
  capacity: number;
}

const ROLE_DEFAULTS: Record<AiBuiltInRoleId, AiRoleDefaults> = {
  project_manager: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 1 },
  business_analyst: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 2 },
  architect: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 2 },
  designer: { instructions: '', model: 'opus', permissionMode: 'acceptEdits', capacity: 1 },
  developer: { instructions: '', model: 'opus', permissionMode: 'acceptEdits', capacity: 1 },
  code_review: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 2 },
  security_review: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 1 },
  qa: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 1 },
  devops: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 1 },
  communication: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 2 },
  support: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 1 },
  researcher: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 2 },
  maintainer: { instructions: '', model: 'opus', permissionMode: 'acceptEdits', capacity: 1 },
  coach: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 1 },
  watchdog: { instructions: '', model: 'opus', permissionMode: 'default', capacity: 1 },
  content: { instructions: '', model: 'opus', permissionMode: 'acceptEdits', capacity: 1 },
  translator: { instructions: '', model: 'opus', permissionMode: 'acceptEdits', capacity: 1 },
  docs: { instructions: '', model: 'opus', permissionMode: 'acceptEdits', capacity: 1 },
};

/**
 * Defaults of AI members hired for a custom role. No instructions are copied: members of a
 * custom role follow the role's own instructions (the context pack reads them from the role,
 * so editing the role reaches every member); a member's `instructions` add to them.
 */
export const CUSTOM_ROLE_DEFAULTS: Readonly<AiRoleDefaults> = Object.freeze({
  instructions: '',
  model: 'opus',
  permissionMode: 'default',
  capacity: 1,
});

/** Defaults for an AI member hired for a built-in role (roles only humans hold have none). */
export function aiRoleDefaults(role: AiBuiltInRoleId): AiRoleDefaults {
  return { ...ROLE_DEFAULTS[role], instructions: '' };
}

/**
 * Defaults for an AI member of any role: the built-in role's defaults, or the generic ones for
 * a custom role that AI members may hold. Null when the role is unknown or only humans may
 * hold it.
 */
export function aiMemberDefaults(
  role: string,
  customRoles: readonly Pick<CustomRoleDefinition, 'id' | 'holders' | 'duties'>[] = [],
  overrides: RoleOverrides = {},
): AiRoleDefaults | null {
  const holders = roleHolders(role, customRoles, overrides);
  if (!holders || holders === 'human') return null;
  const duties = isBuiltInRole(role)
    ? (overrides[role]?.duties ?? BUILT_IN_ROLE_DUTIES[role])
    : (customRoles.find((r) => r.id === role)?.duties ?? []);
  const defaults =
    isBuiltInRole(role) && Object.hasOwn(ROLE_DEFAULTS, role)
      ? aiRoleDefaults(role as AiBuiltInRoleId)
      : { ...CUSTOM_ROLE_DEFAULTS };
  return {
    ...defaults,
    permissionMode: duties.some((id) => DUTIES[id].toolPolicy === 'task_worktree')
      ? 'acceptEdits'
      : 'default',
  };
}
