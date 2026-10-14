import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSweeps, type RunningSweeps, type Sweep } from './index';

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('periodic sweeps', () => {
  let running: RunningSweeps | undefined;
  const sweep = (overrides: Partial<Sweep> = {}): Sweep => ({
    name: 'sweep',
    everyMs: 100,
    run: vi.fn(async () => {}),
    onError: vi.fn(),
    ...overrides,
  });
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await running?.stop();
    running = undefined;
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('starts only startup rounds inline, in list order', () => {
    const calls: string[] = [];
    const items = ['first', 'later', 'last'].map((name) =>
      sweep({
        name,
        atStart: name !== 'later',
        run: async () => {
          calls.push(name);
        },
      }),
    );
    running = startSweeps(items);
    expect(calls).toEqual(['first', 'last']);
  });

  it('ticks at the configured interval', async () => {
    const item = sweep();
    running = startSweeps([item]);
    await vi.advanceTimersByTimeAsync(99);
    expect(item.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(item.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(item.run).toHaveBeenCalledTimes(2);
  });

  it('keeps the tick cadence when a round takes half an interval', async () => {
    const round = deferred();
    const run = vi.fn().mockReturnValueOnce(round.promise).mockResolvedValue(undefined);
    running = startSweeps([sweep({ run })]);
    await vi.advanceTimersByTimeAsync(150);
    round.resolve();
    await vi.advanceTimersByTimeAsync(49);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('skips overlapping ticks without delaying other sweeps or queueing rounds', async () => {
    const round = deferred();
    const slow = sweep({ run: vi.fn().mockReturnValueOnce(round.promise).mockResolvedValue(undefined) });
    const fast = sweep({ name: 'other' });
    running = startSweeps([slow, fast]);
    await vi.advanceTimersByTimeAsync(300);
    expect(slow.run).toHaveBeenCalledTimes(1);
    expect(fast.run).toHaveBeenCalledTimes(3);
    round.resolve();
    await vi.advanceTimersByTimeAsync(99);
    expect(slow.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(slow.run).toHaveBeenCalledTimes(2);
  });

  it.each(['reject', 'throw'])('reports the original error from a %s and keeps ticking', async (mode) => {
    const error = new Error('round failed');
    const run = vi.fn(() => {
      if (mode === 'throw') throw error;
      return Promise.reject(error);
    });
    const onError = vi.fn();
    running = startSweeps([sweep({ run, onError })]);
    await vi.advanceTimersByTimeAsync(200);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('contains errors thrown by the error handler', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const run = vi.fn(async () => {
        throw new Error('failed');
      });
      running = startSweeps([
        sweep({
          run,
          onError: () => {
            throw new Error('handler failed');
          },
        }),
      ]);
      await vi.advanceTimersByTimeAsync(200);
      expect(run).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it.each(['resolve', 'reject'])('stops ticks inline and waits for a running round to %s', async (mode) => {
    const round = deferred();
    const item = sweep({ atStart: true, run: vi.fn(() => round.promise) });
    running = startSweeps([item]);
    const stopped = running.stop();
    expect(running.stop()).toBe(stopped);
    const settled = vi.fn();
    void stopped.then(settled);
    await vi.advanceTimersByTimeAsync(300);
    expect(item.run).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    const error = new Error('failed during stop');
    if (mode === 'reject') round.reject(error);
    else round.resolve();
    await stopped;
    expect(settled).toHaveBeenCalledTimes(1);
    if (mode === 'reject') expect(item.onError).toHaveBeenCalledWith(error);
  });

  it('clamps a zero interval to one millisecond', async () => {
    const item = sweep({ everyMs: 0 });
    running = startSweeps([item]);
    await vi.advanceTimersByTimeAsync(1);
    expect(item.run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('rejects duplicate names before starting any round or timer', () => {
    const item = sweep({ atStart: true });
    expect(() => startSweeps([item, item])).toThrow('sweep "sweep" is listed twice');
    expect(item.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
