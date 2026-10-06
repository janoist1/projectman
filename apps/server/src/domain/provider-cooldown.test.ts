import { describe, expect, it } from 'vitest';
import { ProviderCooldowns } from './provider-cooldown';

describe('ProviderCooldowns', () => {
  it('shares the backoff per provider, expires at the deadline and caps it at four hours', () => {
    const cooldowns = new ProviderCooldowns();
    let at = new Date('2026-10-06T12:00:00Z');
    for (const minutes of [15, 30, 60, 120, 240, 240]) {
      const hit = cooldowns.hit('nanogpt', at);
      expect(hit.until.getTime() - at.getTime()).toBe(minutes * 60_000);
      expect(cooldowns.check('nanogpt', new Date(hit.until.getTime() - 1))).toEqual({ until: hit.until });
      expect(cooldowns.check('nanogpt', hit.until)).toBeNull();
      expect(cooldowns.check('codex', at)).toBeNull();
      at = hit.until;
    }
    cooldowns.succeeded('nanogpt', at);
    expect(cooldowns.hit('nanogpt', at).streak).toBe(1);
    expect(cooldowns.check('nanogpt', at)?.until.getTime()).toBe(at.getTime() + 15 * 60_000);
  });

  it('keeps an active wait unchanged after simultaneous failures and a concurrent successful turn', () => {
    const cooldowns = new ProviderCooldowns();
    const at = new Date('2026-10-06T12:00:00Z');
    const first = cooldowns.hit('nanogpt', at);
    const during = new Date(at.getTime() + 60_000);
    expect(cooldowns.hit('nanogpt', during)).toEqual(first);
    cooldowns.succeeded('nanogpt', during);
    expect(cooldowns.check('nanogpt', during)).toEqual({ until: first.until });
    expect(cooldowns.hit('nanogpt', during)).toEqual(first);
    const second = cooldowns.hit('nanogpt', first.until);
    expect(second.streak).toBe(2);
    expect(second.until.getTime() - first.until.getTime()).toBe(30 * 60_000);
  });
});
