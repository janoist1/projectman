import type { AgentSandbox, StartSessionSpec } from '../../../contracts';
import { FAST_HOOK_TIMEOUT_S, forwarderCommand, permissionHookTimeoutS } from '../../hook-forwarder';
import { claudeToolRules, directoryRulePaths } from './policy';

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
    ...(sandbox.excludedCommands?.length
      ? { excludedCommands: [...new Set(sandbox.excludedCommands)].map(excludedCommandPattern) }
      : {}),
  };
}

/**
 * Deny rules for the built-in file tools on the sandbox's `denyWrite` directories (PM-167): the
 * sandbox binds only the shell, so `Edit` (which also covers `Write` and `NotebookEdit`) is denied
 * there by a rule, in every mode. A path a rule cannot name as it is refuses the start: it would
 * leave the directory writable for the file tools.
 */
export function denyWriteRules(sandbox: AgentSandbox | undefined): string[] {
  return (sandbox?.denyWrite ?? []).flatMap((dir) => {
    const paths = directoryRulePaths(dir);
    if (!paths)
      throw new Error(`Cannot keep ${JSON.stringify(dir)} read-only with a rule; refusing to start.`);
    return paths.map((path) => `Edit(${path})`);
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
    ...(sandbox ? { sandbox: buildSandboxSettings(sandbox) } : {}),
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
  // The managed VM's start is protected (PM-49): only the team server of this session, and no
  // settings of the project's own files; the user's file is inspected before the start.
  if (isManagedVm(spec.policy)) args.push('--strict-mcp-config', '--setting-sources', 'user');
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
