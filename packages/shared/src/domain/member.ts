import { z } from 'zod';
import { RoleId } from './role';

/**
 * Stable, unique identifier of a team member within a project ("fe-1", "qa", "owner").
 * Shown next to the display name so humans can tell members apart ("Anna · fe-1").
 */
export const MemberHandle = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and dashes, max 32 chars');
export type MemberHandle = z.infer<typeof MemberHandle>;

/** A team mixes humans and AI members; both appear in the same roster. */
export const MemberKind = z.enum(['human', 'ai']);
export type MemberKind = z.infer<typeof MemberKind>;

/** Access level of a human member. */
export const HumanAccess = z.enum(['owner', 'admin', 'developer', 'client', 'viewer']);
export type HumanAccess = z.infer<typeof HumanAccess>;

/**
 * @deprecated Roles come from the role catalogue now: use `RoleId` (any built-in or custom
 * role) or `BuiltInRoleId`, and `BUILT_IN_ROLE_IDS` instead of `AiRole.options`. Kept as an
 * alias until the web app has moved over.
 */
export const AiRole = RoleId;
/** @deprecated Use `RoleId` or `BuiltInRoleId`. */
export type AiRole = RoleId;

/** Claude Code permission modes (passed to `claude --permission-mode`). */
export const PermissionMode = z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** Runtime status shown on member avatars. Humans: online/offline/invited; AI: idle/working/waiting. */
export const MemberStatus = z.enum([
  'idle',
  'working',
  'waiting_for_human',
  'online',
  'offline',
  'invited',
  'retired',
]);
export type MemberStatus = z.infer<typeof MemberStatus>;
