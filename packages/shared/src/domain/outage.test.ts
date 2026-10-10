import { describe, expect, it } from 'vitest';
import { outageIdOf, providerOutageProblemOf, WorkOutage } from './outage';

describe('outage contracts', () => {
  it('identifies provider and engine targets independently', () => {
    expect(outageIdOf({ kind: 'provider', provider: 'claude', engineId: null })).toBe(
      'provider:claude:local',
    );
    expect(outageIdOf({ kind: 'provider', provider: 'codex', engineId: 'eng_abcdefghijkl' })).toBe(
      'provider:codex:eng_abcdefghijkl',
    );
    expect(outageIdOf({ kind: 'engine', engineId: null })).toBe('engine:none');
    expect(outageIdOf({ kind: 'engine', engineId: 'eng_abcdefghijkl' })).toBe('engine:eng_abcdefghijkl');
  });

  it('maps refusals without admitting unrelated or unrecognized problems', () => {
    expect(providerOutageProblemOf('provider_not_logged_in')).toBe('not_logged_in');
    expect(providerOutageProblemOf('provider_not_logged_in', { problem: 'cli_missing' })).toBe('cli_missing');
    expect(providerOutageProblemOf('nanogpt_key_missing')).toBe('no_key');
    for (const code of ['nanogpt_setup_incomplete', 'codex_setup_incomplete']) {
      for (const problem of ['cli_location', 'sandbox_config', 'mcp_config', undefined])
        expect(providerOutageProblemOf(code, { problem })).toBe('setup_incomplete');
      expect(providerOutageProblemOf(code, { problem: 'chatgpt_login' })).toBe('chatgpt_login');
    }
    expect(providerOutageProblemOf('engine_offline')).toBeNull();
    expect(providerOutageProblemOf('disk_low', { problem: 'no_key' })).toBeNull();
  });

  it('validates provider diagnostics and remote engine identity', () => {
    expect(
      WorkOutage.parse({
        kind: 'provider',
        id: 'provider:codex:local',
        provider: 'codex',
        engine: null,
        problem: 'setup_incomplete',
        since: '2026-10-10T20:00:00Z',
      }).kind,
    ).toBe('provider');
    expect(
      WorkOutage.safeParse({
        kind: 'engine',
        id: 'engine:x',
        engine: { id: 'invalid', name: 'X' },
        since: 'now',
      }).success,
    ).toBe(false);
  });
});
