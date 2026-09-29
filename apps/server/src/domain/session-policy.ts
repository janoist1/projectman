import type { AiRole } from '@projectman/shared';

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

/** Extra pre-approved tools per role (in addition to the team tools). */
export const ROLE_ALLOWED_TOOLS: Partial<Record<AiRole, string[]>> = {
  code_review: READ_ONLY_REVIEW_TOOLS,
  security_review: READ_ONLY_REVIEW_TOOLS,
  qa: READ_ONLY_REVIEW_TOOLS,
};

export function allowedToolsFor(role: AiRole): string[] {
  return [...TEAM_TOOLS_ALLOWED, ...(ROLE_ALLOWED_TOOLS[role] ?? [])];
}

/** Roles that change code: their task sessions run in the task's own git worktree (when the task names a repo). */
export const WORKTREE_ROLES: ReadonlySet<AiRole> = new Set<AiRole>(['developer', 'docs']);

/** Delay before a done task's sessions are stopped, so an in-flight tool result still reaches the agent. */
export const DONE_TASK_CLEANUP_DELAY_MS = 2_000;
