import type { PlanUsage } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../../contracts';
import { BackgroundTasks } from '../../domain/background';
import type { ProjectService } from '../../domain/projects';
import { PlanUsageMonitor } from './plan-usage';

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
      team: { members: [{ kind: 'ai', handle: 'dev', provider: 'claude' }] },
    })),
  } as unknown as ProjectService;
  const monitor = new PlanUsageMonitor({
    provider,
    projects,
    bus: bus as unknown as EventBus,
    background,
    logger: { warn: vi.fn() } as unknown as FastifyBaseLogger,
    now: () => new Date(),
    ttlMs,
  });
  return { monitor, provider, bus, background };
}

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
