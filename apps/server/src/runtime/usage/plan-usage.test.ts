import type { AgentProvider, EngineId, PlanUsage } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../../contracts';
import { BackgroundTasks } from '../../kernel';
import type { ProjectService } from '../../core/projects';
import { PlanUsageCache, PlanUsageMonitor } from './plan-usage';

const usage: PlanUsage = {
  weeklyPercent: 30,
  weeklyResetsAt: null,
  fetchedAt: '2026-10-14T06:00:00.000Z',
};

const LOCAL = 'local' as EngineId;
const LIVE = [{ provider: 'claude' as const, engineId: LOCAL }];

function setup(
  ttlMs = 100,
  state: {
    live?: typeof LIVE;
    paused?: boolean;
    aiEnabled?: boolean;
    answer?: PlanUsage | null;
    idleIntervalMs?: number;
    /** The provider the project's AI member runs on (default claude); a non-Claude one is read through `providerFor`. */
    memberProvider?: AgentProvider;
    engineIds?: EngineId[];
    source?: { get: (engineId?: EngineId) => Promise<PlanUsage | null> };
  } = {},
) {
  const live = { current: state.live ?? LIVE, paused: state.paused ?? false };
  const memberProvider = state.memberProvider ?? 'claude';
  const provider = state.source
    ? { get: vi.fn(state.source.get) }
    : { get: vi.fn(async () => (state.answer === undefined ? usage : state.answer)) };
  const bus = { publish: vi.fn() };
  const background = new BackgroundTasks();
  const engineIds = state.engineIds ?? [LOCAL];
  const members = engineIds.map((_, index) => ({
    kind: 'ai',
    handle: `dev-${index}`,
    provider: memberProvider,
  }));
  const configOf = () => ({
    project: { key: 'PM' },
    team: {
      members,
      limits: { aiEnabled: state.aiEnabled ?? true },
    },
  });
  const projects = {
    summaries: () => [{ key: 'PM' }],
    config: vi.fn(async () => configOf()),
    cachedConfig: () => configOf(),
  } as unknown as ProjectService;
  const monitor = new PlanUsageMonitor({
    provider,
    providerFor: (requested) => (requested === memberProvider ? provider : undefined),
    projects,
    engines: {
      engineFor: (_projectKey, handle) =>
        engineIds[members.findIndex((member) => member.handle === handle)] ?? null,
    },
    bus: bus as unknown as EventBus,
    background,
    logger: { warn: vi.fn() } as unknown as FastifyBaseLogger,
    now: () => new Date(),
    liveAccounts: () => live.current,
    isPaused: () => live.paused,
    ttlMs,
    idleIntervalMs: state.idleIntervalMs,
  });
  return { monitor, provider, bus, background, projects, live };
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
      team: { members: [{ kind: 'ai', handle: 'dev', provider: 'claude' }], limits: { aiEnabled: true } },
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
      liveAccounts: () => [],
      isPaused: () => false,
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

  it('probes an account without a live session only every idle interval and reads nothing between', async () => {
    const { monitor, provider, projects, background } = setup(100, { live: [], idleIntervalMs: 1000 });
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.get).toHaveBeenCalledTimes(1);
      const configReads = vi.mocked(projects.config).mock.calls.length;
      await vi.advanceTimersByTimeAsync(800);
      expect(provider.get).toHaveBeenCalledTimes(1);
      expect(projects.config).toHaveBeenCalledTimes(configReads);
      await vi.advanceTimersByTimeAsync(200);
      expect(provider.get).toHaveBeenCalledTimes(2);
    } finally {
      monitor.stop();
      await background.stop();
    }
  });

  it('probes an idle account at once when forced, by a configuration change', async () => {
    const { monitor, provider, background } = setup(100, { live: [], idleIntervalMs: 100_000 });
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(150);
      expect(provider.get).toHaveBeenCalledTimes(1);
      monitor.refresh({ force: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.get).toHaveBeenCalledTimes(2);
    } finally {
      monitor.stop();
      await background.stop();
    }
  });

  it('coalesces forced refreshes during a targeted round into one full follow-up round', async () => {
    let release = () => {};
    const { monitor, provider, background } = setup(0, {
      engineIds: [A, B],
      live: [],
      source: {
        get: async () => {
          await new Promise<void>((resolve) => (release = resolve));
          return usage;
        },
      },
    });
    try {
      monitor.refresh({ force: true, engineIds: new Set([A]) });
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.get.mock.calls.map(([id]) => id)).toEqual([A]);
      monitor.refresh({ force: true });
      monitor.refresh({ force: true });
      monitor.engineOnline(A);
      expect(provider.get.mock.calls.map(([id]) => id)).toEqual([A]);
      provider.get.mockResolvedValue(usage);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.get.mock.calls.map(([id]) => id)).toEqual([A, A, B]);
      expect(monitor.cache.peek('claude', B)).toEqual(usage);
    } finally {
      release();
      await background.stop();
    }
  });

  it('measures an idle Codex account again when its engine comes online after a start probe that got no answer', async () => {
    let engineUp = false;
    const { monitor, provider, background } = setup(100, {
      memberProvider: 'codex',
      live: [],
      idleIntervalMs: 900_000,
      source: { get: vi.fn(async () => (engineUp ? { ...usage, weeklyPercent: 22 } : null)) },
    });
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.get).toHaveBeenCalledTimes(1);
      expect(monitor.peek('PM', 'codex')).toBeNull();
      engineUp = true;
      monitor.engineOnline(LOCAL);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.get).toHaveBeenCalledTimes(2);
      expect(monitor.peek('PM', 'codex')?.weeklyPercent).toBe(22);
    } finally {
      monitor.stop();
      await background.stop();
    }
  });

  it('follows a round in flight with another one when an engine comes online meanwhile', async () => {
    let engineUp = false;
    let release: () => void = () => {};
    const { monitor, provider, background } = setup(100, {
      memberProvider: 'codex',
      live: [],
      idleIntervalMs: 900_000,
      source: {
        get: vi.fn(async () => {
          const up = engineUp;
          await new Promise<void>((resolve) => (release = resolve));
          return up ? { ...usage, weeklyPercent: 22 } : null;
        }),
      },
    });
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.get).toHaveBeenCalledTimes(1);
      engineUp = true;
      monitor.engineOnline(LOCAL);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.get).toHaveBeenCalledTimes(2);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.peek('PM', 'codex')?.weeklyPercent).toBe(22);
    } finally {
      monitor.stop();
      await background.stop();
    }
  });

  it.each([false, true])(
    'reprobes only the reconnected engine and preserves the other engine backoff (round in flight: %s)',
    async (inFlight) => {
      let engineUp = false;
      let release = () => {};
      const { monitor, provider, background } = setup(100, {
        memberProvider: 'codex',
        engineIds: [A, B],
        live: [],
        idleIntervalMs: 1000,
        source: {
          get: async (engineId) => {
            if (engineId === B) return null;
            const up = engineUp;
            if (inFlight && !up) await new Promise<void>((resolve) => (release = resolve));
            return up ? usage : null;
          },
        },
      });
      try {
        monitor.refresh({ force: true });
        await vi.advanceTimersByTimeAsync(150);
        expect(provider.get.mock.calls.map(([id]) => id)).toEqual([A, B]);
        engineUp = true;
        monitor.engineOnline(A);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.get.mock.calls.map(([id]) => id)).toEqual([A, B, A]);
        expect(monitor.cache.peek('codex', A)).toEqual(usage);

        await vi.advanceTimersByTimeAsync(850);
        monitor.refresh();
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.get.mock.calls.map(([id]) => id)).toEqual([A, B, A, B]);
      } finally {
        release();
        await background.stop();
      }
    },
  );

  it.each([
    ['the project is paused', { paused: true }],
    ['the project has its AI off', { aiEnabled: false }],
  ])('probes nothing while %s', async (_name, state) => {
    const { monitor, provider, background } = setup(100, state);
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(500);
      expect(provider.get).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
      await background.stop();
    }
  });

  it('waits longer after each probe that gave no answer', async () => {
    const { monitor, provider, background } = setup(1000, { answer: null, idleIntervalMs: 100_000 });
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(provider.get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(provider.get).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3000);
      expect(provider.get).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(provider.get).toHaveBeenCalledTimes(3);
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
