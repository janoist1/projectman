import { describe, expect, it, vi } from 'vitest';
import type { EngineId, PlanUsage, Session } from '@projectman/shared';
import { ProviderLimits } from './provider-limits';

const HOST = 'host-engine' as EngineId;
const FRIEND = 'friend-engine' as EngineId;
const OTHER = 'other-engine' as EngineId;
const at = new Date('2026-10-06T12:00:00Z');
const reset = '2026-10-11T12:00:00.000Z';

const usage = (percent: number): PlanUsage => ({
  fiveHourPercent: null,
  fiveHourResetsAt: null,
  weeklyPercent: percent,
  weeklyResetsAt: reset,
  fetchedAt: at.toISOString(),
});

function setup(measured: Partial<Record<EngineId, PlanUsage | null>> = {}) {
  const asked: Array<EngineId | null> = [];
  const limits = new ProviderLimits({
    ctx: {
      now: () => at,
      logger: { warn: vi.fn(), error: vi.fn() },
      repos: { inbox: { latestProviderQuota: () => null } },
    },
    engines: {
      hostEngine: () => HOST,
      nanogptKeyHolder: (id: EngineId) => (id === FRIEND || id === OTHER ? id : 'host'),
    },
    projects: { cachedConfig: () => null },
    runner: {},
    publish: vi.fn(),
    background: (job: () => Promise<unknown>) => job(),
  } as never);
  limits.useQuotaRecovery(
    {
      get: async (_provider, engineId) => {
        asked.push(engineId);
        return (engineId && measured[engineId]) || null;
      },
      invalidate: vi.fn(),
    },
    async () => undefined,
  );
  const session = (engineId: EngineId) =>
    ({
      id: `session-${engineId}`,
      projectKey: 'AR',
      member: 'dev-1',
      workItem: { type: 'general' },
      engineId,
    }) as unknown as Session;
  const fail = async (engineId: EngineId) => {
    limits.rateLimited(session(engineId), {
      type: 'rate_limited',
      sessionId: `session-${engineId}`,
      provider: 'nanogpt',
      message: '429 Too Many Requests',
      at: at.toISOString(),
    });
    // The usage measurement and the settlement of the hold run in the background.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const held = (engineId: EngineId | null) => {
    try {
      limits.assertProviderCooldown('nanogpt', engineId);
      return false;
    } catch {
      return true;
    }
  };
  return { limits, asked, fail, held };
}

describe('ProviderLimits NanoGPT hold per key', () => {
  it('holds only the sessions of an own-key engine when its key reaches the limit', async () => {
    const { fail, held } = setup({ [FRIEND]: usage(100) });
    await fail(FRIEND);
    expect(held(FRIEND)).toBe(true);
    expect(held(HOST)).toBe(false);
    expect(held(null)).toBe(false);
    expect(held(OTHER)).toBe(false);
  });

  it('holds only the cloud key sessions when the host key reaches the limit', async () => {
    const { fail, held } = setup({ [HOST]: usage(100) });
    await fail(HOST);
    expect(held(HOST)).toBe(true);
    expect(held(null)).toBe(true);
    expect(held(FRIEND)).toBe(false);
  });

  it('lifts an unknown hold only by a measurement on the engine that owns the key', async () => {
    const { limits, fail, held } = setup({ [FRIEND]: null });
    await fail(FRIEND);
    expect(held(FRIEND)).toBe(true);
    limits.observeProviderUsage('nanogpt', HOST, usage(40));
    limits.observeProviderUsage('nanogpt', OTHER, usage(40));
    expect(held(FRIEND)).toBe(true);
    limits.observeProviderUsage('nanogpt', FRIEND, usage(40));
    expect(held(FRIEND)).toBe(false);
  });

  it('keeps the host hold when an own-key engine reports a low usage', async () => {
    const { limits, fail, held } = setup({ [HOST]: null });
    await fail(HOST);
    limits.observeProviderUsage('nanogpt', FRIEND, usage(40));
    expect(held(HOST)).toBe(true);
    limits.observeProviderUsage('nanogpt', HOST, usage(40));
    expect(held(HOST)).toBe(false);
  });

  it('starts the restored hold in the scope of each deferred start engine', () => {
    const { limits, asked, held } = setup();
    limits.restoreProviderQuota([FRIEND, null]);
    expect(held(FRIEND)).toBe(true);
    expect(held(HOST)).toBe(true);
    expect(held(OTHER)).toBe(false);
    expect(asked).toEqual([]);
  });

  it('measures the engine of every unknown hold when the quota is refreshed', async () => {
    const { limits, asked, held } = setup({ [FRIEND]: usage(40) });
    limits.restoreProviderQuota([FRIEND, HOST]);
    await limits.refreshProviderQuota();
    expect([...asked].sort()).toEqual([FRIEND, HOST].sort());
    expect(held(FRIEND)).toBe(false);
    expect(held(HOST)).toBe(true);
  });
});
