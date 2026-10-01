import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateManagedVmActivation,
  MANAGED_VM_PROVIDER_VERSIONS,
  VmReadinessReport,
} from '@projectman/shared';
import type { AgentProvider } from '@projectman/shared';
import {
  MANAGED_VM_UNAVAILABLE,
  type AmbientConfigLocations,
  type ManagedVmAttestation,
  type ManagedVmBoundary,
  type SessionPolicy,
} from '../contracts';

/**
 * The managed VM profile's checks that belong to the runner (PM-141): the proof of the boundary
 * (a measured readiness report, never a flag), the version of the installed CLI, and a look at the
 * VM's own provider configuration, which must not override the protected start (PM-49). What the
 * CLIs are given in this profile is in the provider adapters (`providers/*`).
 */

export type ManagedVmRefusalReason =
  | 'no_boundary'
  | 'platform'
  | 'no_report'
  | 'bad_report'
  | 'not_ready'
  | 'profile_mismatch'
  | 'provider_version'
  | 'ambient_config';

/** A managed VM start that must not happen. `details` holds facts only, never file content. */
export class ManagedVmUnavailableError extends Error {
  readonly code = MANAGED_VM_UNAVAILABLE;
  readonly reason: ManagedVmRefusalReason;
  readonly details: Record<string, unknown>;

  constructor(reason: ManagedVmRefusalReason, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ManagedVmUnavailableError';
    this.reason = reason;
    this.details = details;
  }
}

export interface ReadinessBoundaryOptions {
  /** The readiness report `deploy/vm/verify.sh` writes, in a root-owned directory (docs/VM.md). */
  reportPath: string;
  /** Reports older than this do not prove the machine as it is now (default: one day). */
  maxAgeMs?: number;
  /** Tests say `linux`; the managed VM is the Linux guest and nothing else. */
  platform?: NodeJS.Platform;
  readText?: (file: string) => Promise<string>;
  now?: () => Date;
}

export const DEFAULT_REPORT_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * A boundary proved by the measured readiness report: the report is for this profile, current,
 * every required check passed, and the launcher and the domain gate passed too (`launcher` and
 * `domain-gate` are PM-140's). On a machine without such a report (the Mac) it never verifies, so
 * the same setting cannot make a legacy installation freer.
 */
export function createReadinessBoundary(options: ReadinessBoundaryOptions): ManagedVmBoundary {
  const platform = options.platform ?? process.platform;
  const readText = options.readText ?? ((file: string) => readFile(file, 'utf8'));
  return {
    async verify(): Promise<ManagedVmAttestation> {
      if (platform !== 'linux') {
        throw new ManagedVmUnavailableError(
          'platform',
          `the managed VM profile runs only in the Linux guest, not on ${platform}`,
          { platform },
        );
      }
      let text: string;
      try {
        text = await readText(options.reportPath);
      } catch {
        throw new ManagedVmUnavailableError(
          'no_report',
          'the VM readiness report is missing, so the boundary is not proven',
          { report: options.reportPath },
        );
      }
      let report: VmReadinessReport;
      try {
        report = VmReadinessReport.parse(JSON.parse(text));
      } catch {
        throw new ManagedVmUnavailableError(
          'bad_report',
          'the VM readiness report is not valid, so the boundary is not proven',
          { report: options.reportPath },
        );
      }
      const activation = evaluateManagedVmActivation(report, {
        now: options.now?.() ?? new Date(),
        maxAgeMs: options.maxAgeMs ?? DEFAULT_REPORT_MAX_AGE_MS,
      });
      if (!activation.active) {
        const { missing, failed, unverified, problems } = activation.readiness;
        throw new ManagedVmUnavailableError(
          'not_ready',
          'the VM boundary is not verified: the readiness report is not ready',
          { missing, failed, unverified, problems, notPassed: activation.notPassed },
        );
      }
      return {
        profile: { name: report.profile.name, version: report.profile.version },
        verifiedAt: report.generatedAt,
        providerVersions: MANAGED_VM_PROVIDER_VERSIONS,
      };
    },
  };
}

/** The version a CLI prints for `--version` ("2.1.284 (Claude Code)", "codex-cli 0.159.1"), or null. */
export function parseCliVersion(output: string): string | null {
  return /(?:^|[^\w.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\w.])/.exec(output)?.[1] ?? null;
}

/**
 * A policy that names the managed VM profile must be consistent with it: an unknown profile name,
 * a strict enforcement claim, a placement other than the member workspace, or permissions that
 * still ask or sandbox are conflicts, refused with a start error and never read as legacy.
 */
export function assertManagedVmPolicy(policy: SessionPolicy): void {
  const execution = policy.execution as { profile?: unknown } | undefined;
  if (!execution) return;
  const problems: string[] = [];
  if (execution.profile !== 'managed_vm')
    problems.push(`unknown execution profile ${String(execution.profile)}`);
  if (policy.enforcement !== 'legacy') problems.push('it claims strict enforcement');
  if (policy.placement.kind !== 'member_workspace') problems.push(`placement ${policy.placement.kind}`);
  if (policy.permissions.approval !== 'never') problems.push('its permissions ask');
  if (policy.permissions.sandbox === 'workspace-write') problems.push('its permissions sandbox the CLI');
  if (problems.length > 0)
    throw new Error(`conflicting execution profile in the session policy: ${problems.join(', ')}`);
}

/** Refuses an installed version the question-free settings are not proven for. */
export function assertProviderVersion(
  provider: AgentProvider,
  installed: string | null,
  attestation: ManagedVmAttestation,
): void {
  const allowed = attestation.providerVersions[provider];
  if (installed === null || !allowed.includes(installed)) {
    throw new ManagedVmUnavailableError(
      'provider_version',
      `${provider} ${installed ?? '(unknown version)'} is not a version the managed VM profile is proven for`,
      { provider, installed, allowed: [...allowed] },
    );
  }
}

// ---------------------------------------------------------------- the VM's own configuration

/** An override-capable setting found where the protected start does not want one. */
export interface AmbientIssue {
  file: string;
  /** Names of the settings (never their values: an `env` entry may hold a secret), or a problem. */
  keys: string[];
}

/**
 * Claude Code settings that change what the protected start sets or relies on: hooks (ours report
 * the state), MCP servers, the rules of who may ask and what, the sandbox and the credentials.
 * `permissions` is judged below (allow rules only widen).
 */
const CLAUDE_OVERRIDING_KEYS: ReadonlySet<string> = new Set([
  'hooks',
  'disableAllHooks',
  'allowManagedHooksOnly',
  'allowManagedPermissionRulesOnly',
  'allowManagedMcpServersOnly',
  'mcpServers',
  'enabledMcpjsonServers',
  'enableAllProjectMcpServers',
  'disableBypassPermissionsMode',
  'sandbox',
  'apiKeyHelper',
  'env',
]);

/** Parts of Claude Code's `permissions` that are harmless: more allowed, never fewer. */
const CLAUDE_HARMLESS_PERMISSIONS: ReadonlySet<string> = new Set(['allow', 'additionalDirectories']);

/** Roots of the Codex configuration tables and keys that change approval, sandbox, hooks or login. */
const CODEX_OVERRIDING_ROOTS: ReadonlySet<string> = new Set([
  'approval_policy',
  'sandbox_mode',
  'sandbox_workspace_write',
  'default_permissions',
  'permissions',
  'hooks',
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

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ||
      (err as NodeJS.ErrnoException).code === 'ENOTDIR'
      ? null
      : '\u0000unreadable';
  }
}

/** The `*.json` files of a directory, sorted; none when it is missing. */
async function jsonFilesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

async function claudeSettingsIssue(file: string): Promise<AmbientIssue | null> {
  const text = await readIfPresent(file);
  if (text === null) return null;
  if (text === '\u0000unreadable') return { file, keys: ['(unreadable)'] };
  if (text.trim() === '') return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { file, keys: ['(not valid JSON)'] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    return { file, keys: ['(not an object)'] };
  const keys = Object.keys(data).filter((key) => CLAUDE_OVERRIDING_KEYS.has(key));
  const permissions = (data as Record<string, unknown>).permissions;
  if (permissions && typeof permissions === 'object') {
    for (const key of Object.keys(permissions)) {
      if (!CLAUDE_HARMLESS_PERMISSIONS.has(key)) keys.push(`permissions.${key}`);
    }
  }
  return keys.length > 0 ? { file, keys } : null;
}

/** Roots of the TOML tables and keys of a Codex configuration file, comments and values left out. */
function tomlRoots(text: string): Set<string> {
  const roots = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[\[?\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)/.exec(line);
    const key = header ?? /^("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*[.=]/.exec(line);
    if (key) roots.add(key[1]!.replace(/^["']|["']$/g, ''));
  }
  return roots;
}

async function codexConfigIssue(file: string, everything: boolean): Promise<AmbientIssue | null> {
  const text = await readIfPresent(file);
  if (text === null) return null;
  if (text === '\u0000unreadable') return { file, keys: ['(unreadable)'] };
  const roots = tomlRoots(text);
  // An administrator's file (managed config, requirements) is a rule over the CLI whatever it
  // says: any content in it counts. The user's and the project's file only when they set one of
  // the roots that change the start (Codex writes harmless bookkeeping there itself).
  const keys = everything ? [...roots] : [...roots].filter((root) => CODEX_OVERRIDING_ROOTS.has(root));
  return keys.length > 0 ? { file, keys } : null;
}

/** The providers' real locations, from the environment the CLIs run in. */
function defaultLocations(env: NodeJS.ProcessEnv): Required<AmbientConfigLocations> {
  const home = env.HOME || os.homedir();
  return {
    claudeManaged: [
      '/etc/claude-code/managed-settings.json',
      '/etc/claude-code/managed-settings.d',
      '/Library/Application Support/ClaudeCode/managed-settings.json',
    ],
    claudeUser: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'),
    codexManaged: [
      '/etc/codex/config.toml',
      '/etc/codex/managed_config.toml',
      '/etc/codex/requirements.toml',
    ],
    codexUser: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
  };
}

/**
 * What in the VM's own configuration would override the protected start (PM-49): an
 * administrator's managed policy, the provider's user configuration and, for Codex, the project's
 * own `.codex/config.toml` (Codex reads it for a trusted directory, which the runner passes). The
 * project's Claude Code settings and `.mcp.json` are not read: the start leaves them out
 * (`--setting-sources user`, `--strict-mcp-config`). Only names are reported, never values.
 */
export async function inspectAmbientConfig(input: {
  provider: AgentProvider;
  cwd: string;
  env: NodeJS.ProcessEnv;
  locations?: AmbientConfigLocations;
}): Promise<AmbientIssue[]> {
  const where = { ...defaultLocations(input.env), ...input.locations };
  const issues: Array<AmbientIssue | null> = [];
  if (input.provider === 'claude') {
    const files: string[] = [];
    for (const entry of where.claudeManaged) {
      const info = await stat(entry).catch(() => null);
      if (info?.isDirectory()) files.push(...(await jsonFilesIn(entry)));
      else files.push(entry);
    }
    files.push(where.claudeUser);
    for (const file of files) issues.push(await claudeSettingsIssue(file));
  } else {
    for (const file of where.codexManaged) issues.push(await codexConfigIssue(file, true));
    issues.push(await codexConfigIssue(where.codexUser, false));
    issues.push(await codexConfigIssue(path.join(input.cwd, '.codex', 'config.toml'), false));
  }
  return issues.filter((issue): issue is AmbientIssue => issue !== null);
}

/** Refuses a start when the VM's own configuration would override the protected one. */
export async function assertNoAmbientOverride(
  input: Parameters<typeof inspectAmbientConfig>[0],
): Promise<void> {
  const issues = await inspectAmbientConfig(input);
  if (issues.length === 0) return;
  throw new ManagedVmUnavailableError(
    'ambient_config',
    `the VM's own ${input.provider} configuration would override the protected start: ${issues
      .map((issue) => `${issue.file} (${issue.keys.join(', ')})`)
      .join('; ')}`,
    { provider: input.provider, issues },
  );
}
