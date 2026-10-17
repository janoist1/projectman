import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLogSettingError, parseMemoryLogSeconds, startMemoryLog } from './memory-log';
import type { MemoryLogFields } from './memory-log';

const MB = 1024 * 1024;

describe('PROJECTMAN_MEMORY_LOG_SECONDS (PM-775)', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['0', 0],
    ['60', 60],
    ['600', 600],
    ['86400', 86_400],
  ])('accepts %j as %i', (value, seconds) => {
    expect(parseMemoryLogSeconds(value)).toBe(seconds);
  });

  it.each(['59', '86401', 'abc', '-60', '60.5', '1e3', '1 0'])('refuses %j', (value) => {
    expect(() => parseMemoryLogSeconds(value)).toThrow(MemoryLogSettingError);
    expect(() => parseMemoryLogSeconds(value)).toThrow(/PROJECTMAN_MEMORY_LOG_SECONDS/);
  });
});

describe('startMemoryLog (PM-775)', () => {
  let clock: number;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('logs whole megabytes every interval and counts the uptime from the start', () => {
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 300.6 * MB,
      heapUsed: 64.4 * MB,
      heapTotal: 90.5 * MB,
      external: 10.49 * MB,
      arrayBuffers: 1.2 * MB,
    });
    const lines: MemoryLogFields[] = [];
    const stop = startMemoryLog({ intervalS: 60, log: (fields) => lines.push(fields), now: () => clock });

    clock += 60_000;
    vi.advanceTimersByTime(60_000);
    clock += 60_000;
    vi.advanceTimersByTime(60_000);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      module: 'memory',
      rssMb: 301,
      heapUsedMb: 64,
      heapTotalMb: 91,
      externalMb: 10,
      arrayBuffersMb: 1,
      heapLimitMb: expect.any(Number),
      uptimeS: 60,
    });
    expect(Number.isInteger(lines[0]!.heapLimitMb)).toBe(true);
    expect(lines[0]!.heapLimitMb).toBeGreaterThan(0);
    expect(lines[1]!.uptimeS).toBe(120);
    stop();
  });

  it('stops when the returned function is called', () => {
    const lines: MemoryLogFields[] = [];
    const stop = startMemoryLog({ intervalS: 60, log: (fields) => lines.push(fields), now: () => clock });
    vi.advanceTimersByTime(60_000);
    expect(lines).toHaveLength(1);
    stop();
    vi.advanceTimersByTime(600_000);
    expect(lines).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never keeps the process alive', () => {
    const unref = vi.fn();
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof real>) => {
      const timer = real(...args);
      timer.unref = () => {
        unref();
        return timer;
      };
      return timer;
    }) as typeof setInterval);
    const stop = startMemoryLog({ intervalS: 60, log: () => {} });
    expect(unref).toHaveBeenCalledTimes(1);
    stop();
  });
});
