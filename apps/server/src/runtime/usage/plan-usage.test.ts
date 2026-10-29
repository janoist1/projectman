import type { EngineId, PlanUsage } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../../contracts';
import { BackgroundTasks } from '../../kernel';
import type { ProjectService } from '../../core/projects';
import { PlanUsageCache, PlanUsageMonitor } from './plan-usage';

const usage: PlanUsage = {
  fiveHourPercent: 20,
  weeklyPercent: 30,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  fetchedAt: '2026-10-14T06:00:00.000Z',
};

function setup(ttlMs = 100) {
  const provider = { get: vi.fn(async () => usage) };
  const bus = { publish: vi.fn() };
  const background = new BackgroundTasks();
  const projects = {
    summaries: () => [{ key: 'PM' }],
    config: vi.fn(async () => ({
      project: { key: 'PM' },
      team: { members: [{ kind: 'ai', handle: 'dev', provider: 'claude' }] },
    })),
  } as unknown as ProjectService;
  const monitor = new PlanUsageMonitor({
    provider,
    projects,
    engines: { engineFor: () => 'local' },
    bus: bus as unknown as EventBus,
    background,
    logger: { warn: vi.fn() } as unknown as FastifyBaseLogger,
    now: () => new Date(),
    ttlMs,
  });
  return { monitor, provider, bus, background };
}

const A = 'eng_aaaaaaaaaaaa' as EngineId;
const B = 'eng_bbbbbbbbbbbb' as EngineId;

describe('PlanUsageCache per engine', () => {
  function cache(ttlMs = 100) {
    const source = {
      get: vi.fn(async (engineId?: EngineId): Promise<PlanUsage> => ({
        ...usage,
        weeklyPercent: engineId === A ? 10 : 90,
      })),
    };
    return {
      source,
      cache: new PlanUsageCache({
        provider: source,
        logger: { warn: vi.fn() } as unknown as FastifyBaseLogger,
        now: () => new Date(),
        ttlMs,
      }),
    };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps one value per engine and shares a request in flight only within one engine', async () => {
    const { cache: c, source } = cache();
    const [a1, a2, b1] = await Promise.all([c.get('claude', A), c.get('claude', A), c.get('claude', B)]);
    expect(source.get.mock.calls.map(([id]) => id).sort()).toEqual([A, B]);
    expect([a1?.weeklyPercent, a2?.weeklyPercent, b1?.weeklyPercent]).toEqual([10, 10, 90]);
    expect(c.peek('claude', A)?.weeklyPercent).toBe(10);
    expect(c.peek('claude', B)?.weeklyPercent).toBe(90);
  });

  it('asks nothing and knows nothing without an engine', async () => {
    const { cache: c, source } = cache();
    expect(await c.get('claude', null)).toBeNull();
    expect(source.get).not.toHaveBeenCalled();
  });

  it('invalidates only the given engine so the other one keeps its cached value', async () => {
    const { cache: c, source } = cache();
    await c.get('claude', A);
    await c.get('claude', B);
    c.invalidate(A);
    await c.get('claude', A);
    await c.get('claude', B);
    expect(source.get.mock.calls.map(([id]) => id)).toEqual([A, B, A]);
  });

  it('serves a recent stale measurement while sharing one refresh and publishes the new value', async () => {
    const { cache: c, source } = cache();
    await c.get('claude', A);
    let finish!: (value: PlanUsage) => void;
    source.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect((await c.get('claude', A))?.weeklyPercent).toBe(10);
    expect((await c.get('claude', A))?.weeklyPercent).toBe(10);
    expect(source.get).toHaveBeenCalledTimes(2);
    finish({ ...usage, weeklyPercent: 90 });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.peek('claude', A)?.weeklyPercent).toBe(90);
  });

  it('waits for a measurement once the stale window expires', async () => {
    const { cache: c, source } = cache();
    await c.get('claude', A);
    await vi.advanceTimersByTimeAsync(500);
    source.get.mockResolvedValueOnce({ ...usage, weeklyPercent: 90 });
    expect((await c.get('claude', A))?.weeklyPercent).toBe(90);
  });
});

describe('PlanUsageMonitor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts a refresh immediately and publishes each periodic result', async () => {
    const { monitor, provider, bus, background } = setup();
    const refresh = vi.spyOn(monitor, 'refresh');
    try {
      monitor.start();
      expect(refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.get).toHaveBeenCalledTimes(1);
      expect(bus.publish).toHaveBeenCalledWith({
        type: 'plan_usage',
        projectKey: 'PM',
        provider: 'claude',
        usage,
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(provider.get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(provider.get).toHaveBeenCalledTimes(2);
      expect(bus.publish).toHaveBeenCalledTimes(2);
    } finally {
      monitor.stop();
      await background.stop();
    }
  });

  it('measures each engine once and publishes only to the projects that run on it', async () => {
    const provider = {
      get: vi.fn(async (engineId?: EngineId) => ({ ...usage, weeklyPercent: engineId === A ? 10 : 90 })),
    };
    const bus = { publish: vi.fn() };
    const background = new BackgroundTasks();
    const onEngine: Record<string, EngineId> = { PA: A, PB: B, PC: A };
    const configOf = (key: string) => ({
      project: { key },
      team: { members: [{ kind: 'ai', handle: 'dev', provider: 'claude' }] },
    });
    const projects = {
      summaries: () => [{ key: 'PA' }, { key: 'PB' }, { key: 'PC' }],
      config: vi.fn(async (key: string) => configOf(key)),
      cachedConfig: (key: string) => configOf(key),
    } as unknown as ProjectService;
    const monitor = new PlanUsageMonitor({
      provider,
      projects,
      engines: { engineFor: (projectKey) => onEngine[projectKey]! },
      bus: bus as unknown as EventBus,
      background,
      logger: { warn: vi.fn() } as unknown as FastifyBaseLogger,
      now: () => new Date(),
      ttlMs: 100,
    });
    try {
      monitor.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.get).toHaveBeenCalledTimes(2);
      const published = bus.publish.mock.calls.map(([event]) => [
        event.projectKey,
        event.usage.weeklyPercent,
      ]);
      expect(published.sort()).toEqual([
        ['PA', 10],
        ['PB', 90],
        ['PC', 10],
      ]);
      expect(monitor.peek('PA', 'claude')?.weeklyPercent).toBe(10);
      expect(monitor.peek('PB', 'claude')?.weeklyPercent).toBe(90);
    } finally {
      await background.stop();
    }
  });

  it('stops future probes and removes the timer', async () => {
    const { monitor, provider, background } = setup();
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      monitor.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(300);
      expect(provider.get).toHaveBeenCalledTimes(1);
    } finally {
      monitor.stop();
      await background.stop();
    }
  });

  it('uses a sixty-second interval with a zero cache TTL', async () => {
    const { monitor, provider, background } = setup(0);
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(provider.get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(provider.get).toHaveBeenCalledTimes(2);
    } finally {
      monitor.stop();
      await background.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
