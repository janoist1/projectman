import type { SessionPolicy } from '../../../contracts';

/**
 * The built-in Claude Code tools every member session gets (PM-221), and why each stays:
 * - Read, Edit, Write, Bash: the work itself. A reading role gets Edit and Write too (it had them
 *   before PM-221, and the prompts name them, e.g. for a file in `$TMPDIR`): what it must not change
 *   is kept by the deny rules and the sandbox (PM-167, PM-188), not by this list;
 * - TaskStop: ends a background command the session started;
 * - WebFetch, WebSearch: reading documentation (the network rules and the denied hosts limit them);
 * - Agent: the cheap subagent (PM-179);
 * - ToolSearch: the team tools are deferred, so without it they cannot be reached;
 * - AskUserQuestion: PM-199 forwards its call to the inbox's waiting list.
 * Everything else (artifacts, workflows, scheduling, messaging other Claude sessions, cron and remote
 * triggers, worktree and plan mode tools, notebooks...) is left out: a tool's description is paid
 * for in every step, and several of them act with the owner's account or reach their other sessions.
 */
const BUILTIN_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'TaskStop',
  'WebFetch',
  'WebSearch',
  'Agent',
  'ToolSearch',
  'AskUserQuestion',
] as const;

/**
 * The `--tools` list of a session: the built-in set it may use, the same for every role and profile.
 * MCP tools (the team server) are not part of `--tools`.
 */
export function claudeBuiltinTools(policy?: Pick<SessionPolicy, 'teamToolsOnly'>): string[] {
  // Team tools alone (PM-475): the team tools are deferred, so ToolSearch is the one built-in tool left.
  return policy?.teamToolsOnly ? ['ToolSearch'] : [...BUILTIN_TOOLS];
}
