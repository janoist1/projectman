import type { StartSessionSpec } from '../contracts';

/**
 * Command line and inline settings for an interactive Claude Code session.
 *
 * Hooks: every event is an HTTP hook posting to /hooks/<token>, except SessionStart, which
 * Claude Code only supports as a command (or MCP tool) hook. For SessionStart a tiny command
 * forwards the hook payload (stdin) to the same URL: curl when available, otherwise the
 * server's own Node binary. Its output goes to /dev/null, because plain stdout of a
 * SessionStart hook would be added to Claude's context.
 */

/** HTTP hook events the runner listens to (all exist in Claude Code 2.1.223). */
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

/** Timeout (seconds) for hooks the runner answers immediately. */
const FAST_HOOK_TIMEOUT_S = 10;
/** Extra time Claude Code waits beyond our own permission timeout, so we always answer first. */
const PERMISSION_TIMEOUT_MARGIN_S = 30;
/** SessionEnd hooks share a small budget; this raises it slightly (max 60s). */
const SESSION_END_TIMEOUT_S = 3;

export interface HookSettingsInput {
  hookUrl: string;
  allowedTools: string[];
  permissionTimeoutMs: number;
  /** Node binary used when curl is missing (defaults to the running Node). */
  nodePath?: string;
}

interface HookHandler {
  type: 'http' | 'command';
  url?: string;
  command?: string;
  timeout: number;
}

export interface ClaudeSettings {
  permissions: { allow: string[] };
  hooks: Record<string, Array<{ hooks: HookHandler[] }>>;
}

/** Quotes a string for POSIX sh (single quotes). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Node fallback of the SessionStart forwarder. Reads the payload from stdin and POSTs it to
 * the URL given as the first argument. Contains no single quotes (it is single-quoted).
 */
const NODE_FORWARDER =
  'const u=process.argv[1];const c=[];process.stdin.on("data",(d)=>c.push(d));' +
  'process.stdin.on("end",()=>{const m=require(u.startsWith("https:")?"https":"http");' +
  'const r=m.request(u,{method:"POST",headers:{"content-type":"application/json"},timeout:10000},(s)=>s.resume());' +
  'r.on("error",()=>{});r.on("timeout",()=>r.destroy());r.end(Buffer.concat(c));});';

/** Shell command that forwards a hook payload (stdin) to `url`, printing nothing. */
export function forwarderCommand(url: string, nodePath: string = process.execPath): string {
  const curl =
    `curl -sS -m 10 -o /dev/null -X POST -H 'Content-Type: application/json' ` +
    `--data-binary @- ${shellQuote(url)}`;
  const node = `${shellQuote(nodePath)} -e ${shellQuote(NODE_FORWARDER)} ${shellQuote(url)}`;
  return `if command -v curl >/dev/null 2>&1; then ${curl}; else ${node}; fi >/dev/null 2>&1; exit 0`;
}

/** The `--settings` object: hooks for every event we need and pre-allowed tools. */
export function buildSettings(input: HookSettingsInput): ClaudeSettings {
  const permissionTimeoutS = Math.ceil(input.permissionTimeoutMs / 1000) + PERMISSION_TIMEOUT_MARGIN_S;
  const http = (timeout: number): HookHandler => ({ type: 'http', url: input.hookUrl, timeout });
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
    hooks[event] = [{ hooks: [http(timeout)] }];
  }
  // Rules pass through unchanged: both the server-level "mcp__team" and "mcp__team__*" are
  // valid allow rules for every tool of the team MCP server.
  return { permissions: { allow: [...new Set(input.allowedTools)] }, hooks };
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
  if (spec.model) args.push('--model', spec.model);
  if (spec.permissionMode) args.push('--permission-mode', spec.permissionMode);
  if (spec.displayName) args.push('-n', spec.displayName);
  return args;
}

/** Hook URL for a session token. */
export function hookUrlFor(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/hooks/${token}`;
}

/**
 * How to spawn the CLI: a JavaScript file (the fake CLI in tests) runs with the current
 * Node binary, so neither the executable bit nor PATH matters.
 */
export function resolveCommand(claudeBin: string, args: string[]): { file: string; args: string[] } {
  if (/\.(?:mjs|cjs|js)$/.test(claudeBin)) return { file: process.execPath, args: [claudeBin, ...args] };
  return { file: claudeBin, args };
}
