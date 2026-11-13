import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForShutdownStops, type ShutdownWaitDeps } from './shutdown-wait';

/**
 * The shutdown wait under fake timers (the poll counter to the millisecond). The end-to-end shutdown is
 * covered by test/pause-shutdown.test.ts.
 */

function depsOf(overrides: Partial<ShutdownWaitDeps> = {}) {
  const state = { stopping: true, polls: 0 };
  const forceLater = vi.fn(async () => {});
  const deps: ShutdownWaitDeps = {
    waitMs: 1_000,
    graceMs: 1_000,
    pollMs: 50,
    stillStopping: () => {
      state.polls += 1;
      return state.stopping;
    },
    forceLater,
    ...overrides,
  };
  return { deps, state, forceLater };
}

/** Starts the wait in the background; `finished.done` turns true when it ends. */
function startWait(deps: ShutdownWaitDeps) {
  const finished = { done: false };
  const wait = waitForShutdownStops(deps).then(() => {
    finished.done = true;
  });
  return { finished, wait };
}

describe('shutdown wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is done at once when nothing is stopping: no force, no sleep', async () => {
    const { deps, forceLater, state } = depsOf();
    state.stopping = false;
    await waitForShutdownStops(deps);
    expect(forceLater).not.toHaveBeenCalled();
    expect(state.polls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks again after each poll and ends when nothing is stopping', async () => {
    const { deps, state } = depsOf({ pollMs: 50 });
    const { finished, wait } = startWait(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.polls).toBe(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(state.polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.polls).toBe(2);
    expect(finished.done).toBe(false);
    state.stopping = false;
    await vi.advanceTimersByTimeAsync(50);
    await wait;
    expect(state.polls).toBe(3);
    expect(finished.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cuts exactly once, after the second sleep, when the deadline passes', async () => {
    const { deps, forceLater } = depsOf({ waitMs: 100, graceMs: 1_000, pollMs: 50 });
    startWait(deps);
    await vi.advanceTimersByTimeAsync(99);
    expect(forceLater).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(forceLater).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(forceLater).toHaveBeenCalledTimes(1);
  });

  it('cuts before the first sleep when the deadline is zero', async () => {
    const { deps, forceLater, state } = depsOf({ waitMs: 0, graceMs: 1_000, pollMs: 50 });
    startWait(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(forceLater).toHaveBeenCalledTimes(1);
    expect(state.polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(forceLater).toHaveBeenCalledTimes(1);
  });

  it('gives up at the deadline plus the grace (three sleeps)', async () => {
    const { deps, forceLater } = depsOf({ waitMs: 50, graceMs: 100, pollMs: 50 });
    const { finished } = startWait(deps);
    await vi.advanceTimersByTimeAsync(149);
    expect(finished.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(finished.done).toBe(true);
    expect(forceLater).toHaveBeenCalledTimes(1);
  });

  it('rejects with the original error when the cut fails', async () => {
    const error = new Error('boom');
    const { deps } = depsOf({ waitMs: 0, forceLater: async () => Promise.reject(error) });
    await expect(waitForShutdownStops(deps)).rejects.toBe(error);
  });
});
