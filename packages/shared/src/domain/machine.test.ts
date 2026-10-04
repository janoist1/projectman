import { describe, expect, it } from 'vitest';
import { machineLevels, StopOrphansRequest, type MachineSummary } from './machine';

const GB = 1024 ** 3;

function summary(over: Partial<MachineSummary> = {}): MachineSummary {
  return {
    cpuPercent: 10,
    cores: 8,
    memoryUsedBytes: 8 * GB,
    memoryTotalBytes: 16 * GB,
    memoryPressure: 'normal',
    swapUsedBytes: 0,
    swapTotalBytes: 0,
    sessionsRunning: 0,
    sessionsWorking: 0,
    ...over,
  };
}

describe('machineLevels', () => {
  it('is ok when nothing is loaded', () => {
    expect(machineLevels(summary())).toEqual({ cpu: 'ok', memory: 'ok', swap: 'ok', overall: 'ok' });
  });

  it('puts a value at the threshold into the higher level', () => {
    expect(machineLevels(summary({ cpuPercent: 69.9 })).cpu).toBe('ok');
    expect(machineLevels(summary({ cpuPercent: 70 })).cpu).toBe('high');
    expect(machineLevels(summary({ cpuPercent: 89.9 })).cpu).toBe('high');
    expect(machineLevels(summary({ cpuPercent: 90 })).cpu).toBe('critical');
    expect(machineLevels(summary({ memoryUsedBytes: 8 * GB, memoryTotalBytes: 10 * GB })).memory).toBe(
      'high',
    );
    expect(machineLevels(summary({ memoryUsedBytes: 9 * GB, memoryTotalBytes: 10 * GB })).memory).toBe(
      'critical',
    );
  });

  it('measures the swap against the physical memory, not the swap size', () => {
    // 15.6 GB of swap beside 16 GB of memory is 97%, whatever the swap file size is.
    expect(machineLevels(summary({ swapUsedBytes: 15.6 * GB, swapTotalBytes: 16 * GB })).swap).toBe(
      'critical',
    );
    expect(machineLevels(summary({ swapUsedBytes: 4 * GB, swapTotalBytes: 4 * GB })).swap).toBe('high');
    expect(machineLevels(summary({ swapUsedBytes: 3.9 * GB, swapTotalBytes: 4 * GB })).swap).toBe('ok');
    expect(machineLevels(summary({ swapUsedBytes: 8 * GB, swapTotalBytes: 100 * GB })).swap).toBe('critical');
  });

  it('lets the memory pressure raise the memory level, never lower it', () => {
    expect(machineLevels(summary({ memoryPressure: 'warn' })).memory).toBe('high');
    expect(machineLevels(summary({ memoryPressure: 'critical' })).memory).toBe('critical');
    expect(machineLevels(summary({ memoryPressure: 'warn', memoryUsedBytes: 15 * GB })).memory).toBe(
      'critical',
    );
    expect(machineLevels(summary({ memoryPressure: 'normal', memoryUsedBytes: 15 * GB })).memory).toBe(
      'critical',
    );
  });

  it('keeps unknown values unknown and takes the worst known one as the overall level', () => {
    const none = machineLevels(
      summary({
        cpuPercent: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        memoryPressure: null,
        swapUsedBytes: null,
      }),
    );
    expect(none).toEqual({ cpu: null, memory: null, swap: null, overall: null });
    const some = machineLevels(summary({ cpuPercent: 95, memoryUsedBytes: null, swapUsedBytes: null }));
    expect(some).toEqual({ cpu: 'critical', memory: null, swap: null, overall: 'critical' });
    expect(
      machineLevels(summary({ cpuPercent: null, memoryTotalBytes: null, memoryPressure: 'warn' })),
    ).toMatchObject({
      memory: 'high',
      overall: 'high',
    });
  });
});

describe('StopOrphansRequest', () => {
  it('needs one to fifty processes with a positive pid', () => {
    expect(StopOrphansRequest.safeParse({ orphans: [] }).success).toBe(false);
    expect(StopOrphansRequest.safeParse({ orphans: [{ pid: 0, startedAt: 'x' }] }).success).toBe(false);
    expect(StopOrphansRequest.safeParse({ orphans: [{ pid: 12, startedAt: 'x' }] }).success).toBe(true);
    const many = Array.from({ length: 51 }, (_, i) => ({ pid: i + 1, startedAt: 'x' }));
    expect(StopOrphansRequest.safeParse({ orphans: many }).success).toBe(false);
  });
});
