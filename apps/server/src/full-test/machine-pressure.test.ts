import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  measurePressure,
  PRESSURE_FILE,
  readFreshPressure,
  startPressureMeter,
  writePressure,
} from './machine-pressure';
import type { PressureProbe } from './machine-pressure';

const probe = (platform: NodeJS.Platform, output: string, calls: string[] = []): PressureProbe => ({
  platform,
  execFile: async (file, args) => {
    calls.push([file, ...args].join(' '));
    return output;
  },
  readFile: async (file) => {
    calls.push(file);
    return output;
  },
});

const psi = (some: number, full: number) =>
  `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=${full.toFixed(2)} avg60=0.00 avg300=0.00 total=1\n`;

describe('the memory pressure of the machine', () => {
  it.each([
    ['1\n', 'normal'],
    ['2\n', 'warn'],
    ['4\n', 'critical'],
  ] as const)('reads %j of sysctl on macOS as %s', async (output, level) => {
    const calls: string[] = [];
    expect(await measurePressure(probe('darwin', output, calls))).toEqual({ level, source: 'sysctl' });
    expect(calls).toEqual(['sysctl -n kern.memorystatus_vm_pressure_level']);
  });

  it.each([
    ['normal', 'some 0, full 0', psi(0, 0)],
    ['warn', 'some 10, full 4.99', psi(10, 4.99)],
    ['critical', 'some 12, full 5', psi(12, 5)],
  ] as const)('reads /proc/pressure/memory on Linux as %s at avg10 %s', async (level, _avg10, output) => {
    const calls: string[] = [];
    expect(await measurePressure(probe('linux', output, calls))).toEqual({ level, source: 'psi' });
    expect(calls).toEqual(['/proc/pressure/memory']);
  });

  it.each([
    ['win32', '4'],
    ['darwin', '0\n'],
    ['linux', 'garbage'],
  ] as const)('has no reading on %s with %j', async (platform, output) => {
    expect(await measurePressure(probe(platform, output))).toBeNull();
  });
});

describe('the pressure file', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(mkdtempSync(path.join(tmpdir(), 'pm-pressure-')), 'heavy');
  });
  afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));

  it('is fresh for 30 s, and stale, missing or broken it holds nothing', async () => {
    const at = Date.parse('2026-11-06T12:00:00Z');
    expect(await readFreshPressure(dir, at)).toBeNull();
    await writePressure(dir, { level: 'critical', source: 'sysctl' }, at);
    expect(JSON.parse(readFileSync(path.join(dir, PRESSURE_FILE), 'utf8'))).toEqual({
      level: 'critical',
      at: '2026-11-06T12:00:00.000Z',
      source: 'sysctl',
    });
    expect(await readFreshPressure(dir, at + 30_000)).toBe('critical');
    expect(await readFreshPressure(dir, at + 30_001)).toBeNull();
    writeFileSync(path.join(dir, PRESSURE_FILE), '{');
    expect(await readFreshPressure(dir, at)).toBeNull();
  });

  it('is written by the meter at once, with no temporary file left beside it', async () => {
    const readings = [{ level: 'warn', source: 'psi' } as const, null];
    const meter = startPressureMeter({ dir, measure: async () => readings.shift() ?? null, intervalMs: 5 });
    await meter.close();
    expect(readdirSync(dir)).toEqual([PRESSURE_FILE]);
    expect(await readFreshPressure(dir)).toBe('warn');
  });

  it('gives its last reading from memory for 30 s, then and before any reading nothing (PM-1328)', async () => {
    let now = Date.parse('2026-11-06T12:00:00Z');
    const meter = startPressureMeter({
      dir,
      measure: async () => ({ level: 'critical', source: 'sysctl' }),
      intervalMs: 1_000_000,
      now: () => now,
    });
    expect(meter.level()).toBeNull();
    await meter.close();
    expect(meter.level()).toBe('critical');
    now += 30_000;
    expect(meter.level()).toBe('critical');
    now += 1;
    expect(meter.level()).toBeNull();
  });

  it('tells a failing measurement once and goes on', async () => {
    const errors: unknown[] = [];
    let rounds = 0;
    const meter = startPressureMeter({
      dir,
      measure: async () => {
        rounds++;
        throw new Error('sysctl refused');
      },
      intervalMs: 1,
      onError: (err) => errors.push(err),
    });
    await expect.poll(() => rounds).toBeGreaterThan(2);
    await meter.close();
    expect(errors).toHaveLength(1);
  });
});
