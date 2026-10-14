import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTimers } from './session-timers';

describe('SessionTimers', () => {
  const logger = { error: vi.fn() };
  let timers: SessionTimers;
  beforeEach(() => {
    vi.useFakeTimers();
    logger.error.mockClear();
    timers = new SessionTimers(logger);
  });
  afterEach(() => {
    timers.close();
    vi.useRealTimers();
  });

  it('fires once, exactly at the deadline', async () => {
    const fire = vi.fn();
    timers.arm('turn', 's1', 100, fire);
    await vi.advanceTimersByTimeAsync(99);
    expect(fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('keeps the first deadline when the key is armed again', async () => {
    const first = vi.fn();
    const second = vi.fn();
    timers.arm('turn', 's1', 100, first);
    await vi.advanceTimersByTimeAsync(50);
    timers.arm('turn', 's1', 100, second);
    await vi.advanceTimersByTimeAsync(50);
    expect(first).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(second).not.toHaveBeenCalled();
  });

  it('does not fire a disarmed key', async () => {
    const fire = vi.fn();
    timers.arm('input', 's1', 100, fire);
    timers.disarm('input', 's1');
    await vi.advanceTimersByTimeAsync(500);
    expect(fire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits at least 1 ms, so a zero delay never runs inside the arming call', async () => {
    const fire = vi.fn();
    timers.arm('cleanup', 'k', 0, fire);
    expect(fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('lets a call arm its own key again, and it fires', async () => {
    const calls: string[] = [];
    timers.arm('turn', 's1', 10, () => {
      calls.push('first');
      timers.arm('turn', 's1', 10, () => calls.push('second'));
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(['first']);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(['first', 'second']);
  });

  it('lets a call disarm its own key without cutting itself', async () => {
    const fire = vi.fn(() => timers.disarm('turn', 's1'));
    timers.arm('turn', 's1', 10, fire);
    await vi.advanceTimersByTimeAsync(10);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('logs a call that throws and goes on with the others', async () => {
    const boom = new Error('boom');
    const other = vi.fn();
    timers.arm('turn', 'a', 10, () => {
      throw boom;
    });
    timers.arm('turn', 'b', 10, other);
    await vi.advanceTimersByTimeAsync(10);
    expect(other).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith({ err: boom, group: 'turn', key: 'a' }, 'session timer failed');
  });

  it('keeps the groups apart', async () => {
    const turn = vi.fn();
    const input = vi.fn();
    timers.arm('turn', 'k', 10, turn);
    timers.arm('input', 'k', 10, input);
    timers.disarm('turn', 'k');
    await vi.advanceTimersByTimeAsync(10);
    expect(turn).not.toHaveBeenCalled();
    expect(input).toHaveBeenCalledTimes(1);
  });

  it('fires nothing after close, arms nothing, and leaves no timer behind', async () => {
    const fire = vi.fn();
    timers.arm('turn', 'a', 10, fire);
    timers.arm('cleanup', 'b', 10, fire);
    timers.close();
    timers.arm('turn', 'c', 10, fire);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fire).not.toHaveBeenCalled();
  });
});
