import { describe, expect, it } from 'vitest';
import type { PlanUsage } from '@projectman/shared';
import { ProviderQuotaHolds, NANOGPT_RATE_HOLD_MS } from './provider-quota-hold';

describe('ProviderQuotaHolds', () => {
  const at = new Date('2026-10-06T12:00:00Z');
  const reset = new Date('2026-10-11T12:00:00Z');
  const usage = (percent: number, until: string | null = reset.toISOString()): PlanUsage => ({
    fiveHourPercent: null,
    fiveHourResetsAt: null,
    weeklyPercent: percent,
    weeklyResetsAt: until,
    fetchedAt: at.toISOString(),
  });
  it('holds a quota through its reset and preserves it across concurrent failures', () => {
    const holds = new ProviderQuotaHolds();
    expect(holds.start('nanogpt', at)).toBe(true);
    holds.settle('nanogpt', usage(99.96), at);
    expect(holds.start('nanogpt', new Date(at.getTime() + 1))).toBe(false);
    expect(holds.check('nanogpt', new Date(reset.getTime() - 1))).toEqual({ until: reset, kind: 'quota' });
    expect(holds.check('nanogpt', reset)).toBeNull();
    expect(holds.check('codex', at)).toBeNull();
  });
  it('waits fifteen minutes for an initially known low usage', () => {
    const holds = new ProviderQuotaHolds();
    holds.start('nanogpt', at);
    holds.settle('nanogpt', usage(40), at);
    expect(holds.check('nanogpt', at)).toEqual({
      until: new Date(at.getTime() + NANOGPT_RATE_HOLD_MS),
      kind: 'rate',
    });
  });
  it('fails closed without a reset and releases unknown holds after a low usage probe', () => {
    const holds = new ProviderQuotaHolds();
    holds.start('nanogpt', at);
    holds.settle('nanogpt', usage(100, null), at);
    expect(holds.check('nanogpt', reset)).toEqual({ until: null, kind: 'unknown' });
    holds.observed('nanogpt', null, reset);
    expect(holds.check('nanogpt', reset)?.kind).toBe('unknown');
    holds.observed('nanogpt', usage(40), reset);
    expect(holds.check('nanogpt', reset)).toBeNull();
  });
  it('keeps inference held when a settlement has no readable usage', () => {
    const holds = new ProviderQuotaHolds();
    holds.start('nanogpt', at);
    holds.settle('nanogpt', usage(100), at);
    holds.settle('nanogpt', null, at);
    expect(holds.check('nanogpt', reset)).toEqual({ until: null, kind: 'unknown' });
  });
  it.each([-1, 0])('keeps high usage held when its reset is %i milliseconds from now', (offset) => {
    const holds = new ProviderQuotaHolds();
    holds.start('nanogpt', at);
    const staleUsage = usage(100, new Date(at.getTime() + offset).toISOString());
    holds.settle('nanogpt', staleUsage, at);
    expect(holds.check('nanogpt', at)).toEqual({ until: null, kind: 'unknown' });
    expect(holds.start('nanogpt', at)).toBe(false);
    holds.observed('nanogpt', staleUsage, at);
    expect(holds.check('nanogpt', at)).toEqual({ until: null, kind: 'unknown' });
    holds.observed('nanogpt', usage(40), at);
    expect(holds.check('nanogpt', at)).toBeNull();
  });
});
