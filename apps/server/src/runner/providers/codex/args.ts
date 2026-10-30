import { modelForProvider, sessionPermissions, SessionReadBoundary } from '@projectman/shared';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import path from 'node:path';
import { toolPathForms, withoutFirmlink, pathPatternMatcher, isReadBoundaryPath } from '../../tool-decision';
import type { StartSessionSpec } from '../../../contracts';
import {
  FAST_HOOK_TIMEOUT_S,
  TOOL_PREPARE_HOOK_TIMEOUT_S,
  forwarderCommand,
  permissionHookTimeoutS,
} from '../../hook-forwarder';
import { mcpBridgeCommand } from '../../mcp-bridge';
import { sanitizeMessage } from '../../typing';

/**
 * Command line of an interactive Codex session (codex-cli 0.159.1).
 *
 * Everything is set per process with `-c key=value` overrides (the value is TOML; the key is
 * split on every "."), so nothing is written to ~/.codex:
 * - hooks: command hooks for every event we follow, running the curl/Node forwarder that
 *   POSTs the payload to /hooks/<token> (Codex has no HTTP hooks). The PermissionRequest
 *   forwarder prints the answer, which Codex reads as the hook's decision.
 * - the team MCP server through a stdio bridge to its Streamable HTTP route (`mcp-bridge.ts`), its
 *   tools pre-approved;
 * - the member's system prompt as `developer_instructions`;
 * - trust for the session's directory (as an inline table: a path in the key would be split
 *   at its dots), so the trust screen never shows;
 * - the project's CLAUDE.md as the fallback when a repository has no AGENTS.md;
 * - the local restricted-read permission profile and approval policy mapped from the member's
 *   permission mode.
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
function override(key: string, value: unknown): string {
  return `${key}=${tomlValue(value)}`;
}

interface CodexPermissions {
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
const DEFAULT_CODEX_EFFORT = 'medium';

export function codexModel(model: string | undefined): string {
  return modelForProvider('codex', model?.trim());
}

interface CodexArgsInput {
  cliPath?: string;
  codexHome?: string;
  disabledMcpServers?: readonly string[];
  provider?: CodexModelProvider;
  spec: StartSessionSpec;
  /** The private file holding the hooks' POST target (`writeHookConfig`, PM-156). */
  hookConfigPath: string;
  /** The private file holding the team MCP URL, read by the stdio bridge (`writeMcpBridgeConfig`, PM-1170). */
  mcpConfigPath: string;
  permissionTimeoutMs: number;
  /** The session's directory, resolved (Codex looks its trust up by the resolved path). */
  realCwd: string;
  /** Node binary used when curl is missing (defaults to the running Node). */
  nodePath?: string;
}

interface CodexModelProvider {
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
function hookGroups(command: string, timeoutS: number): unknown {
  return [{ hooks: [{ type: 'command', command, timeout: timeoutS }] }];
}

interface CodexCommandLine {
  args: string[];
  /** A non-empty kick-off brief went on the command line (new and resumed sessions). */
  initialMessageSent: boolean;
}

const CODEX_PERMISSION_PROFILE = 'projectman';
type CodexAccess = 'read' | 'write' | 'deny';
interface CodexPermissionProfile {
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
type CodexCliReadRoot = { kind: 'none' } | { kind: 'root'; path: string } | { kind: 'misplaced' };

function codexDeniedPaths(input: Pick<CodexArgsInput, 'spec' | 'codexHome'>): string[] {
  return [
    ...new Set([
      ...(input.spec.policy?.filesystem.deniedPaths ?? []),
      ...(input.codexHome ? [input.codexHome] : []),
    ]),
  ];
}

/** CLI placement is checked against both hard denials and reopenable roots. */
export function codexCliDenials(input: Pick<CodexArgsInput, 'spec' | 'codexHome'>): string[] {
  return [
    ...codexDeniedPaths(input),
    ...(input.spec.sandbox?.portable?.readBoundary?.deniedRoots ?? []),
  ].flatMap(pathForms);
}

function pathForms(target: string): string[] {
  return [
    ...new Set([path.normalize(target), ...toolPathForms('/', target, homedir())].map(withoutFirmlink)),
  ];
}

/** Hard denials cover descendants, including globbed file names and symlink targets. */
function pathDenials(denied: readonly string[]): (target: string) => boolean {
  const matches = pathPatternMatcher(denied.flatMap(pathForms), process.platform === 'darwin');
  return (target) => pathForms(target).some(matches);
}

export type ReadBoundaryProblem = 'missing' | 'invalid' | 'required_path_denied';

/** Local starts must fail closed too; RPC validation is not a substitute for this check. */
export function validateCodexReadBoundary(
  input: Pick<CodexArgsInput, 'spec' | 'codexHome'>,
): ReadBoundaryProblem | undefined {
  const { spec } = input;
  const raw = spec.sandbox?.portable?.readBoundary;
  if (raw === undefined) return;
  if (!spec.policy) return 'invalid';
  const parsed = SessionReadBoundary.safeParse(raw);
  if (!parsed.success) return 'invalid';
  const boundary = parsed.data;
  if (
    ![...boundary.deniedRoots, ...boundary.allowedPaths.map((entry) => entry.path)].every(isReadBoundaryPath)
  )
    return 'invalid';
  if (!boundary.deniedRoots.some((root) => pathForms(root).includes(pathForms(homedir()).at(-1)!)))
    return 'invalid';
  const hard = codexDeniedPaths(input);
  const hardDenied = pathDenials(hard);
  const required = [
    spec.cwd,
    ...(spec.policy.placement.kind === 'task_worktree' && spec.policy.placement.gitDir
      ? [spec.policy.placement.gitDir]
      : []),
  ];
  if (spec.policy.permissions.sandbox === 'workspace-write') {
    const portable = spec.sandbox?.portable;
    if (!portable?.tmpDir || !portable.env.PROJECTMAN_SESSION_DIR) return 'missing';
    if (['/tmp', '/private/tmp'].includes(portable.tmpDir)) return 'invalid';
    required.push(portable.tmpDir, portable.env.PROJECTMAN_SESSION_DIR);
    required.push(...codexSharedGitAccess(spec.policy, spec.sandbox?.denyWrite).writable);
  }
  if (required.some(hardDenied)) return 'required_path_denied';
  const homes = boundary.deniedRoots;
  const candidates = [
    spec.cwd,
    ...spec.policy.filesystem.readableRoots,
    ...(spec.policy.filesystem.readOnlyPaths ?? []),
    ...(spec.sandbox?.allowRead ?? []),
    ...(spec.sandbox?.portable?.allowWrite ?? []),
    ...required,
  ];
  if (
    boundary.allowedPaths.some((entry) => {
      if (hardDenied(entry.path)) return false;
      try {
        const stat = statSync(entry.path);
        if (entry.kind === 'file' ? !stat.isFile() : !stat.isDirectory()) return true;
      } catch {
        // Missing technical files and future directories retain their declared kind.
      }
      return (
        homes.some((root) =>
          pathForms(entry.path).some((candidate) =>
            pathForms(root).some((home) => insidePath(home, candidate)),
          ),
        ) ||
        /\/member-caches(?:\/[^/]+){0,2}$/.test(entry.path) ||
        !candidates.some((candidate) =>
          pathForms(entry.path).every((form) => pathForms(candidate).includes(form)),
        )
      );
    })
  )
    return 'invalid';
  if (
    required.some(
      (target) =>
        !boundary.allowedPaths.some(
          (entry) =>
            entry.kind === 'directory' &&
            pathForms(target).every((form) => pathForms(entry.path).some((root) => insidePath(form, root))),
        ),
    )
  )
    return 'required_path_denied';
}

export function codexCliReadRoot(cliPath: string, denied: readonly string[]): CodexCliReadRoot {
  if (pathDenials(denied.filter((entry) => /[*?\[\]]/.test(entry)))(cliPath)) return { kind: 'misplaced' };
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
 * `objects`, `refs` and `logs`, and only `packed-refs.lock` (PM-411: rebase pseudo-ref deletion),
 * and the worktree's own admin directory (`worktreeGitDir`: its index
 * and `HEAD`). Not the shared directory as a whole, and not another worktree's admin directory:
 * the host's git reads those outside the sandbox (a rewritten `commondir` or `config` runs a
 * program there, PM-131). These stay read-only inside the writable ones: the configuration and
 * the hooks, `objects/info` (alternates), the own admin directory's links (`commondir`, `gitdir`,
 * `config.worktree`), and the files of the integrating checkout (`AgentSandbox.denyWrite`,
 * `sharedGitDenials`), including `packed-refs` itself, except its lock above. Nothing without both directories
 * (an independent clone has its own `.git`).
 */
function codexSharedGitAccess(
  policy: CodexArgsInput['spec']['policy'],
  denyWrite: readonly string[] = [],
): { writable: string[]; readOnly: string[] } {
  const placement = policy?.placement;
  const gitDir = placement?.kind === 'task_worktree' ? placement.gitDir : undefined;
  const adminDir = placement?.kind === 'task_worktree' ? placement.worktreeGitDir : undefined;
  // An independent clone (a member workspace, PM-138) keeps its git directory inside the checkout, where
  // Codex makes `.git` read-only: open it the same way, with what the host's git would run or follow
  // outside the sandbox (configuration, hooks, alternates, and the `commondir` / `gitdir` links that
  // redirect git to a directory the session wrote, and the submodule directories under `modules` with
  // their own configuration) still closed. Only a member workspace counts as a clone: a placement
  // without a shared git directory and without that marker gets nothing.
  if (placement?.kind === 'task_worktree' && placement.workspace && !gitDir) {
    const ownGitDir = path.join(placement.path, '.git');
    return {
      writable: [ownGitDir],
      readOnly: [
        'config',
        'config.lock',
        'config.worktree',
        'commondir',
        'gitdir',
        'hooks',
        'modules',
        path.join('objects', 'info'),
      ].map((name) => path.join(ownGitDir, name)),
    };
  }
  if (!gitDir || !adminDir) return { writable: [], readOnly: [] };
  const packedRefsLock = path.join(gitDir, 'packed-refs.lock');
  return {
    writable: [
      ...['objects', 'refs', 'logs'].map((name) => path.join(gitDir, name)),
      packedRefsLock,
      adminDir,
    ],
    readOnly: [
      ...['config', 'config.lock', 'hooks', path.join('objects', 'info')].map((name) =>
        path.join(gitDir, name),
      ),
      ...['commondir', 'gitdir', 'config.worktree', 'hooks'].map((name) => path.join(adminDir, name)),
      // Only Codex lifts the lock denial; packed-refs and all other checkout protections stay.
      ...denyWrite.filter((entry) => insidePath(entry, gitDir) && entry !== packedRefsLock),
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
  readBoundary?: SessionReadBoundary;
}): CodexPermissionProfile {
  const filesystem: CodexPermissionProfile['filesystem'] = { ':root': 'read' };
  const hardDenied = pathDenials(input.deniedPaths);
  const grant = (target: string, access: CodexAccess) => {
    if (!hardDenied(target)) for (const form of pathForms(target)) filesystem[form] = access;
  };
  for (const root of input.readBoundary?.deniedRoots ?? [])
    for (const form of pathForms(root)) filesystem[form] = 'deny';
  for (const entry of input.readBoundary?.allowedPaths ?? []) grant(entry.path, 'read');
  const writes = input.sandbox === 'workspace-write';
  if (writes)
    filesystem[':workspace_roots'] = { '.': 'write', '.git': 'read', '.codex': 'read', '.agents': 'read' };
  if (writes) {
    for (const root of new Set([...input.writableRoots, ...(input.tmpDir ? [input.tmpDir] : [])]))
      grant(root, 'write');
    for (const readOnly of new Set(input.readOnlyPaths ?? [])) grant(readOnly, 'read');
    if (!input.tmpDir && !input.readBoundary) {
      filesystem[':tmpdir'] = 'write';
      filesystem[':slash_tmp'] = 'write';
    }
  }
  for (const denied of new Set(input.deniedPaths))
    for (const form of pathForms(denied)) filesystem[form] = 'deny';
  const cliReadRoot = input.cliPath
    ? codexCliReadRoot(
        input.cliPath,
        [...input.deniedPaths, ...(input.readBoundary?.deniedRoots ?? [])].flatMap(pathForms),
      )
    : null;
  if (cliReadRoot?.kind === 'root') filesystem[cliReadRoot.path] = 'read';
  return { extends: ':read-only', filesystem };
}

/** Full argument list for `codex` (interactive TUI). */
export function buildCodexArgs(input: CodexArgsInput): CodexCommandLine {
  const { spec, hookConfigPath } = input;
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
  // The team server stays optional (PM-1070): `required = true` (PM-1055) made Codex exit at start
  // ("agent CLI exited before it was ready") for every session, so a failing team MCP must only
  // cost the tools, not the session.
  // A stdio bridge reads the URL from the session's private file: the URL holds the session's
  // token and must not be on the command line (PM-1170).
  const team: Record<string, unknown> = { ...mcpBridgeCommand(input.mcpConfigPath, input.nodePath) };
  if (approvals.all) team.default_tools_approval_mode = 'approve';
  if (approvals.names.length > 0) {
    team.tools = Object.fromEntries(approvals.names.map((t) => [t, { approval_mode: 'approve' }]));
  }
  c('mcp_servers.team', team);

  for (const event of CODEX_HOOK_EVENTS) {
    const decides = event === 'PermissionRequest';
    const timeoutS = decides
      ? permissionTimeoutS
      : event === 'PreToolUse'
        ? TOOL_PREPARE_HOOK_TIMEOUT_S
        : FAST_HOOK_TIMEOUT_S;
    const command = forwarderCommand(hookConfigPath, input.nodePath, {
      printResponse: decides,
      maxTimeS: timeoutS,
    });
    c(`hooks.${event}`, hookGroups(command, timeoutS));
  }

  const permissions = spec.policy?.permissions ?? codexPermissions(spec.permissionMode);
  if (permissions.sandbox === 'danger-full-access')
    throw new Error('Codex requires its sandbox; refusing to start.');
  // What our sandbox shares with Codex's own (the heavy-run queue folder, PM-346).
  const portable = spec.sandbox?.portable;
  const writes = permissions.sandbox === 'workspace-write';
  // The commands' own temporary directory (PM-339): their TMPDIR and a writable root, while the
  // shared ones (`/tmp`, the CLI's TMPDIR) are closed. Only where the sandbox writes.
  const tmpDir = writes ? portable?.tmpDir : undefined;
  // A worktree's shared git directory (PM-399): without it `git add` / `git commit` fail with EPERM.
  const sharedGit = writes ? codexSharedGitAccess(spec.policy, spec.sandbox?.denyWrite) : undefined;
  const writableRoots = [
    ...(portable?.readBoundary ? [input.realCwd] : []),
    ...(!spec.policy ? (spec.writableRoots ?? []) : []),
    ...(sharedGit?.writable ?? []),
    ...(portable?.allowWrite ?? []),
    ...(tmpDir ? [tmpDir] : []),
  ];
  c('default_permissions', CODEX_PERMISSION_PROFILE);
  c(
    `permissions.${CODEX_PERMISSION_PROFILE}`,
    codexPermissionProfile({
      sandbox: writes ? 'workspace-write' : 'read-only',
      deniedPaths: codexDeniedPaths(input),
      writableRoots,
      readBoundary: portable?.readBoundary,
      readOnlyPaths: [
        ...(portable?.readBoundary
          ? ['.git', '.codex', '.agents']
              .map((name) => path.join(input.realCwd, name))
              .filter((entry) => !sharedGit?.writable.includes(entry))
          : []),
        ...(sharedGit?.readOnly ?? []),
        ...(portable?.readBoundary ? (spec.policy?.filesystem.readOnlyPaths ?? []) : []),
      ],
      tmpDir,
      cliPath: input.cliPath,
    }),
  );

  // Every command sees them, also one run outside the sandbox after a question.
  // The browsers belong to a writing sandbox. A read-only one still names the session folder (PM-522):
  // the server puts files there, and the sandbox reads it without writing it.
  const writeOnlyVariables = ['PLAYWRIGHT_BROWSERS_PATH'];
  const shellEnv = {
    ...Object.fromEntries(
      Object.entries(portable?.env ?? {}).filter(([name]) => writes || !writeOnlyVariables.includes(name)),
    ),
    ...(tmpDir ? { TMPDIR: tmpDir } : {}),
  };
  for (const [name, value] of Object.entries(shellEnv))
    if (TOML_BARE_KEY.test(name)) c(`shell_environment_policy.set.${name}`, value);
  // The built-in image viewer (not a sandboxed command, so it asks nothing) opens the session folder's
  // images; it respects the denied paths, and the read-only profile reads the folder (PM-522).
  if (portable?.env['PROJECTMAN_SESSION_DIR']) c('tools.view_image', true);
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
