import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppHarness, createProject, setupOwner, type AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';

const processFake = vi.hoisted(() => ({ recording: false, calls: [] as string[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const fake = { ...original };
  for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync'] as const) {
    const fn = original[name];
    const record = (...args: unknown[]) => {
      if (processFake.recording) {
        processFake.calls.push(`${name}: ${String(args[0])}`);
        throw new Error('process execution in board request');
      }
      return Reflect.apply(fn, original, args);
    };
    // execFile's promisified form returns { stdout, stderr }; preserve that contract.
    for (const symbol of Object.getOwnPropertySymbols(fn)) {
      const custom = Reflect.get(fn, symbol);
      if (typeof custom === 'function') {
        Reflect.set(record, symbol, (...args: unknown[]) => {
          if (processFake.recording) {
            processFake.calls.push(`${name}: ${String(args[0])}`);
            throw new Error('process execution in board request');
          }
          return Reflect.apply(custom, original, args);
        });
      }
    }
    Reflect.set(fake, name, record);
  }
  return fake;
});

let h: AppHarness;
afterEach(async () => {
  processFake.recording = false;
  vi.restoreAllMocks();
  await h?.close();
});

describe('board request performance', () => {
  it('reads cached data without git, gh, worktree scans or usage probes, even after expiry', async () => {
    h = await createAppHarness();
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    await flush();
    const { domain, configStore } = h.app.projectman;
    domain.planUsage.invalidate();
    const usage = vi.spyOn(domain.planUsage, 'get').mockRejectedValue(new Error('request usage probe'));
    const load = vi.spyOn(configStore, 'load');
    const status = vi.spyOn(h.worktrees, 'status');
    processFake.calls.length = 0;
    processFake.recording = true;
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/projects/AR/board',
      headers: { cookie },
    });
    processFake.recording = false;
    expect(response.statusCode).toBe(200);
    expect(processFake.calls).toEqual([]);
    expect(usage).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('uses background usage results and publishes the existing websocket event', async () => {
    h = await createAppHarness();
    const cookie = await setupOwner(h.app);
    const events: unknown[] = [];
    const { domain } = h.app.projectman;
    domain.bus.subscribe((event) => events.push(event));
    h.runnerModule.planUsage.value = {
      fiveHourPercent: 12,
      weeklyPercent: 25,
      fiveHourResetsAt: null,
      weeklyResetsAt: null,
      fetchedAt: new Date().toISOString(),
    };
    await createProject(h, cookie);
    await flush();
    expect(events).toContainEqual(expect.objectContaining({ type: 'plan_usage', provider: 'claude' }));
    const calls = h.runnerModule.planUsage.calls;
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/projects/AR/board',
      headers: { cookie },
    });
    expect(response.json().planUsage.fiveHourPercent).toBe(12);
    expect(h.runnerModule.planUsage.calls).toBe(calls);
  });
});
