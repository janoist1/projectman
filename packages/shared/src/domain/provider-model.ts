import { PermissionMode } from './member';
import type { AgentProvider } from './member';

export const DEFAULT_PROVIDER_MODELS: Record<AgentProvider, string> = {
  claude: 'opus',
  codex: 'gpt-6.1-sol',
};

/**
 * The providers whose plan usage the server can measure (PM-324): the plan-usage pause and the
 * usage gauges apply to these only.
 */
export const PLAN_USAGE_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex'];

export function hasPlanUsage(provider: AgentProvider): boolean {
  return PLAN_USAGE_PROVIDERS.includes(provider);
}

/** Claude aliases and full model ids must never be sent to Codex. */
const CLAUDE_MODEL =
  /^(?:default|best|opus|sonnet|haiku|fable|opusplan)(?:\[1m\])?$|^claude|^anthropic|opus|sonnet|haiku|fable|\[1m\]/i;

export function modelFitsProvider(provider: AgentProvider, model: string): boolean {
  const claude = CLAUDE_MODEL.test(model.trim());
  return Boolean(model.trim()) && (provider === 'claude' ? claude : !claude);
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
};

/** What a member gets in place of a mode its provider does not allow: edits in its workspace run, the rest is asked. */
export const FALLBACK_PERMISSION_MODE: PermissionMode = 'acceptEdits';

export function permissionModeFitsProvider(provider: AgentProvider, mode: PermissionMode): boolean {
  return PROVIDER_PERMISSION_MODES[provider].includes(mode);
}
