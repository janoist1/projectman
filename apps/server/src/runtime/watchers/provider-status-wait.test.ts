import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForStatus } from './provider-status-wait';

describe('Provider status wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns answers and drops rejected or synchronously thrown failures', async () => {
    expect(await waitForStatus(() => Promise.resolve('ready'), 20)).toBe('ready');
    expect(await waitForStatus(() => Promise.resolve(null), 20)).toBeNull();
    expect(await waitForStatus(() => Promise.reject(new Error('failed')), 20)).toBeNull();
    expect(
      await waitForStatus(() => {
        throw new Error('failed');
      }, 20),
    ).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits exactly until the deadline and drops a late answer', async () => {
    let resolve!: (value: string) => void;
    const answer = new Promise<string>((done) => {
      resolve = done;
    });
    let result: string | null | undefined;
    void waitForStatus(() => answer, 20).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(19);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
    resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
