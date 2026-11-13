import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyWithinBudget } from './copy-budget';

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const TIMEOUT = 'dependency copying timed out';

describe('copy budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs steps sequentially, finishes successfully and leaves no timer', async () => {
    const first = deferred();
    const calls: string[] = [];
    const done = copyWithinBudget(
      [
        async () => {
          calls.push('first');
          await first.promise;
          calls.push('first finished');
        },
        async () => {
          calls.push('second');
        },
      ],
      100,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['first']);
    first.resolve();
    await done;
    expect(calls).toEqual(['first', 'first finished', 'second']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the original step error and never starts later steps', async () => {
    const error = new Error('disk full');
    const next = vi.fn(async () => undefined);
    await expect(
      copyWithinBudget(
        [
          async () => {
            throw error;
          },
          next,
        ],
        100,
      ),
    ).rejects.toBe(error);
    expect(next).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['reject', 'resolve'] as const)(
    'aborts at the shared deadline and awaits a step that will %s',
    async (settlement) => {
      const stopped = deferred();
      const next = vi.fn(async () => undefined);
      let signal: AbortSignal | undefined;
      let finished = false;
      const rejected = expect(
        copyWithinBudget(
          [
            (current) => {
              signal = current;
              return stopped.promise;
            },
            next,
          ],
          100,
        ),
      ).rejects.toThrow(TIMEOUT);
      void rejected.then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(signal?.aborted).toBe(false);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(finished).toBe(false);
      expect(next).not.toHaveBeenCalled();
      if (settlement === 'reject') stopped.reject(new Error('stopped'));
      else stopped.resolve();
      await rejected;
      expect(next).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('shares the deadline across completed and running steps', async () => {
    const first = deferred();
    let secondSignal: AbortSignal | undefined;
    const rejected = expect(
      copyWithinBudget(
        [
          () => first.promise,
          (signal) => {
            secondSignal = signal;
            return new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          },
        ],
        100,
      ),
    ).rejects.toThrow(TIMEOUT);
    await vi.advanceTimersByTimeAsync(60);
    first.resolve();
    await vi.advanceTimersByTimeAsync(39);
    expect(secondSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(secondSignal?.aborted).toBe(true);
  });
});
