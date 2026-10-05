import { afterEach, describe, expect, it } from 'vitest';
import { AgentProvider, AgentEffort, effortForProvider, PROVIDER_EFFORT_OPTIONS } from './member';

describe('effortForProvider', () => {
  it('keeps every supported value and preserves Claude defaults', () => {
    expect(effortForProvider('claude', undefined)).toBeUndefined();
    for (const provider of AgentProvider.options) {
      for (const effort of PROVIDER_EFFORT_OPTIONS[provider])
        expect(effortForProvider(provider, effort)).toBe(effort);
    }
  });
  it('defaults non-Claude providers to medium and clamps unsupported effort to the highest', () => {
    for (const provider of ['codex', 'gemini', 'nanogpt'] as const) {
      expect(effortForProvider(provider, undefined)).toBe('medium');
      for (const effort of AgentEffort.options) {
        expect(effortForProvider(provider, effort)).toBe(
          PROVIDER_EFFORT_OPTIONS[provider].includes(effort)
            ? effort
            : PROVIDER_EFFORT_OPTIONS[provider].at(-1),
        );
      }
    }
  });
  const original = PROVIDER_EFFORT_OPTIONS.gemini;
  afterEach(() => {
    PROVIDER_EFFORT_OPTIONS.gemini = original;
  });
  it('returns no effort when the provider exposes no options', () => {
    PROVIDER_EFFORT_OPTIONS.gemini = [];
    expect(effortForProvider('gemini', 'high')).toBeUndefined();
    expect(effortForProvider('gemini', undefined)).toBeUndefined();
  });
});
