import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openConfined } from './transcript/confined';
import type { AgentProvider } from '@projectman/shared';
import { WORKSPACE_CODEX_CONFIG, type AmbientConfigLocations } from '../contracts';

/** The version a CLI prints for `--version` ("2.1.284 (Claude Code)", "codex-cli 0.159.1"), or null. */
export function parseCliVersion(output: string): string | null {
  return /(?:^|[^\w.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\w.])/.exec(output)?.[1] ?? null;
}

/** An override-capable setting found where the protected start does not want one. */
export interface AmbientIssue {
  file: string;
  /** Names of the settings (never their values: an `env` entry may hold a secret), or a problem. */
  keys: string[];
}

/** Roots of the Codex configuration tables and keys that change approval, sandbox, hooks or login. */
export const CODEX_OVERRIDING_ROOTS: ReadonlySet<string> = new Set([
  'approval_policy',
  'sandbox_mode',
  'sandbox_workspace_write',
  'default_permissions',
  'permissions',
  'hooks',
  'project_root_markers',
  'mcp_servers',
  'profile',
  'profiles',
  'features',
  'shell_environment_policy',
  'notify',
  'model_provider',
  'model_providers',
  'openai_base_url',
  'chatgpt_base_url',
  'forced_login_method',
]);

/** Configuration roots that can override the local restricted-read profile (PM-356). */
export const CODEX_SANDBOX_ROOTS: ReadonlySet<string> = new Set([
  'sandbox_mode',
  'sandbox_workspace_write',
  'default_permissions',
  'permissions',
  'profile',
  'profiles',
]);

/**
 * What a Codex start refuses beyond the sandbox roots (PM-1169): the owner's own hooks run outside
 * the sandbox, and `project_root_markers` moves where Codex loads project layers from.
 */
export const CODEX_START_ROOTS: ReadonlySet<string> = new Set([
  ...CODEX_SANDBOX_ROOTS,
  'hooks',
  'project_root_markers',
]);

/** Read a file if present, confined to regular files when a root is supplied. */
async function readIfPresent(file: string, confineTo?: string): Promise<string | null> {
  try {
    if (confineTo && file.startsWith(`${confineTo}/`)) {
      const handle = await openConfined(file, confineTo);
      try {
        return await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    }
    return await readFile(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ||
      (err as NodeJS.ErrnoException).code === 'ENOTDIR'
      ? null
      : '\u0000unreadable';
  }
}

/** Roots of the TOML tables and keys of a Codex configuration file, comments and values left out. */
function tomlRoots(text: string): Set<string> {
  const roots = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[\[?\s*("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)/.exec(line);
    const key = header ?? /^("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)\s*[.=]/.exec(line);
    if (key) {
      const root = key[1]!;
      // Escaped quoted roots require a full TOML parser to resolve. Fail closed instead.
      roots.add(root.includes('\\') ? root : root.replace(/^["']|["']$/g, ''));
    }
  }
  return roots;
}

/** Allowed project configuration roots; new Codex capabilities refuse by default (PM-357). */
const PROJECT_CODEX_ALLOWED_ROOTS: ReadonlySet<string> = new Set([
  'model',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'project_doc_max_bytes',
  'project_doc_fallback_filenames',
]);

type ProjectCodexRule = 'config' | 'member' | 'any';

/** Inspect every project layer from the closest git root to the canonical session directory. */
export async function inspectProjectCodex(input: {
  cwd: string;
  rule: ProjectCodexRule;
  confineTo?: string;
}): Promise<AmbientIssue[]> {
  const directories = [input.cwd];
  let root = input.cwd;
  for (let dir = input.cwd; ; dir = path.dirname(dir)) {
    try {
      await lstat(path.join(dir, '.git'));
      root = dir;
      break;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        return [{ file: path.join(dir, '.git'), keys: ['(unreadable)'] }];
    }
    if (path.dirname(dir) === dir) break;
  }
  for (let dir = input.cwd; dir !== root;) {
    dir = path.dirname(dir);
    directories.push(dir);
  }
  const issues: AmbientIssue[] = [];
  for (const directory of directories.reverse()) {
    const folder = path.join(directory, '.codex');
    let entries: string[];
    try {
      const info = await lstat(folder);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        issues.push({ file: folder, keys: ['(project codex folder)'] });
        continue;
      }
      entries = (await readdir(folder)).sort();
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        issues.push({ file: folder, keys: ['(unreadable)'] });
      continue;
    }
    if (input.rule === 'any' && entries.length)
      issues.push({ file: folder, keys: ['(project codex folder)'] });
    for (const entry of entries) {
      const file = path.join(folder, entry);
      if (input.rule === 'member' && entry !== 'config.toml') {
        issues.push({ file, keys: ['(not allowed)'] });
      } else if (entry === 'config.toml') {
        if (input.rule === 'member') {
          const text = await readIfPresent(file, input.confineTo ?? root);
          const keys =
            text === '\u0000unreadable'
              ? ['(unreadable)']
              : [...tomlRoots(text ?? '')].filter((key) => !PROJECT_CODEX_ALLOWED_ROOTS.has(key));
          if (keys.length) issues.push({ file, keys });
        } else {
          const issue = await codexConfigIssue(file, false, input.confineTo ?? root);
          if (issue) issues.push(issue);
        }
      } else if (entry === 'hooks.json') {
        issues.push({ file, keys: ['(hooks file)'] });
      }
    }
  }
  return issues;
}

/** A refusal containing only paths and key names, never configuration values. */
class WorkspaceCodexConfigError extends Error {
  readonly code = WORKSPACE_CODEX_CONFIG;
  readonly details: { provider: 'codex'; issues: AmbientIssue[] };

  constructor(issues: AmbientIssue[]) {
    super(
      `the session directory's own Codex configuration could run commands outside the sandbox: ${issues.map(({ file, keys }) => `${file} (${keys.join(', ')})`).join('; ')}`,
    );
    this.name = 'WorkspaceCodexConfigError';
    this.details = { provider: 'codex', issues };
  }
}

export async function assertCodexMemberWorkspace(cwd: string): Promise<void> {
  const issues = await inspectProjectCodex({ cwd: await realpath(cwd).catch(() => cwd), rule: 'member' });
  if (issues.length) throw new WorkspaceCodexConfigError(issues);
}

async function codexConfigIssue(
  file: string,
  everything: boolean,
  confineTo?: string,
  restrictedRoots: ReadonlySet<string> = CODEX_OVERRIDING_ROOTS,
): Promise<AmbientIssue | null> {
  const text = await readIfPresent(file, confineTo);
  if (text === null) return null;
  if (text === '\u0000unreadable') return { file, keys: ['(unreadable)'] };
  const roots = tomlRoots(text);
  // An administrator's file (managed config, requirements) is a rule over the CLI whatever it
  // says: any content in it counts. The user's and the project's file only when they set one of
  // the roots that change the start (Codex writes harmless bookkeeping there itself).
  const keys = everything
    ? text.trim()
      ? roots.size
        ? [...roots]
        : ['(administrator config)']
      : []
    : [...roots].filter((root) => root.includes('\\') || restrictedRoots.has(root));
  return keys.length > 0 ? { file, keys } : null;
}

/** The providers' real locations, from the environment the CLIs run in. */
function defaultLocations(env: NodeJS.ProcessEnv): Required<AmbientConfigLocations> {
  const home = env.HOME || os.homedir();
  return {
    claudeManaged: [],
    claudeUser: '',
    codexManaged: [
      '/etc/codex/config.toml',
      '/etc/codex/managed_config.toml',
      '/etc/codex/requirements.toml',
    ],
    codexUser: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
    codexPresenceRefused: [
      '/etc/codex/hooks.json',
      // macOS MDM-managed Codex preferences (`com.openai.codex`); other systems have none.
      ...(process.platform === 'darwin'
        ? [
            '/Library/Managed Preferences/com.openai.codex.plist',
            path.join('/Library/Managed Preferences', os.userInfo().username, 'com.openai.codex.plist'),
          ]
        : []),
    ],
  };
}

/**
 * Files whose presence alone refuses the start (hooks, MDM preferences): the content is never
 * read, an unreadable one refuses too. Includes the user's `hooks.json` beside their config.
 */
async function presenceIssues(where: Required<AmbientConfigLocations>): Promise<AmbientIssue[]> {
  const issues: AmbientIssue[] = [];
  const files = [path.join(path.dirname(where.codexUser), 'hooks.json'), ...where.codexPresenceRefused];
  for (const file of files) {
    try {
      await lstat(file);
      issues.push({
        file,
        keys: [file.endsWith('.plist') ? '(managed preferences)' : '(hooks file)'],
      });
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        issues.push({ file, keys: ['(unreadable)'] });
    }
  }
  return issues;
}

/** Only names are returned; a local profile must not compete with any loaded sandbox settings. */
export async function inspectCodexSandboxConfig(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  locations?: AmbientConfigLocations;
}): Promise<AmbientIssue[]> {
  const where = { ...defaultLocations(input.env), ...input.locations };
  const issues: Array<AmbientIssue | null> = [];
  for (const file of where.codexManaged) issues.push(await codexConfigIssue(file, true));
  for (const file of [where.codexUser, path.join(input.cwd, '.codex', 'config.toml')])
    issues.push(await codexConfigIssue(file, false, undefined, CODEX_START_ROOTS));
  issues.push(...(await presenceIssues(where)));
  return issues.filter((issue): issue is AmbientIssue => issue !== null);
}

interface CodexUserMcpServers {
  names: string[];
  unresolved: AmbientIssue[];
}

/** User MCP names only; ambiguous spellings cannot safely receive dotted CLI overrides. */
export async function inspectCodexMcpServers(input: { codexHome: string }): Promise<CodexUserMcpServers> {
  const file = path.join(input.codexHome, 'config.toml');
  const text = await readIfPresent(file);
  if (text === null) return { names: [], unresolved: [] };
  if (text === '\u0000unreadable') return { names: [], unresolved: [{ file, keys: ['(unreadable)'] }] };
  const names = new Set<string>();
  const problems = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Escaped roots may spell mcp_servers. Never include the raw line or its value in an issue.
    if ([...tomlRoots(line)].some((root) => root.includes('\\'))) {
      problems.add('(escaped config key)');
      continue;
    }
    const root = /^(?:\[\[?\s*)?(?:mcp_servers|"mcp_servers"|'mcp_servers')(?=\s*[.=\]])/.exec(line);
    if (!root) continue;
    if (line.startsWith('[[')) {
      problems.add('mcp_servers');
      continue;
    }
    const suffix = line.slice(root[0].length);
    const name = /^\s*\.\s*([A-Za-z0-9_-]+)\s*(?=[.\]=])/.exec(suffix)?.[1];
    if (!name || name === 'team') problems.add(name === 'team' ? 'mcp_servers.team' : 'mcp_servers');
    else names.add(name);
  }
  return {
    names: [...names],
    unresolved: problems.size ? [{ file, keys: [...problems] }] : [],
  };
}

/** Inspect Codex configuration that could override the protected start; report names only. */
export async function inspectAmbientConfig(input: {
  provider: AgentProvider;
  cwd: string;
  env: NodeJS.ProcessEnv;
  locations?: AmbientConfigLocations;
  /** NanoGPT refuses all project Codex files; other callers inspect configuration only. */
  projectFolder?: 'config' | 'any';
  /** Files below this root are read confined (see `readIfPresent`). */
  confineTo?: string;
}): Promise<AmbientIssue[]> {
  const where = { ...defaultLocations(input.env), ...input.locations };
  const issues: Array<AmbientIssue | null> = [];
  for (const file of where.codexManaged) issues.push(await codexConfigIssue(file, true));
  issues.push(await codexConfigIssue(where.codexUser, false, input.confineTo));
  issues.push(
    ...(await inspectProjectCodex({
      cwd: input.cwd,
      rule: input.projectFolder === 'any' ? 'any' : 'config',
      confineTo: input.confineTo,
    })),
  );
  issues.push(...(await presenceIssues(where)));
  return issues.filter((issue): issue is AmbientIssue => issue !== null);
}
