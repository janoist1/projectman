import type { AgentSandbox, StartSessionSpec } from '../../../contracts';
import { FAST_HOOK_TIMEOUT_S, forwarderCommand, permissionHookTimeoutS } from '../../hook-forwarder';
import { claudeToolRules } from './policy';

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
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
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
  filesystem: { allowWrite: string[] };
  network: { allowedDomains: string[]; strictAllowlist: true; allowLocalBinding: boolean };
}

interface HookHandler {
  type: 'http' | 'command';
  url?: string;
  command?: string;
  timeout: number;
}

export interface ClaudeSettings {
  permissions: { allow: string[]; deny?: string[] };
  hooks: Record<string, Array<{ hooks: HookHandler[] }>>;
  sandbox?: ClaudeSandboxSettings;
}

/**
 * The sandbox settings for `sandbox`. The settings reference names `allowUnsandboxedCommands` a
 * string, but Claude Code 2.1.284 asks for every command given "deny"; the boolean works.
 */
export function buildSandboxSettings(sandbox: AgentSandbox): ClaudeSandboxSettings {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
    filesystem: { allowWrite: [...sandbox.allowWrite] },
    network: {
      allowedDomains: [...sandbox.allowedDomains],
      strictAllowlist: true,
      allowLocalBinding: sandbox.allowLocalBinding,
    },
  };
}

/** The `--settings` object: hooks for every event we need and pre-allowed tools. */
export function buildSettings(input: HookSettingsInput): ClaudeSettings {
  if (input.policy?.enforcement === 'strict')
    throw new Error('Strict Claude sandbox enforcement is not available yet; refusing to start.');
  const rules = input.policy
    ? claudeToolRules(input.policy)
    : { allow: input.allowedTools, deny: input.deniedTools ?? [] };
  const permissionTimeoutS = permissionHookTimeoutS(input.permissionTimeoutMs);
  const handler = (timeout: number, decides: boolean): HookHandler =>
    input.sandbox
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
    hooks[event] = [{ hooks: [handler(timeout, event === 'PermissionRequest')] }];
  }
  // Rules pass through unchanged: both the server-level "mcp__team" and "mcp__team__*" are
  // valid allow rules for every tool of the team MCP server.
  return {
    permissions: {
      allow: [...new Set(rules.allow)],
      ...(rules.deny.length ? { deny: [...new Set(rules.deny)] } : {}),
    },
    hooks,
    ...(input.sandbox ? { sandbox: buildSandboxSettings(input.sandbox) } : {}),
  };
}

/** The `--mcp-config` object: the team tools server of this session. */
export function buildMcpConfig(mcpUrl: string): { mcpServers: { team: { type: 'http'; url: string } } } {
  return { mcpServers: { team: { type: 'http', url: mcpUrl } } };
}

/** Full argument list for `claude` (interactive). */
export function buildClaudeArgs(spec: StartSessionSpec, settings: ClaudeSettings): string[] {
  const args: string[] = [];
  if (spec.resume) args.push('--resume', spec.claudeSessionId);
  else args.push('--session-id', spec.claudeSessionId);
  if (spec.appendSystemPrompt) args.push('--append-system-prompt', spec.appendSystemPrompt);
  args.push('--mcp-config', JSON.stringify(buildMcpConfig(spec.mcpUrl)));
  args.push('--settings', JSON.stringify(settings));
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
