import { modelForProvider, sessionPermissions } from '@projectman/shared';
import type { StartSessionSpec } from '../../../contracts';
import { FAST_HOOK_TIMEOUT_S, forwarderCommand, permissionHookTimeoutS } from '../../hook-forwarder';
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

/** A TOML bare key: a name outside it cannot be a segment of a `-c` key (the key is split on dots). */
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function tomlKey(key: string): string {
  return TOML_BARE_KEY.test(key) ? key : tomlString(key);
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
 * - bypassPermissions: read as acceptEdits, never as `danger-full-access` + `never` (decision 19).
 *   Codex does not enforce denied tools, so without its sandbox and its questions nothing would
 *   stop a push from a local-only repository. The configuration refuses this mode for Codex
 *   members; this is the last line of defence should one reach the runner anyway.
 */
export function codexPermissions(mode: string | undefined): CodexPermissions {
  const { sandbox, approval } = sessionPermissions(mode);
  return { sandbox, approval };
}

/** Default reasoning effort for Codex members (overrides the owner's interactive default). */
export const DEFAULT_CODEX_EFFORT = 'medium';

export function codexModel(model: string | undefined): string {
  return modelForProvider('codex', model?.trim());
}

export interface CodexArgsInput {
  provider?: CodexModelProvider;
  spec: StartSessionSpec;
  /** POST target of the hooks. */
  hookUrl: string;
  permissionTimeoutMs: number;
  /** The session's directory, resolved (Codex looks its trust up by the resolved path). */
  realCwd: string;
  /** Node binary used when curl is missing (defaults to the running Node). */
  nodePath?: string;
}

export interface CodexModelProvider {
  id: 'nanogpt';
  name: string;
  baseUrl: string;
  envKey: string;
  wireApi: 'responses';
}

export const NANOGPT_CODEX_PROVIDER: CodexModelProvider = {
  id: 'nanogpt',
  name: 'NanoGPT',
  baseUrl: 'https://nano-gpt.com/api/v1',
  envKey: 'NANOGPT_API_KEY',
  wireApi: 'responses',
};

/** The `hooks` value of one event. */
export function hookGroups(command: string, timeoutS: number): unknown {
  return [{ hooks: [{ type: 'command', command, timeout: timeoutS }] }];
}

export interface CodexCommandLine {
  args: string[];
  /** A non-empty kick-off brief went on the command line (new and resumed sessions). */
  initialMessageSent: boolean;
}

/** Full argument list for `codex` (interactive TUI). */
export function buildCodexArgs(input: CodexArgsInput): CodexCommandLine {
  const { spec, hookUrl } = input;
  if (spec.policy?.enforcement === 'strict')
    throw new Error('Strict Codex sandbox enforcement is not available yet; refusing to start.');
  const permissionTimeoutS = permissionHookTimeoutS(input.permissionTimeoutMs);
  const args: string[] = [];
  if (spec.resume) args.push('resume');
  args.push('--no-alt-screen', '--no-daemon', '--dangerously-bypass-hook-trust', '--enable', 'hooks');
  const c = (key: string, value: unknown) => args.push('-c', override(key, value));

  c('check_for_update_on_startup', false);
  if (input.provider) {
    const p = input.provider;
    c('model_provider', p.id);
    c(`model_providers.${p.id}`, {
      name: p.name,
      base_url: p.baseUrl,
      env_key: p.envKey,
      wire_api: p.wireApi,
    });
    c('shell_environment_policy.exclude', [p.envKey]);
  }
  c('projects', { [input.realCwd]: { trust_level: 'trusted' } });
  c('project_doc_fallback_filenames', ['CLAUDE.md']);
  if (spec.appendSystemPrompt) c('developer_instructions', spec.appendSystemPrompt);

  // Never infer a Codex grant from another provider's tool syntax.
  const approvals = spec.policy?.tools.team ?? { all: false, names: [] };
  const team: Record<string, unknown> = { url: spec.mcpUrl };
  if (approvals.all) team.default_tools_approval_mode = 'approve';
  if (approvals.names.length > 0) {
    team.tools = Object.fromEntries(approvals.names.map((t) => [t, { approval_mode: 'approve' }]));
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

  const managed = spec.policy?.execution?.profile === 'managed_vm';
  const permissions = spec.policy?.permissions ?? codexPermissions(spec.permissionMode);
  // The managed VM's boundary is outside the CLI: no local approval, no inner sandbox. `plan`
  // stays research-only (`read-only`); nothing in this profile is ever the legacy `workspace-write`.
  if (managed && permissions.approval !== 'never')
    throw new Error('The managed VM profile asks nothing locally; refusing a policy that does.');
  if (managed && permissions.sandbox === 'workspace-write')
    throw new Error('The managed VM profile has no inner sandbox; refusing a workspace-write policy.');
  if (!managed && permissions.sandbox === 'danger-full-access')
    throw new Error('Codex runs without its sandbox only in the managed VM profile; refusing to start.');
  // What our sandbox shares with Codex's own (the heavy-run queue folder, PM-346). Not in the managed VM.
  const portable = managed ? undefined : spec.sandbox?.portable;
  const writableRoots = [
    ...(!spec.policy ? (spec.writableRoots ?? []) : []),
    ...(portable?.allowWrite ?? []),
  ];
  if (permissions.sandbox === 'workspace-write' && writableRoots.length > 0)
    c('sandbox_workspace_write.writable_roots', [...new Set(writableRoots)]);
  // Every command sees them, also one run outside the sandbox after a question.
  for (const [name, value] of Object.entries(portable?.env ?? {}))
    if (TOML_BARE_KEY.test(name)) c(`shell_environment_policy.set.${name}`, value);
  args.push('--sandbox', permissions.sandbox, '--ask-for-approval', permissions.approval);
  args.push('--model', modelForProvider(input.provider?.id ?? 'codex', spec.model));
  c('model_reasoning_effort', spec.effort === 'max' ? 'xhigh' : (spec.effort ?? DEFAULT_CODEX_EFFORT));

  const positional: string[] = [];
  if (spec.resume) positional.push(spec.claudeSessionId);
  // Sanitised like a typed message: no control characters, no leading "!" (shell mode).
  const prompt = sanitizeMessage(spec.initialMessage ?? '');
  if (prompt) positional.push(prompt);
  if (positional.length > 0) args.push('--', ...positional);
  return { args, initialMessageSent: prompt.length > 0 };
}
