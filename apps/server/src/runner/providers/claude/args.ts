import type { AgentSandbox, StartSessionSpec } from '../../../contracts';
import { FAST_HOOK_TIMEOUT_S, forwarderCommand, permissionHookTimeoutS } from '../../hook-forwarder';
import { claudeBuiltinTools, claudeToolRules, directoryRulePaths } from './policy';

/**
 * Command line and inline settings for an interactive Claude Code session.
 *
 * Hooks: every event is an HTTP hook posting to /hooks/<token>, except SessionStart, which
 * Claude Code only supports as a command (or MCP tool) hook. For SessionStart the forwarder
 * (hook-forwarder.ts) posts the hook payload (stdin) to the same URL and prints nothing.
 * A sandboxed session uses the forwarder for every event: there Claude Code 2.1.284 sends
 * HTTP hooks through the sandbox's network proxy and gets 403 back, so the runner would see
 * none of them, while the forwarder (curl --noproxy) reaches the server.
 */

/** HTTP hook events the runner listens to (all exist in Claude Code 2.1.223); forwarded when sandboxed. */
export const HTTP_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
  // Names the subagent's own transcript, whose token usage is read then (PM-178).
  'SubagentStop',
] as const;

/**
 * PreToolUse waits for the inbox to take a question tool's call (PM-199), which reads the
 * configuration and writes to SQLite: a busy machine needs more than the fast hooks' 10 s, and a
 * hook that runs out lets the CLI show its dialog over a session that thinks it is working.
 */
const QUESTION_HOOK_TIMEOUT_S = 30;

/** SessionEnd hooks share a small budget; this raises it slightly (max 60s). */
const SESSION_END_TIMEOUT_S = 3;

export interface HookSettingsInput {
  hookUrl: string;
  allowedTools: string[];
  deniedTools?: string[];
  policy?: StartSessionSpec['policy'];
  permissionTimeoutMs: number;
  /** Node binary used when curl is missing (defaults to the running Node). */
  nodePath?: string;
  /** Runs the shell commands in Claude Code's sandbox. */
  sandbox?: AgentSandbox;
}

/** Claude Code's `sandbox` settings (Claude Code 2.1.219 or later, probed with 2.1.284). */
export interface ClaudeSandboxSettings {
  enabled: true;
  /** Sandboxed commands run without a permission prompt. */
  autoAllowBashIfSandboxed: true;
  /** A command that fails in the sandbox is not retried outside it (strict mode). */
  allowUnsandboxedCommands: false;
  /** No sandbox, no session: never a silent fallback to unsandboxed commands. */
  failIfUnavailable: true;
  filesystem: { allowWrite: string[]; denyWrite?: string[]; denyRead?: string[]; allowRead?: string[] };
  network: { allowedDomains: string[]; strictAllowlist: true; allowLocalBinding: boolean };
  /** Environment variables unset for sandboxed commands (`mode: "deny"`, PM-153). */
  credentials?: { envVars: Array<{ name: string; mode: 'deny' }> };
  /**
   * Command patterns run outside the sandbox (`gh pr view:*`), asked or allowed by the permission
   * rules as any other; see `excludedCommandPattern`.
   */
  excludedCommands?: string[];
}

interface HookHandler {
  type: 'http' | 'command';
  url?: string;
  command?: string;
  timeout: number;
}

/**
 * Claude Code's `autoMode` settings (prose the auto mode's classifier reads, Claude Code docs
 * "auto-mode-config"; `$defaults` keeps the built-in entries). It only steers the classifier: the
 * deny rules are what hold, in every mode (PM-165).
 */
export interface ClaudeAutoModeSettings {
  environment: string[];
  hard_deny: string[];
}

export const AUTO_MODE_SETTINGS: ClaudeAutoModeSettings = {
  environment: [
    '$defaults',
    "This is a development machine of an AI team's member. The work is done in the task's own working directory; the repository is local-only and nothing is published from it.",
  ],
  hard_deny: [
    '$defaults',
    'Never publish: no git push, no gh pr create, no gh pr merge, whatever the target.',
    "Never read or copy credential files (SSH keys, the GitHub CLI's configuration, the login and settings files of Claude Code and Codex, .npmrc) or the data of the live projectman instance (its database, secret, logs and customization).",
    'Never call the live projectman instance on localhost port 4800.',
  ],
};

export interface ClaudeSettings {
  permissions: { allow: string[]; deny?: string[] };
  autoMode?: ClaudeAutoModeSettings;
  hooks: Record<string, Array<{ hooks: HookHandler[] }>>;
  sandbox?: ClaudeSandboxSettings;
  /** Environment variables Claude Code sets for the session and its commands (the sandbox's `env`, PM-193). */
  env?: Record<string, string>;
  /** Claude Code's own auto memory is off: the team keeps its memory in projectman (PM-208). */
  autoMemoryEnabled: false;
  /**
   * No skills that ship with Claude Code (dataviz, loop, schedule, claude-api, the artifact skills...):
   * their list with the descriptions is read in every step and a member uses none (PM-221).
   */
  disableBundledSkills: true;
  /** The owner's claude.ai account skills (synced, named `anthropic-skills:<name>`), each hidden from the model and the user. */
  skillOverrides: Record<string, 'off'>;
  /** Managed VM profile: no first-use confirmation of the bypass mode (it would wait in the terminal). */
  skipDangerousModePermissionPrompt?: true;
}

/** Whether the policy asks for the managed VM profile (PM-141): the question-free start. */
export function isManagedVm(policy: StartSessionSpec['policy']): boolean {
  return policy?.execution?.profile === 'managed_vm';
}

/**
 * The sandbox settings for `sandbox`. The settings reference names `allowUnsandboxedCommands` a
 * string, but Claude Code 2.1.284 asks for every command given "deny"; the boolean works.
 */
export function buildSandboxSettings(sandbox: AgentSandbox): ClaudeSandboxSettings {
  const list = (key: 'denyWrite' | 'denyRead' | 'allowRead') =>
    sandbox[key]?.length ? { [key]: [...new Set(sandbox[key])] } : {};
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    filesystem: {
      allowWrite: [...sandbox.allowWrite],
      ...list('denyWrite'),
      ...list('denyRead'),
      ...list('allowRead'),
    },
    network: {
      allowedDomains: [...sandbox.allowedDomains],
      strictAllowlist: true,
      allowLocalBinding: sandbox.allowLocalBinding,
    },
    ...(sandbox.deniedEnvVars?.length
      ? {
          credentials: {
            envVars: [...new Set(sandbox.deniedEnvVars)].map((name) => ({ name, mode: 'deny' as const })),
          },
        }
      : {}),
    ...(sandbox.excludedCommands?.length
      ? { excludedCommands: [...new Set(sandbox.excludedCommands)].map(excludedCommandPattern) }
      : {}),
  };
}

/**
 * Deny rules for the built-in file tools on the sandbox's `denyWrite` paths (PM-167): the sandbox
 * binds only the shell, so `Edit` (which also covers `Write` and `NotebookEdit`) is denied there by
 * a rule, in every mode. A path is a directory (a reader's working directory) or a file (a shared
 * git directory's `HEAD`, PM-153), so both the path and everything below it are named. A path a
 * rule cannot name as it is refuses the start: it would stay writable for the file tools.
 */
export function denyWriteRules(sandbox: AgentSandbox | undefined): string[] {
  return (sandbox?.denyWrite ?? []).flatMap((target) => {
    const paths = directoryRulePaths(target);
    if (!paths)
      throw new Error(`Cannot keep ${JSON.stringify(target)} read-only with a rule; refusing to start.`);
    // `//<path>/**` takes everything below; the path itself too, for a file.
    return paths.flatMap((below) => [`Edit(${below.slice(0, -'/**'.length)})`, `Edit(${below})`]);
  });
}

/**
 * An `excludedCommands` entry: the command with any arguments (`gh pr view:*`). Claude Code 2.1.284
 * reads an entry without `:*` or `*` as the exact command, so a bare `gh pr view` never matched
 * `gh pr view 12` (PM-188). It leaves a command out of the sandbox only when every part of it
 * matches an entry and it has no substitution and no redirection into a file (`2>&1` is fine), so
 * a chain, a pipe, `$(...)` or `> file` around it stays inside (read in 2.1.284's code; the manual
 * run in docs/SANDBOX-PROBE.md checks it).
 */
export function excludedCommandPattern(command: string): string {
  return `${command}:*`;
}

/**
 * The skills synced from the owner's claude.ai account that Claude Code 2.1.284 lists (PM-221). They
 * come from the account, not from a plugin, so `enabledPlugins` does not reach them; a skill is
 * hidden by its name in `skillOverrides`. The list is of the skills seen on the owner's account: the
 * Skill tool is also left out of `--tools`, and the manual probe (`/context` of a fresh session)
 * shows whether a new account skill needs adding here.
 */
const ACCOUNT_SKILLS = [
  'docs',
  'docx',
  'google-workspace',
  'import-memory',
  'morning',
  'pdf',
  'pptx',
  'skill-creator',
  'xlsx',
] as const;

function accountSkillOverrides(): Record<string, 'off'> {
  return Object.fromEntries(ACCOUNT_SKILLS.map((name) => [`anthropic-skills:${name}`, 'off' as const]));
}

/** The `--settings` object: hooks for every event we need and pre-allowed tools. */
export function buildSettings(input: HookSettingsInput): ClaudeSettings {
  if (input.policy?.enforcement === 'strict')
    throw new Error('Strict Claude sandbox enforcement is not available yet; refusing to start.');
  const managed = isManagedVm(input.policy);
  if (
    managed &&
    (input.policy!.permissions.approval !== 'never' ||
      !['bypassPermissions', 'plan'].includes(input.policy!.permissions.claude))
  )
    throw new Error('The managed VM profile asks nothing locally; refusing a policy that does.');
  // The managed VM profile keeps no inner limits: the legacy tool rules, the denied operations and
  // the PM-134 sandbox stay out (the boundary is outside the CLI). Only the team tools are named,
  // which a research-only (`plan`) member still needs to answer.
  const rules = managed
    ? claudeToolRules({
        tools: { team: input.policy!.tools.team, files: [], shell: [] },
        deniedOperations: [],
      })
    : input.policy
      ? claudeToolRules(input.policy)
      : { allow: input.allowedTools, deny: input.deniedTools ?? [] };
  const sandbox = managed ? undefined : input.sandbox;
  const deny = [...rules.deny, ...denyWriteRules(sandbox)];
  const permissionTimeoutS = permissionHookTimeoutS(input.permissionTimeoutMs);
  const handler = (timeout: number, decides: boolean): HookHandler =>
    sandbox
      ? {
          type: 'command',
          command: forwarderCommand(input.hookUrl, input.nodePath, {
            printResponse: decides,
            maxTimeS: timeout,
          }),
          timeout,
        }
      : { type: 'http', url: input.hookUrl, timeout };
  const hooks: ClaudeSettings['hooks'] = {
    SessionStart: [
      {
        hooks: [
          {
            type: 'command',
            command: forwarderCommand(input.hookUrl, input.nodePath),
            timeout: FAST_HOOK_TIMEOUT_S,
          },
        ],
      },
    ],
  };
  for (const event of HTTP_HOOK_EVENTS) {
    const timeout =
      event === 'PermissionRequest'
        ? permissionTimeoutS
        : event === 'PreToolUse'
          ? QUESTION_HOOK_TIMEOUT_S
          : event === 'SessionEnd'
            ? SESSION_END_TIMEOUT_S
            : FAST_HOOK_TIMEOUT_S;
    // A PreToolUse answer turns a question tool's call away (PM-199); every other one is empty.
    hooks[event] = [{ hooks: [handler(timeout, event === 'PermissionRequest' || event === 'PreToolUse')] }];
  }
  // Rules pass through unchanged: both the server-level "mcp__team" and "mcp__team__*" are
  // valid allow rules for every tool of the team MCP server.
  return {
    permissions: {
      allow: [...new Set(rules.allow)],
      ...(deny.length ? { deny: [...new Set(deny)] } : {}),
    },
    // The managed VM profile keeps no inner limits, the classifier's guidance included.
    ...(managed ? {} : { autoMode: AUTO_MODE_SETTINGS }),
    hooks,
    autoMemoryEnabled: false,
    disableBundledSkills: true,
    skillOverrides: accountSkillOverrides(),
    ...(sandbox ? { sandbox: buildSandboxSettings(sandbox) } : {}),
    ...(sandbox?.env && Object.keys(sandbox.env).length > 0 ? { env: { ...sandbox.env } } : {}),
    ...(managed && input.policy!.permissions.claude === 'bypassPermissions'
      ? { skipDangerousModePermissionPrompt: true as const }
      : {}),
  };
}

/** The `--mcp-config` object: the team tools server of this session. */
export function buildMcpConfig(mcpUrl: string): { mcpServers: { team: { type: 'http'; url: string } } } {
  return { mcpServers: { team: { type: 'http', url: mcpUrl } } };
}

/** A subagent as Claude Code's `--agents` takes it. */
export interface ClaudeAgentDefinition {
  description: string;
  prompt: string;
  tools: string[];
  model: string;
}

/**
 * The `--agents` object: the session's subagents by name. Deliberately without `permissionMode`,
 * `mcpServers` and `hooks` (PM-179): the subagent works within the session's own rules, sandbox
 * and hooks, never with more.
 */
export function buildAgents(subagents: StartSessionSpec['subagents']): Record<string, ClaudeAgentDefinition> {
  const agents: Record<string, ClaudeAgentDefinition> = {};
  for (const { name, description, prompt, tools, model } of subagents ?? []) {
    agents[name] = { description, prompt, tools: [...tools], model };
  }
  return agents;
}

/** Full argument list for `claude` (interactive). */
export function buildClaudeArgs(spec: StartSessionSpec, settings: ClaudeSettings): string[] {
  const args: string[] = [];
  if (spec.resume) args.push('--resume', spec.claudeSessionId);
  else args.push('--session-id', spec.claudeSessionId);
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt);
  args.push('--mcp-config', JSON.stringify(buildMcpConfig(spec.mcpUrl)));
  // Every session reaches only the team server of its own `--mcp-config` (PM-208): the strict flag
  // leaves out the owner's claude.ai connectors (Gmail, Drive, Calendar, ClickUp...) and the
  // `.mcp.json` of user and project, and `--no-chrome` keeps Claude in Chrome (the owner's logged-in
  // browser) out. Both are the same on a new and on a resumed session.
  args.push('--strict-mcp-config', '--no-chrome');
  // Only the built-in tools the role needs (PM-221), the same on a new and on a resumed session. One
  // comma-separated value: the flag is variadic, so it must be followed by another flag, never a value.
  args.push('--tools', claudeBuiltinTools(spec.policy).join(','));
  // The managed VM's start is also protected from the project's own settings (PM-49); the user's
  // file is inspected before the start.
  if (isManagedVm(spec.policy)) args.push('--setting-sources', 'user');
  args.push('--settings', JSON.stringify(settings));
  if (spec.subagents?.length) args.push('--agents', JSON.stringify(buildAgents(spec.subagents)));
  const directories = spec.policy
    ? spec.policy.filesystem.readableRoots.filter((dir) => dir !== spec.cwd)
    : (spec.additionalDirectories ?? []);
  for (const dir of directories) args.push('--add-dir', dir);
  if (spec.model) args.push('--model', spec.model);
  if (spec.effort) args.push('--effort', spec.effort);
  const permissionMode = spec.policy?.permissions.claude ?? spec.permissionMode;
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (spec.displayName) args.push('-n', spec.displayName);
  return args;
}
