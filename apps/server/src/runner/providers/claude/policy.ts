import type { DeniedSessionOperation, ShellToolRule } from '@projectman/shared';
import type { SessionPolicy } from '../../../contracts';

export function claudeShellRule(rule: ShellToolRule): string {
  return `Bash(${rule.command}${rule.arguments === 'prefix' ? ':*' : ''})`;
}
const operations: Record<DeniedSessionOperation, string> = {
  git_push: 'Bash(git push:*)',
  pull_request_create: 'Bash(gh pr create:*)',
  pull_request_merge: 'Bash(gh pr merge:*)',
};
const files = { read: 'Read', grep: 'Grep', glob: 'Glob' } as const;

/**
 * Characters a directory may hold to be named in a Claude Code path rule as it is: letters, marks and
 * digits of any script (an accented project path too, PM-188), `_ . / @ + ~ -` and the space; none of
 * the pattern or rule syntax (`* ? [ ] { } ( ) \`).
 */
const PLAIN_RULE_PATH = /^\/[\p{L}\p{M}\p{N}_./@+~ -]*$/u;

/** An absolute directory as a Claude Code rule path: `//dir/**` takes everything below it. */
function belowDirectory(dir: string): string {
  return `/${dir.replace(/\/+$/, '')}/**`;
}

/**
 * The rule paths of everything below an absolute directory, for `Read(...)` or `Edit(...)`; null
 * when a rule cannot name it as it is. An accented name is named both composed (NFC) and decomposed
 * (NFD, as macOS often hands it out): a rule matches the text it is given.
 */
export function directoryRulePaths(dir: string): string[] | null {
  if (!PLAIN_RULE_PATH.test(dir)) return null;
  return [...new Set([dir, dir.normalize('NFC'), dir.normalize('NFD')])].map(belowDirectory);
}

/** Deny rules for a path (a file or a directory) of the built-in file tools: reading and changing it. */
function denyFileRules(target: string): string[] {
  const path = `/${target.replace(/\/+$/, '')}`;
  return ['Read', 'Edit'].flatMap((tool) => [`${tool}(${path})`, `${tool}(${path}/**)`]);
}

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
export function claudeBuiltinTools(): string[] {
  return [...BUILTIN_TOOLS];
}

export function claudeToolRules(
  policy: Pick<SessionPolicy, 'tools' | 'deniedOperations'> & {
    filesystem?: Pick<
      SessionPolicy['filesystem'],
      'readOnlyPaths' | 'deniedPaths' | 'sessionFolder' | 'sessionFoldersRoot'
    >;
    network?: Pick<SessionPolicy['network'], 'deniedHosts'>;
  },
) {
  const readOnly = policy.filesystem?.readOnlyPaths ?? [];
  // The session folders (PM-268, PM-333): every member's is read, only its own is changed. No deny
  // rule for the root: a deny beats an allow, and would shut the session's own folder too. A path a
  // rule cannot name gets no rule, and the session is asked, as anywhere else outside its directories.
  const folderRoot = policy.filesystem?.sessionFoldersRoot;
  const folder = policy.filesystem?.sessionFolder;
  const rootPaths = (folderRoot && directoryRulePaths(folderRoot)) || [];
  const folderPaths = (folder && directoryRulePaths(folder)) || [];
  return {
    allow: [
      ...new Set([
        ...(policy.tools.team.all ? ['mcp__team__*'] : []),
        ...policy.tools.team.names.map((name) => `mcp__team__${name}`),
        ...policy.tools.files.map((name) => files[name]),
        ...policy.tools.shell.map(claudeShellRule),
        // Read without asking, never edit: not an extra working directory, whose files
        // acceptEdits would let it change.
        ...readOnly.map((dir) => `Read(${belowDirectory(dir)})`),
        ...rootPaths.map((p) => `Read(${p})`),
        ...folderPaths.flatMap((p) => [`Read(${p})`, `Edit(${p})`]),
      ]),
    ],
    deny: [
      ...policy.deniedOperations.map((name) => operations[name]),
      ...readOnly.map((dir) => `Edit(${belowDirectory(dir)})`),
      ...(policy.filesystem?.deniedPaths ?? []).flatMap(denyFileRules),
      ...(policy.network?.deniedHosts ?? []).map((host) => `WebFetch(domain:${host})`),
    ],
  };
}
