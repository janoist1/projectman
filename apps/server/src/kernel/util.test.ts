import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleep } from './util';

describe('sleep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves only after the given time', async () => {
    vi.useFakeTimers();
    let done = false;
    const waiting = sleep(100).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
  });
});
