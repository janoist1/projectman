import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeWithin, type ProbeProcess } from './plan-usage-probe';

function processOf(running = true) {
  let answer!: (value: unknown) => void;
  let close!: () => void;
  const child: ProbeProcess = {
    answer: new Promise((resolve) => {
      answer = resolve;
    }),
    closed: new Promise((resolve) => {
      close = () => {
        running = false;
        resolve();
      };
    }),
    end: vi.fn(),
    running: () => running,
    kill: vi.fn(),
  };
  return { child, answer, close };
}

describe('plan usage probe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the answer, ends stdin once and cancels reaping on closure', async () => {
    const { child, answer, close } = processOf();
    const probe = probeWithin(child, 100, 50);
    answer({ usage: 42 });
    expect(await probe).toEqual({ usage: 42 });
    expect(child.end).toHaveBeenCalledTimes(1);
    close();
    await vi.advanceTimersByTimeAsync(50);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out exactly at the answer deadline and kills after the grace period', async () => {
    const { child } = processOf();
    let settled = false;
    const probe = probeWithin(child, 100, 50).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    expect(child.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await probe).toBeNull();
    expect(child.end).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('does not kill a process that never started', async () => {
    const { child, answer, close } = processOf(false);
    answer(null);
    close();
    expect(await probeWithin(child, 100, 50)).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
