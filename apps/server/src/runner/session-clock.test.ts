import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionClock, waitAtMost } from './session-clock';

describe('SessionClock', () => {
  let clock: SessionClock;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = new SessionClock();
  });
  afterEach(() => {
    clock.close();
    vi.useRealTimers();
  });

  it('fires once at the exact deadline and forgets the completed key', async () => {
    const callback = vi.fn();
    clock.after('compaction', 20, callback);
    await vi.advanceTimersByTimeAsync(19);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
    clock.cancel('compaction');
    clock.cancel('pause-deadline');
    await vi.advanceTimersByTimeAsync(20);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces a key immediately but preserves it with ifMissing', async () => {
    const old = vi.fn();
    const replacement = vi.fn();
    const skipped = vi.fn();
    clock.after('compaction', 10, old);
    clock.after('compaction', 20, replacement);
    clock.after('compaction', 1, skipped, { ifMissing: true });
    await vi.advanceTimersByTimeAsync(19);
    expect(old).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    expect(skipped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it('cancels a key without affecting independent calls', async () => {
    const cancelled = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    clock.after('compaction', 10, cancelled);
    clock.once(10, first);
    clock.once(20, second);
    clock.cancel('compaction');
    await vi.advanceTimersByTimeAsync(10);
    expect(cancelled).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(second).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the repeating phase and lets the callback cancel the next tick', async () => {
    const callback = vi.fn(() => {
      if (callback.mock.calls.length === 3) clock.cancel('startup-watch');
    });
    const skipped = vi.fn();
    clock.every('startup-watch', 10, callback);
    await vi.advanceTimersByTimeAsync(5);
    clock.every('startup-watch', 20, skipped);
    await vi.advanceTimersByTimeAsync(4);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(callback).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(callback).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30);
    expect(callback).toHaveBeenCalledTimes(3);
    expect(skipped).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows callbacks to replace and rearm their own key', async () => {
    const final = vi.fn();
    const repeated = vi.fn(() => {
      clock.every('compaction', 10, final);
      clock.after('compaction', 5, final);
    });
    clock.after('compaction', 5, () => clock.every('compaction', 10, repeated));
    await vi.advanceTimersByTimeAsync(15);
    expect(repeated).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(final).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(final).toHaveBeenCalledTimes(1);
  });

  it.each([0, -10])('clamps a delay of %s to one millisecond', async (delay) => {
    const callback = vi.fn();
    clock.once(delay, callback);
    clock.after('compaction', delay, callback);
    clock.every('startup-watch', delay, () => {
      callback();
      clock.cancel('startup-watch');
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('drops every timer on close and ignores later calls and repeated close', async () => {
    const callback = vi.fn();
    clock.once(10, callback);
    clock.after('compaction', 20, callback);
    clock.every('process-probe', 30, callback);
    clock.close();
    expect(vi.getTimerCount()).toBe(0);
    clock.once(1, callback);
    clock.after('pause-deadline', 1, callback);
    clock.every('startup-watch', 1, callback);
    clock.cancel('compaction');
    clock.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up the deadline when the final read finishes first', async () => {
    await waitAtMost(() => Promise.resolve(), 20);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a final read that never finishes', async () => {
    const done = vi.fn();
    const pending = waitAtMost(() => new Promise(() => undefined), 20).then(done);
    await vi.advanceTimersByTimeAsync(19);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -10])('bounds a final read with a %s deadline at one millisecond', async (delay) => {
    const done = vi.fn();
    const pending = waitAtMost(() => new Promise(() => undefined), delay).then(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toHaveBeenCalledTimes(1);
  });
});
