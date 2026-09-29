import { isBuiltInRole } from '@projectman/shared';
import type { BuiltInRoleId, RoleId } from '@projectman/shared';

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

const NEITHER: RoleSessionPolicy = { readOnlyTools: false, worktree: false };
const READS: RoleSessionPolicy = { readOnlyTools: true, worktree: false };
const WRITES: RoleSessionPolicy = { readOnlyTools: false, worktree: true };

/** Every built-in role; roles only humans hold never run a session. */
export const ROLE_SESSION_POLICIES: Record<BuiltInRoleId, RoleSessionPolicy> = {
  operator: NEITHER,
  product_owner: NEITHER,
  project_manager: NEITHER,
  business_analyst: READS,
  architect: READS,
  designer: WRITES,
  developer: WRITES,
  code_review: READS,
  security_review: READS,
  qa: READS,
  devops: NEITHER,
  communication: NEITHER,
  support: NEITHER,
  researcher: READS,
  maintainer: WRITES,
  coach: READS,
  watchdog: READS,
  content: WRITES,
  translator: WRITES,
  docs: WRITES,
};

/** Custom roles: team tools only, sessions in the workspace. */
export function sessionPolicyFor(role: RoleId): RoleSessionPolicy {
  return isBuiltInRole(role) ? ROLE_SESSION_POLICIES[role] : NEITHER;
}

export function allowedToolsFor(role: RoleId): string[] {
  return [...TEAM_TOOLS_ALLOWED, ...(sessionPolicyFor(role).readOnlyTools ? READ_ONLY_REVIEW_TOOLS : [])];
}

/** Whether the role's task sessions run in the task's own git worktree. */
export function usesWorktree(role: RoleId): boolean {
  return sessionPolicyFor(role).worktree;
}

/** Built-in roles that change files (developer, docs, maintainer, translator, content, designer). */
export const WORKTREE_ROLES: ReadonlySet<BuiltInRoleId> = new Set(
  (Object.keys(ROLE_SESSION_POLICIES) as BuiltInRoleId[]).filter(
    (role) => ROLE_SESSION_POLICIES[role].worktree,
  ),
);

/** Delay before a done task's sessions are stopped, so an in-flight tool result still reaches the agent. */
export const DONE_TASK_CLEANUP_DELAY_MS = 2_000;
