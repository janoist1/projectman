import {
  isBuiltInRole,
  BUILT_IN_ROLE_IDS,
  BUILT_IN_ROLE_DUTIES,
  DUTIES,
  roleBundle,
} from '@projectman/shared';
import type { BuiltInRoleId, RoleId, ProjectConfig } from '@projectman/shared';

/**
 * Per-role session settings, kept in one place so they are easy to change.
 */

/** The team tools (MCP server "team"): every AI session may use them without asking. */
export const TEAM_TOOLS_ALLOWED = ['mcp__team__*'];

/** Read-only tools reviewers need constantly; pre-approving them avoids a stream of permission requests. */
export const READ_ONLY_REVIEW_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr diff:*)',
];

export interface RoleSessionPolicy {
  /** Review and research roles: the read-only tools are pre-approved. */
  readOnlyTools: boolean;
  /** Roles that change files: their task sessions run in the task's own git worktree (when the task names a repo). */
  worktree: boolean;
}

/** Union of the actual duties, including custom roles and project overrides. */
export function sessionPolicyFor(role: RoleId, config?: ProjectConfig): RoleSessionPolicy {
  const duties = config
    ? roleBundle(config, role).duties
    : isBuiltInRole(role)
      ? BUILT_IN_ROLE_DUTIES[role]
      : [];
  return {
    readOnlyTools: duties.some((id) => DUTIES[id].toolPolicy === 'read_only'),
    worktree: duties.some((id) => DUTIES[id].toolPolicy === 'task_worktree'),
  };
}
export function allowedToolsFor(role: RoleId, config?: ProjectConfig): string[] {
  return [
    ...TEAM_TOOLS_ALLOWED,
    ...(sessionPolicyFor(role, config).readOnlyTools ? READ_ONLY_REVIEW_TOOLS : []),
  ];
}
export function usesWorktree(role: RoleId, config?: ProjectConfig): boolean {
  return sessionPolicyFor(role, config).worktree;
}
/** Compatibility exports, derived from duties. */
export const ROLE_SESSION_POLICIES = Object.fromEntries(
  BUILT_IN_ROLE_IDS.map((id) => [id, sessionPolicyFor(id)]),
) as Record<BuiltInRoleId, RoleSessionPolicy>;
export const WORKTREE_ROLES: ReadonlySet<BuiltInRoleId> = new Set(
  BUILT_IN_ROLE_IDS.filter((id) => usesWorktree(id)),
);

/** Delay before a done task's sessions are stopped, so an in-flight tool result still reaches the agent. */
export const DONE_TASK_CLEANUP_DELAY_MS = 2_000;
