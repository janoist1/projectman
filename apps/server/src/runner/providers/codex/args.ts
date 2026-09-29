import type { StartSessionSpec } from '../../../contracts';
import { forwarderCommand } from '../../claude-args';
import { sanitizeMessage } from '../../typing';

/**
 * Command line of an interactive Codex session (codex-cli 0.159.1).
 *
 * Everything is set per process with `-c key=value` overrides (the value is TOML; the key is
 * split on every "."), so nothing is written to ~/.codex:
 * - hooks: command hooks for every event we follow, running the curl/Node forwarder that
 *   POSTs the payload to /hooks/<token> (Codex has no HTTP hooks). The PermissionRequest
 *   forwarder prints the answer, which Codex reads as the hook's decision.
 * - the team MCP server over Streamable HTTP, its tools pre-approved;
 * - the member's system prompt as `developer_instructions`;
 * - trust for the session's directory (as an inline table: a path in the key would be split
 *   at its dots), so the trust screen never shows;
 * - the project's CLAUDE.md as the fallback when a repository has no AGENTS.md;
 * - the sandbox and approval policy mapped from the member's permission mode.
 * `--dangerously-bypass-hook-trust` lets our hooks run without the one-time review in /hooks.
 */

/** Hook events the runner follows (all exist in codex-cli 0.159.1). */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'Interrupt',
  'SessionEnd',
] as const;

/** Timeout (seconds) of hooks the runner answers immediately. */
const FAST_HOOK_TIMEOUT_S = 10;
/** Extra time Codex waits beyond our own permission timeout, so we always answer first. */
const PERMISSION_TIMEOUT_MARGIN_S = 30;

/** `text` with lone surrogates (not valid in TOML) replaced by U+FFFD. */
function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/** A TOML basic string. Control characters are escaped, lone surrogates replaced. */
export function tomlString(value: string): string {
  let out = '"';
  for (const ch of wellFormed(value)) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** A TOML inline value: strings, finite numbers, booleans, arrays and inline tables. */
export function tomlValue(value: unknown): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`not representable in TOML: ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${tomlKey(k)}=${tomlValue(v)}`).join(',')}}`;
  }
  throw new Error(`not representable in TOML: ${String(value)}`);
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** One `-c` override. */
export function override(key: string, value: unknown): string {
  return `${key}=${tomlValue(value)}`;
}

export interface CodexPermissions {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  approval: 'on-request' | 'never';
}

/**
 * Claude Code permission mode -> Codex sandbox and approval policy. Codex reads files and runs
 * commands inside its sandbox without asking; anything the sandbox does not allow (writes where
 * it may not write, network) is an escalation request, which reaches the PermissionRequest hook
 * and so the inbox. With "never" nothing is asked: what the sandbox does not allow fails.
 *
 * - default: read-only + on-request. Reading is free, every edit and write is asked (like
 *   Claude Code asking before edits and commands).
 * - acceptEdits, auto: workspace-write + on-request. Edits and commands inside the workspace
 *   run; network and writes elsewhere are asked. (Codex has no classifier mode that reports to
 *   us, so auto behaves like acceptEdits.)
 * - plan: read-only + never. Research only; nothing is ever asked or written.
 * - bypassPermissions: danger-full-access + never. No sandbox, no questions.
 */
export function codexPermissions(mode: string | undefined): CodexPermissions {
  switch (mode) {
    case 'acceptEdits':
    case 'auto':
      return { sandbox: 'workspace-write', approval: 'on-request' };
    case 'plan':
      return { sandbox: 'read-only', approval: 'never' };
    case 'bypassPermissions':
      return { sandbox: 'danger-full-access', approval: 'never' };
    default:
      return { sandbox: 'read-only', approval: 'on-request' };
  }
}

/**
 * Claude model names and aliases, which Codex would reject. A Codex member without a Codex
 * model uses Codex's default (what the owner picked in Codex, or Codex's own default).
 */
const CLAUDE_MODEL =
  /^(?:default|best|opus|sonnet|haiku|fable|opusplan)(?:\[1m\])?$|^claude|^anthropic|opus|sonnet|haiku|fable|\[1m\]/i;

export function codexModel(model: string | undefined): string | null {
  const m = model?.trim();
  if (!m || CLAUDE_MODEL.test(m)) return null;
  return m;
}

/** The team server's tool approvals, from the session's allow rules (e.g. "mcp__team__*"). */
export function teamToolApprovals(allowedTools: string[]): {
  all: boolean;
  tools: string[];
} {
  let all = false;
  const tools: string[] = [];
  for (const rule of allowedTools) {
    if (rule === 'mcp__team' || rule === 'mcp__team__*') all = true;
    else {
      const m = /^mcp__team__([A-Za-z0-9_-]+)$/.exec(rule);
      if (m) tools.push(m[1]!);
    }
  }
  return { all, tools: [...new Set(tools)] };
}

export interface CodexArgsInput {
  spec: StartSessionSpec;
  /** POST target of the hooks. */
  hookUrl: string;
  permissionTimeoutMs: number;
  /** The session's directory, resolved (Codex looks its trust up by the resolved path). */
  realCwd: string;
  /** Node binary used when curl is missing (defaults to the running Node). */
  nodePath?: string;
}

/** The `hooks` value of one event. */
export function hookGroups(command: string, timeoutS: number): unknown {
  return [{ hooks: [{ type: 'command', command, timeout: timeoutS }] }];
}

/** Full argument list for `codex` (interactive TUI). */
export function buildCodexArgs(input: CodexArgsInput): string[] {
  const { spec, hookUrl } = input;
  const permissionTimeoutS = Math.ceil(input.permissionTimeoutMs / 1000) + PERMISSION_TIMEOUT_MARGIN_S;
  const args: string[] = [];
  if (spec.resume) args.push('resume');
  args.push('--no-alt-screen', '--no-daemon', '--dangerously-bypass-hook-trust', '--enable', 'hooks');
  const c = (key: string, value: unknown) => args.push('-c', override(key, value));

  c('check_for_update_on_startup', false);
  c('projects', { [input.realCwd]: { trust_level: 'trusted' } });
  c('project_doc_fallback_filenames', ['CLAUDE.md']);
  if (spec.appendSystemPrompt) c('developer_instructions', spec.appendSystemPrompt);

  const approvals = teamToolApprovals(spec.allowedTools);
  const team: Record<string, unknown> = { url: spec.mcpUrl };
  if (approvals.all) team.default_tools_approval_mode = 'approve';
  if (approvals.tools.length > 0) {
    team.tools = Object.fromEntries(approvals.tools.map((t) => [t, { approval_mode: 'approve' }]));
  }
  c('mcp_servers.team', team);

  for (const event of CODEX_HOOK_EVENTS) {
    const decides = event === 'PermissionRequest';
    const timeoutS = decides ? permissionTimeoutS : FAST_HOOK_TIMEOUT_S;
    const command = forwarderCommand(hookUrl, input.nodePath, {
      printResponse: decides,
      maxTimeS: timeoutS,
    });
    c(`hooks.${event}`, hookGroups(command, timeoutS));
  }

  const permissions = codexPermissions(spec.permissionMode);
  if (permissions.sandbox === 'danger-full-access') c('notice.hide_full_access_warning', true);
  args.push('--sandbox', permissions.sandbox, '--ask-for-approval', permissions.approval);
  const model = codexModel(spec.model);
  if (model) args.push('--model', model);

  const positional: string[] = [];
  if (spec.resume) positional.push(spec.claudeSessionId);
  // Sanitised like a typed message: no control characters, no leading "!" (shell mode).
  const prompt = sanitizeMessage(spec.initialMessage ?? '');
  if (prompt) positional.push(prompt);
  if (positional.length > 0) args.push('--', ...positional);
  return args;
}
