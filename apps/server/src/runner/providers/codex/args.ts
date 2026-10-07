import { modelForProvider, sessionPermissions } from '@projectman/shared';
import path from 'node:path';
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
 * - the local restricted-read permission profile and approval policy mapped from the member's
 *   permission mode; only managed VM sessions use legacy sandbox flags.
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
  cliPath?: string;
  codexHome?: string;
  disabledMcpServers?: readonly string[];
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

export const CODEX_PERMISSION_PROFILE = 'projectman';
export type CodexAccess = 'read' | 'write' | 'deny';
export interface CodexPermissionProfile {
  extends: ':read-only' | ':workspace';
  filesystem: Record<string, CodexAccess | Record<string, CodexAccess>>;
}

function insidePath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

/** The official standalone installation is the only read exception beneath denied homes. */
export type CodexCliReadRoot = { kind: 'none' } | { kind: 'root'; path: string } | { kind: 'misplaced' };

export function codexDeniedPaths(input: Pick<CodexArgsInput, 'spec' | 'codexHome'>): string[] {
  return [
    ...new Set([
      ...(input.spec.policy?.filesystem.deniedPaths ?? []),
      ...(input.codexHome ? [input.codexHome] : []),
    ]),
  ];
}

export function codexCliReadRoot(cliPath: string, denied: readonly string[]): CodexCliReadRoot {
  const paths = denied.filter((entry) => !/[*?\[\]]/.test(entry));
  if (!paths.some((entry) => insidePath(cliPath, entry))) return { kind: 'none' };
  let root = path.dirname(cliPath);
  while (path.dirname(root) !== root) {
    if (path.basename(root) === 'standalone' && path.basename(path.dirname(root)) === 'packages') {
      if (
        paths.some((entry) => root !== entry && insidePath(root, entry)) &&
        !paths.some((entry) => insidePath(entry, root))
      )
        return { kind: 'root', path: root };
      return { kind: 'misplaced' };
    }
    root = path.dirname(root);
  }
  return { kind: 'misplaced' };
}

/**
 * What `git add` and `git commit` write in a task worktree's git directories (PM-399): the shared
 * `objects`, `refs` and `logs`, and the worktree's own admin directory (`worktreeGitDir`: its index
 * and `HEAD`). Not the shared directory as a whole, and not another worktree's admin directory:
 * the host's git reads those outside the sandbox (a rewritten `commondir` or `config` runs a
 * program there, PM-131). These stay read-only inside the writable ones: the configuration and
 * the hooks, `objects/info` (alternates), the own admin directory's links (`commondir`, `gitdir`,
 * `config.worktree`), and the files of the integrating checkout (`AgentSandbox.denyWrite`,
 * `sharedGitDenials`). Nothing without both directories (an independent clone has its own `.git`).
 */
export function codexSharedGitAccess(
  policy: CodexArgsInput['spec']['policy'],
  denyWrite: readonly string[] = [],
): { writable: string[]; readOnly: string[] } {
  const placement = policy?.placement;
  const gitDir = placement?.kind === 'task_worktree' ? placement.gitDir : undefined;
  const adminDir = placement?.kind === 'task_worktree' ? placement.worktreeGitDir : undefined;
  if (!gitDir || !adminDir) return { writable: [], readOnly: [] };
  return {
    writable: [...['objects', 'refs', 'logs'].map((name) => path.join(gitDir, name)), adminDir],
    readOnly: [
      ...['config', 'config.lock', 'hooks', path.join('objects', 'info')].map((name) =>
        path.join(gitDir, name),
      ),
      ...['commondir', 'gitdir', 'config.worktree', 'hooks'].map((name) => path.join(adminDir, name)),
      ...denyWrite.filter((entry) => insidePath(entry, gitDir)),
    ],
  };
}

export function codexPermissionProfile(input: {
  sandbox: 'read-only' | 'workspace-write';
  deniedPaths: readonly string[];
  writableRoots: readonly string[];
  /** Paths inside a writable root that stay readable but not writable. */
  readOnlyPaths?: readonly string[];
  tmpDir?: string;
  cliPath?: string;
}): CodexPermissionProfile {
  const filesystem: CodexPermissionProfile['filesystem'] = { ':root': 'read' };
  const writes = input.sandbox === 'workspace-write';
  if (writes)
    filesystem[':workspace_roots'] = { '.': 'write', '.git': 'read', '.codex': 'read', '.agents': 'read' };
  if (writes) {
    for (const root of new Set([...input.writableRoots, ...(input.tmpDir ? [input.tmpDir] : [])]))
      if (!input.deniedPaths.some((denied) => insidePath(root, denied))) filesystem[root] = 'write';
    for (const readOnly of new Set(input.readOnlyPaths ?? []))
      if (!input.deniedPaths.some((denied) => insidePath(readOnly, denied))) filesystem[readOnly] = 'read';
    if (!input.tmpDir) {
      filesystem[':tmpdir'] = 'write';
      filesystem[':slash_tmp'] = 'write';
    }
  }
  for (const denied of new Set(input.deniedPaths)) filesystem[denied] = 'deny';
  const cliReadRoot = input.cliPath ? codexCliReadRoot(input.cliPath, input.deniedPaths) : null;
  if (cliReadRoot?.kind === 'root') filesystem[cliReadRoot.path] = 'read';
  return { extends: ':read-only', filesystem };
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
  // Project configuration must not install an unsandboxed notification command.
  c('notify', []);
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
    c('cli_auth_credentials_store', 'ephemeral');
    c('analytics.enabled', false);
    c('feedback.enabled', false);
  }
  // User plugins must never install tools outside a member's sandbox, for any Codex provider.
  for (const feature of [
    'plugins',
    'remote_plugin',
    'apps',
    'tool_suggest',
    'skill_mcp_dependency_install',
    'computer_use',
    'browser_use',
    'browser_use_external',
  ])
    c(`features.${feature}`, false);
  for (const name of input.disabledMcpServers ?? []) {
    if (!TOML_BARE_KEY.test(name) || name === 'team')
      throw new Error('Invalid user MCP server name; refusing to start.');
    c(`mcp_servers.${name}.enabled`, false);
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
  const writes = permissions.sandbox === 'workspace-write';
  // The commands' own temporary directory (PM-339): their TMPDIR and a writable root, while the
  // shared ones (`/tmp`, the CLI's TMPDIR) are closed. Only where the sandbox writes.
  const tmpDir = writes ? portable?.tmpDir : undefined;
  // A worktree's shared git directory (PM-399): without it `git add` / `git commit` fail with EPERM.
  const sharedGit = writes ? codexSharedGitAccess(spec.policy, spec.sandbox?.denyWrite) : undefined;
  const writableRoots = [
    ...(!spec.policy ? (spec.writableRoots ?? []) : []),
    ...(sharedGit?.writable ?? []),
    ...(portable?.allowWrite ?? []),
    ...(tmpDir ? [tmpDir] : []),
  ];
  if (!managed) {
    c('default_permissions', CODEX_PERMISSION_PROFILE);
    c(
      `permissions.${CODEX_PERMISSION_PROFILE}`,
      codexPermissionProfile({
        sandbox: writes ? 'workspace-write' : 'read-only',
        deniedPaths: codexDeniedPaths(input),
        writableRoots,
        readOnlyPaths: sharedGit?.readOnly ?? [],
        tmpDir,
        cliPath: input.cliPath,
      }),
    );
  }
  // Every command sees them, also one run outside the sandbox after a question.
  // The session folder and the browsers belong to a writing sandbox: a read-only one has no folder.
  const folderVariables = ['PROJECTMAN_SESSION_DIR', 'PLAYWRIGHT_BROWSERS_PATH'];
  const shellEnv = {
    ...Object.fromEntries(
      Object.entries(portable?.env ?? {}).filter(([name]) => writes || !folderVariables.includes(name)),
    ),
    ...(tmpDir ? { TMPDIR: tmpDir } : {}),
  };
  for (const [name, value] of Object.entries(shellEnv))
    if (TOML_BARE_KEY.test(name)) c(`shell_environment_policy.set.${name}`, value);
  // The built-in image viewer (not a sandboxed command, so it asks nothing) opens the session folder's images.
  if (writes && portable?.env['PROJECTMAN_SESSION_DIR']) c('tools.view_image', true);
  if (managed) args.push('--sandbox', permissions.sandbox);
  args.push('--ask-for-approval', permissions.approval);
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
