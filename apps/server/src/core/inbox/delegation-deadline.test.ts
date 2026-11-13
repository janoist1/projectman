import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegationDeadlineTimer } from './delegation-deadline';

describe('DelegationDeadlineTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(sweep: () => Promise<void> = async () => {}) {
    const run = vi.fn(sweep);
    const timer = new DelegationDeadlineTimer({ now: () => Date.now(), sweep: run });
    return { timer, run };
  }

  it('sweeps once at the start and then waits, with no timer, while no deadline is noted', async () => {
    const { timer, run } = setup();
    timer.start();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    timer.stop();
  });

  it('sweeps when the earliest noted deadline passes, and a later one does not move it', async () => {
    const { timer, run } = setup();
    timer.start();
    run.mockClear();
    timer.note(Date.now() + 2000);
    timer.note(Date.now() + 5000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  it('moves up for a sooner deadline and stays inert before the start and after the stop', async () => {
    const { timer, run } = setup();
    timer.note(Date.now() + 1000);
    expect(vi.getTimerCount()).toBe(0);
    timer.start();
    run.mockClear();
    timer.note(Date.now() + 5000);
    timer.note(Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    timer.stop();
    timer.note(Date.now() + 1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tries again soon when the sweep fails', async () => {
    let fail = true;
    const { timer, run } = setup(async () => {
      if (fail) throw new Error('could not read');
    });
    timer.start();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
    timer.stop();
  });
});
