import type { AgentProvider } from './member';

export const DEFAULT_PROVIDER_MODELS: Record<AgentProvider, string> = {
  claude: 'opus',
  codex: 'gpt-6.1-sol',
};

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
