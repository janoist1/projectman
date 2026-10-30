import type { PlanUsage, ProjectConfig } from '@projectman/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectService } from '../../core/projects';
import type { DomainContext } from '../../core/base';
import { BackgroundTasks } from '../../kernel';
import { UsageWake } from './usage-wake';

function setup(standby = false) {
  const config = {
    team: {
      limits: { pauseAbovePlanUsagePercent: 80 },
      members: [
        { kind: 'ai', handle: 'a', provider: 'claude' },
        { kind: 'ai', handle: 'b', provider: 'claude' },
        { kind: 'ai', handle: 'c', provider: 'codex' },
      ],
    },
  } as ProjectConfig;
  const driver = { ensure: vi.fn(async () => {}) };
  const retry = vi.fn();
  const background = new BackgroundTasks();
  const wake = new UsageWake({
    projects: {
      summaries: () => [{ key: 'PM' }],
      cachedConfig: () => config,
    } as unknown as ProjectService,
    ctx: {
      repos: {
        memberQueue: {
          listOpenMembers: () => ['a', 'b', 'c'].map((member) => ({ projectKey: 'PM', member })),
        },
      },
      logger: { warn: vi.fn() },
    } as unknown as DomainContext,
    engines: { engineFor: (_project, member) => (member === 'b' ? 'other' : 'local') },
    background,
    driver,
    retry,
    standby,
  });
  const observe = (percent: number) =>
    wake.observe('claude', 'local', {
      fiveHourPercent: percent,
      weeklyPercent: percent,
    } as PlanUsage);
  return { wake, observe, driver, retry, background };
}

describe('UsageWake', () => {
  it('wakes only queued members of the measured account when its pause lifts', async () => {
    const { observe, driver, retry, background } = setup();
    observe(95);
    observe(90);
    expect(retry).not.toHaveBeenCalled();
    observe(10);
    observe(10);
    await background.stop();
    expect(driver.ensure.mock.calls).toEqual([['PM', 'a']]);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('rechecks all queued members after the threshold changes', async () => {
    const { wake, driver, background } = setup();
    wake.configChanged('PM', 80, 100);
    await background.stop();
    expect(driver.ensure.mock.calls).toEqual([
      ['PM', 'a'],
      ['PM', 'b'],
      ['PM', 'c'],
    ]);
  });

  it('does not retry or wake members on a standby server', async () => {
    const { observe, wake, driver, retry, background } = setup(true);
    observe(95);
    observe(10);
    wake.configChanged('PM', 80, 100);
    await background.stop();
    expect(retry).not.toHaveBeenCalled();
    expect(driver.ensure).not.toHaveBeenCalled();
  });
});
