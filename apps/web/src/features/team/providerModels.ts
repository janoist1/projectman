import type { AgentProvider } from '@projectman/shared';
import { t } from '../../i18n/t';
import type { PlainMessageKey } from '../../i18n/t';

export const CLAUDE_FIXED_LABELS: Record<string, PlainMessageKey> = {
  'claude-opus-5-5': 'providerSettings.claudeModels.opus55',
  'claude-sonnet-5': 'providerSettings.claudeModels.sonnet5',
  'claude-haiku-4-5-20251001': 'providerSettings.claudeModels.haiku45',
  'claude-fable-5-1': 'providerSettings.claudeModels.fable51',
};
export const CLAUDE_ALIAS_LABELS: Record<string, PlainMessageKey> = {
  opus: 'providerSettings.claudeModels.opus',
  sonnet: 'providerSettings.claudeModels.sonnet',
  haiku: 'providerSettings.claudeModels.haiku',
  fable: 'providerSettings.claudeModels.fable',
};
export const CODEX_LABELS: Record<string, PlainMessageKey> = {
  'gpt-6.1-sol': 'providerSettings.models.sol',
  'gpt-6-luna': 'providerSettings.models.luna',
  'gpt-6-astra': 'providerSettings.models.astra',
};
export const GEMINI_LABELS: Record<string, PlainMessageKey> = {
  'gemini-3.8-flash': 'providerSettings.models.geminiFlash',
  'gemini-3.1-pro': 'providerSettings.models.geminiPro',
};
export const PROVIDER_MODEL_LABELS: Record<AgentProvider, Record<string, PlainMessageKey>> = {
  claude: { ...CLAUDE_FIXED_LABELS, ...CLAUDE_ALIAS_LABELS },
  codex: CODEX_LABELS,
  gemini: GEMINI_LABELS,
};

export function providerModelLabel(provider: AgentProvider, model: string): string {
  const labels = PROVIDER_MODEL_LABELS[provider];
  const key = Object.hasOwn(labels, model) ? labels[model] : undefined;
  return key ? t(key) : model;
}
