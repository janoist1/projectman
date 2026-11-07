import type { EngineId, ProjectConfig } from '@projectman/shared';
import { describe, expect, it, vi } from 'vitest';
import type { MachineLoad } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { InboxService } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import { MachineGuard } from './machine-guard';

const MINUTE_MS = 60_000;

/** Two projects on two engines, and a guard that reads the pressure of each engine from `pressures`. */
function setup() {
  let at = Date.parse('2026-11-06T10:00:00Z');
  const pressures: Record<string, MachineLoad['pressure']> = { e1: 'critical', e2: 'critical' };
  const raiseAlert = vi.fn();
  const settleAlert = vi.fn();
  const configs = new Map(['A', 'B'].map((key) => [key, { project: { key } } as unknown as ProjectConfig]));
  const engineOf: Record<string, EngineId> = { A: 'e1' as EngineId, B: 'e2' as EngineId };
  const guard = new MachineGuard({
    ctx: { now: () => new Date(at), logger: { warn: vi.fn() } } as unknown as DomainContext,
    projects: {
      summaries: () => [...configs.keys()].map((key) => ({ key })),
      cachedConfig: (key: string) => configs.get(key),
    } as unknown as ProjectService,
    inbox: { raiseAlert, settleAlert } as unknown as InboxService,
    engines: {
      projectEngine: (key: string) => engineOf[key] ?? null,
      get: (id: string) => ({
        machineLoad: async () => ({
          pressure: pressures[id] ?? null,
          places: { capacity: 4, used: 0, waiting: 0 },
        }),
      }),
    } as never,
  });
  const check = async (minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      at += MINUTE_MS;
      await guard.check();
    }
  };
  return { guard, pressures, raiseAlert, settleAlert, check };
}

describe('MachineGuard with several engines', () => {
  it('withdraws the todo of a project when its own engine eases, while another engine stays critical', async () => {
    const { pressures, raiseAlert, settleAlert, check } = setup();
    await check(11);
    expect(raiseAlert).toHaveBeenCalledTimes(2);
    pressures.e1 = 'normal';
    await check(1);
    expect(settleAlert).toHaveBeenCalledWith('A', 'machine_busy');
    expect(settleAlert).not.toHaveBeenCalledWith('B', 'machine_busy');
  });

  it('opens a new todo for the next critical spell of the project that eased', async () => {
    const { pressures, raiseAlert, check } = setup();
    await check(11);
    pressures.e1 = 'normal';
    await check(1);
    pressures.e1 = 'critical';
    await check(11);
    expect(raiseAlert.mock.calls.filter(([alert]) => alert.projectKey === 'A')).toHaveLength(2);
    expect(raiseAlert.mock.calls.filter(([alert]) => alert.projectKey === 'B')).toHaveLength(1);
  });
});
