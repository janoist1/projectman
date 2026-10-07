import { PermissionMode } from './member';
import type { AgentProvider, Approver } from './member';

/** Providers running through the Codex CLI share its sandbox and session metadata. */
export function usesCodexCli(provider: AgentProvider | undefined): boolean {
  return provider === 'codex' || provider === 'nanogpt';
}

/** NanoGPT has no subscription approval hook: external commands require a human. */
export function approverBlocksProvider(member: { provider?: AgentProvider; approver?: Approver }): boolean {
  // Match approverOf: members without an explicit approver use human approval.
  return member.provider === 'nanogpt' && (member.approver ?? 'human') === 'none';
}

export const DEFAULT_PROVIDER_MODELS: Record<AgentProvider, string> = {
  claude: 'opus',
  codex: 'gpt-6.1-sol',
  gemini: 'gemini-3.8-flash',
  nanogpt: 'z-ai/glm-5.3-flash-uncensored',
};

export const NANOGPT_MIN_CODEX_VERSION = '0.159.1';
/** Native permission-profile verification: PM-356, macOS 14.6 arm64, 2026-10-06. */
export const CODEX_PERMISSION_PROFILE_MIN_VERSION = '0.159.1';

/** Compare complete numeric CLI versions; malformed or prerelease versions fail closed. */
export function cliVersionAtLeast(installed: string, minimum: string): boolean {
  const versionPattern = /^\d+\.\d+\.\d+$/;
  if (!versionPattern.test(installed) || !versionPattern.test(minimum)) return false;
  const version = installed.split('.').map(Number);
  const floor = minimum.split('.').map(Number);
  if (![...version, ...floor].every(Number.isSafeInteger)) return false;
  for (let i = 0; i < version.length; i++) {
    if (version[i]! !== floor[i]!) return version[i]! > floor[i]!;
  }
  return true;
}

/**
 * The providers whose plan usage the server can measure (PM-324, PM-377).
 */
export const PLAN_USAGE_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'nanogpt'];

export function hasPlanUsage(provider: AgentProvider): boolean {
  return PLAN_USAGE_PROVIDERS.includes(provider);
}

/** NanoGPT is paused on quota failures, independently of the configurable usage threshold. */
export const PLAN_USAGE_PAUSE_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex'];

export function pausesOnPlanUsage(provider: AgentProvider): boolean {
  return PLAN_USAGE_PAUSE_PROVIDERS.includes(provider);
}

/** Claude aliases and full model ids must never be sent to Codex. */
const CLAUDE_MODEL =
  /^(?:default|best|opus|sonnet|haiku|fable|opusplan)(?:\[1m\])?$|^claude|^anthropic|opus|sonnet|haiku|fable|\[1m\]/i;

export function modelFitsProvider(provider: AgentProvider, model: string): boolean {
  const claude = CLAUDE_MODEL.test(model.trim());
  const gemini = /^gemini-/i.test(model.trim());
  return (
    Boolean(model.trim()) &&
    (provider === 'claude' ? claude : provider === 'gemini' ? gemini && !claude : !claude && !gemini)
  );
}

/** Use on hiring or changing providers, retaining compatible custom model ids. */
export function modelForProvider(provider: AgentProvider, model?: string): string {
  return model && modelFitsProvider(provider, model) ? model : DEFAULT_PROVIDER_MODELS[provider];
}

/**
 * The permission modes a member of each provider may have (decision 19); a picker offers exactly
 * these. `bypassPermissions` switches Codex's sandbox and approvals off, and then nothing stops a
 * push from a local-only repository (Codex does not enforce denied tools), so Codex members never
 * get it. Claude Code enforces its denied tools in every mode.
 */
export const PROVIDER_PERMISSION_MODES: Record<AgentProvider, readonly PermissionMode[]> = {
  claude: PermissionMode.options,
  codex: PermissionMode.options.filter((mode) => mode !== 'bypassPermissions'),
  gemini: PermissionMode.options.filter((mode) => mode !== 'bypassPermissions'),
  nanogpt: PermissionMode.options.filter((mode) => mode !== 'bypassPermissions'),
};

/** What a member gets in place of a mode its provider does not allow: edits in its workspace run, the rest is asked. */
export const FALLBACK_PERMISSION_MODE: PermissionMode = 'acceptEdits';

export function permissionModeFitsProvider(provider: AgentProvider, mode: PermissionMode): boolean {
  return PROVIDER_PERMISSION_MODES[provider].includes(mode);
}
