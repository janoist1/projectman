import { afterEach, describe, expect, it } from 'vitest';
import { createPlanUsageProvider, toPlanUsage } from './plan-usage';
import { FAKE_CLAUDE, silentLogger } from '../../test-helpers';

const saved = process.env.FAKE_CLAUDE_USAGE;
afterEach(() => {
  if (saved === undefined) delete process.env.FAKE_CLAUDE_USAGE;
  else process.env.FAKE_CLAUDE_USAGE = saved;
});

describe('toPlanUsage', () => {
  it('maps the get_usage answer', () => {
    const now = new Date('2026-09-29T12:00:00.000Z');
    expect(
      toPlanUsage(
        {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 12.5, resets_at: '2026-09-29T15:00:00Z' },
            seven_day: { utilization: 140, resets_at: 1790000000 },
          },
        },
        now,
      ),
    ).toEqual({
      fiveHourPercent: 12.5,
      weeklyPercent: 100,
      fiveHourResetsAt: '2026-09-29T15:00:00.000Z',
      weeklyResetsAt: new Date(1790000000 * 1000).toISOString(),
      fetchedAt: '2026-09-29T12:00:00.000Z',
    });
  });

  it('returns null without plan limits (API key, signed out)', () => {
    expect(toPlanUsage({ rate_limits_available: false, rate_limits: null })).toBeNull();
    expect(toPlanUsage({ rate_limits_available: true, rate_limits: {} })).toBeNull();
    expect(toPlanUsage(null)).toBeNull();
  });
});

describe('createPlanUsageProvider', () => {
  it('asks the CLI with a get_usage control request and caches the answer', async () => {
    const provider = createPlanUsageProvider({
      claudeBin: FAKE_CLAUDE,
      logger: silentLogger(),
      minIntervalMs: 60_000,
    });
    const [a, b] = await Promise.all([provider.get(), provider.get()]);
    expect(a).toMatchObject({
      fiveHourPercent: 42,
      weeklyPercent: 17.5,
      fiveHourResetsAt: '2026-01-01T05:00:00.000Z',
    });
    expect(b).toBe(a);
    expect(await provider.get()).toBe(a);
  });

  it('gives null when the CLI does not answer', async () => {
    const provider = createPlanUsageProvider({
      claudeBin: '/nonexistent/claude',
      logger: silentLogger(),
      timeoutMs: 2_000,
    });
    expect(await provider.get()).toBeNull();
  });

  it('gives null for an account without plan limits', async () => {
    process.env.FAKE_CLAUDE_USAGE = JSON.stringify({ rate_limits_available: false, rate_limits: null });
    const provider = createPlanUsageProvider({ claudeBin: FAKE_CLAUDE, logger: silentLogger() });
    expect(await provider.get()).toBeNull();
  });
});
