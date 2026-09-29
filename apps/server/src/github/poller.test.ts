import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestInfo } from '../contracts';
import { GithubError, type GithubErrorCode } from './errors';
import { createPullRequestPoller, type PullRequestPollerOptions, type PullRequestTarget } from './poller';
import { createTestLogger, pullRequestInfo } from './test-fixtures/harness';

const INTERVAL = 1000;
const A: PullRequestTarget = { repo: 'acme/app', number: 12 };
const B: PullRequestTarget = { repo: 'acme/app', number: 13 };
const C: PullRequestTarget = { repo: 'acme/api', number: 4 };

type Result = PullRequestInfo | GithubError;
/** One scripted answer; a slow one resolves after `delayMs`. */
type Step = Result | { delayMs: number; result: Result };

const keyOf = (target: PullRequestTarget) => `${target.repo}#${target.number}`;
const failure = (code: GithubErrorCode) => new GithubError(code, `simulated ${code}`);

/** A fetch that follows a script per PR (the last step repeats) and records every call. */
function createFakeFetch(script: Record<string, Step[]>) {
  const calls: Array<{ key: string; at: number }> = [];
  const counts = new Map<string, number>();
  const stats = { active: 0, maxActive: 0, aborted: 0 };

  async function fetch(target: PullRequestTarget, signal: AbortSignal): Promise<PullRequestInfo> {
    const key = keyOf(target);
    calls.push({ key, at: Date.now() });
    const count = counts.get(key) ?? 0;
    counts.set(key, count + 1);
    const steps = script[key];
    if (!steps?.length) throw new Error(`no script for ${key}`);
    const step = steps[Math.min(count, steps.length - 1)]!;
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      let result: Result;
      if ('delayMs' in step) {
        await sleep(step.delayMs, signal).catch((err: unknown) => {
          stats.aborted += 1;
          throw err;
        });
        result = step.result;
      } else {
        result = step;
      }
      if (result instanceof Error) throw result;
      return result;
    } finally {
      stats.active -= 1;
    }
  }

  return { fetch, calls, stats };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new GithubError('aborted', 'aborted'));
      },
      { once: true },
    );
  });
}

let t0 = 0;

function setup(script: Record<string, Step[]>, options: Partial<PullRequestPollerOptions> = {}) {
  const fake = createFakeFetch(script);
  const logger = createTestLogger();
  const poller = createPullRequestPoller({
    intervalMs: INTERVAL,
    maxBackoffMs: 8 * INTERVAL,
    rateLimitBackoffMs: 5 * INTERVAL,
    fetch: fake.fetch,
    logger,
    ...options,
  });
  /** Start times (ms since the test began) of the calls for one PR. */
  const callTimes = (target: PullRequestTarget) =>
    fake.calls.filter((call) => call.key === keyOf(target)).map((call) => call.at - t0);
  return { poller, fake, logger, callTimes };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-29T10:00:00Z') });
  t0 = Date.now();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pull request poller', () => {
  it('reports the first state, then only real changes', async () => {
    const open = pullRequestInfo({ checks: 'pending' });
    const commented = pullRequestInfo({ checks: 'pending', updatedAt: '2026-09-29T11:00:00Z' });
    const green = pullRequestInfo({ checks: 'success', updatedAt: '2026-09-29T11:05:00Z' });
    const { poller, fake } = setup({ [keyOf(A)]: [open, commented, green, green] });
    const onChange = vi.fn();

    poller.watch([A], onChange);
    await advance(0);
    expect(onChange.mock.calls).toEqual([[open]]);

    await advance(INTERVAL);
    expect(fake.calls).toHaveLength(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    await advance(INTERVAL);
    expect(onChange.mock.calls).toEqual([[open], [green]]);

    await advance(INTERVAL);
    expect(fake.calls).toHaveLength(4);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('fetches every PR once per interval, one call at a time', async () => {
    const slow = (number: number) => ({ delayMs: 300, result: pullRequestInfo({ number }) });
    const { poller, fake, callTimes } = setup({
      [keyOf(A)]: [slow(12)],
      [keyOf(B)]: [slow(13)],
      [keyOf(C)]: [slow(4)],
    });

    poller.watch([A, B, C], vi.fn());
    await advance(4 * INTERVAL + 500);

    expect(callTimes(A)).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(callTimes(B)).toEqual([300, 1300, 2300, 3300, 4300]);
    expect(callTimes(C)).toEqual([600, 1600, 2600, 3600]);
    expect(fake.stats.maxActive).toBe(1);
  });

  it('never overlaps rounds when calls are slower than the interval', async () => {
    const { poller, fake, callTimes } = setup({
      [keyOf(A)]: [{ delayMs: 1500, result: pullRequestInfo() }],
    });

    poller.watch([A], vi.fn());
    await advance(6000);

    // Each round starts right after the previous one ended (+1 ms: Node runs a 0 ms timeout after 1 ms).
    expect(callTimes(A)).toEqual([0, 1501, 3002, 4503]);
    expect(fake.stats.maxActive).toBe(1);
  });

  it('backs off a failing PR exponentially without holding up the others', async () => {
    const recovered = pullRequestInfo({ checks: 'success' });
    const { poller, logger, callTimes } = setup({
      [keyOf(A)]: [...Array.from({ length: 5 }, () => failure('not_found')), recovered],
      [keyOf(B)]: [pullRequestInfo({ number: 13 })],
    });
    const onChange = vi.fn();

    poller.watch([A, B], onChange);
    await advance(31_000);

    // 2×, 4×, 8× the interval, then capped at maxBackoffMs (8 s); back to normal after a success.
    expect(callTimes(A)).toEqual([0, 2000, 6000, 14_000, 22_000, 30_000, 31_000]);
    expect(callTimes(B)).toEqual(Array.from({ length: 32 }, (_, i) => i * 1000));
    expect(onChange.mock.calls.map(([pr]) => pr.number)).toEqual([13, 12]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'acme/app', number: 12, code: 'not_found', failures: 5 }),
      expect.any(String),
    );
  });

  it('pauses everything on rate limiting, with a minimum pause and exponential growth', async () => {
    const { poller, callTimes } = setup({
      [keyOf(A)]: [
        failure('rate_limited'),
        failure('rate_limited'),
        failure('rate_limited'),
        pullRequestInfo(),
      ],
      [keyOf(B)]: [pullRequestInfo({ number: 13 })],
    });

    poller.watch([A, B], vi.fn());
    await advance(17_999);
    // max(2×interval, 5 s) = 5 s, max(4×, 5 s) = 5 s, then 8×interval = 8 s.
    expect(callTimes(A)).toEqual([0, 5000, 10_000]);
    expect(callTimes(B)).toEqual([]);

    await advance(1_001);
    expect(callTimes(A)).toEqual([0, 5000, 10_000, 18_000, 19_000]);
    expect(callTimes(B)).toEqual([18_000, 19_000]);
  });

  it.each(['not_authenticated', 'not_installed', 'unreachable'] as const)(
    'pauses everything when gh fails with %s',
    async (code) => {
      const { poller, callTimes } = setup({
        [keyOf(A)]: [failure(code), pullRequestInfo()],
        [keyOf(B)]: [pullRequestInfo({ number: 13 })],
      });

      poller.watch([A, B], vi.fn());
      await advance(1999);
      expect(callTimes(A)).toEqual([0]);
      expect(callTimes(B)).toEqual([]);

      await advance(1);
      expect(callTimes(A)).toEqual([0, 2000]);
      expect(callTimes(B)).toEqual([2000]);
    },
  );

  it.each(['timeout', 'server_error', 'invalid_response', 'failed'] as const)(
    'backs off only the affected PR on %s',
    async (code) => {
      const { poller, callTimes } = setup({
        [keyOf(A)]: [failure(code), pullRequestInfo()],
        [keyOf(B)]: [pullRequestInfo({ number: 13 })],
      });

      poller.watch([A, B], vi.fn());
      await advance(2000);

      expect(callTimes(A)).toEqual([0, 2000]);
      expect(callTimes(B)).toEqual([0, 1000, 2000]);
    },
  );

  it('re-checks a merged PR only every maxBackoffMs', async () => {
    const { poller, callTimes } = setup({
      [keyOf(A)]: [pullRequestInfo(), pullRequestInfo({ state: 'merged' })],
      [keyOf(B)]: [pullRequestInfo({ number: 13, state: 'closed' })],
    });
    const onChange = vi.fn();

    poller.watch([A, B], onChange);
    await advance(18_000);

    expect(callTimes(A)).toEqual([0, 1000, 9000, 17_000]);
    expect(callTimes(B)).toHaveLength(19);
    expect(onChange.mock.calls.map(([pr]) => [pr.number, pr.state])).toEqual([
      [12, 'open'],
      [13, 'closed'],
      [12, 'merged'],
    ]);
  });

  it('stops polling after unsubscribe and aborts the call in flight', async () => {
    const { poller, fake } = setup({ [keyOf(A)]: [{ delayMs: 500, result: pullRequestInfo() }] });
    const onChange = vi.fn();

    const unsubscribe = poller.watch([A], onChange);
    await advance(100);
    unsubscribe();
    unsubscribe(); // idempotent
    await advance(10 * INTERVAL);

    expect(onChange).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(1);
    expect(fake.stats.aborted).toBe(1);
  });

  it('keeps polling for the remaining subscribers', async () => {
    const { poller, callTimes } = setup({
      [keyOf(A)]: [pullRequestInfo()],
      [keyOf(B)]: [pullRequestInfo({ number: 13 })],
    });

    const stopFirst = poller.watch([A, B], vi.fn());
    poller.watch([B], vi.fn());
    await advance(0);
    stopFirst();
    await advance(2 * INTERVAL);

    expect(callTimes(A)).toEqual([0]);
    expect(callTimes(B)).toEqual([0, 1000, 2000]);
  });

  it('shares fetches between subscribers and tells a late subscriber the known state at once', async () => {
    const pr = pullRequestInfo();
    const { poller, fake } = setup({ [keyOf(A)]: [pr] });
    const first = vi.fn();
    const second = vi.fn();

    poller.watch([A], first);
    await advance(0);
    poller.watch([A], second);
    await advance(0);

    expect(first.mock.calls).toEqual([[pr]]);
    expect(second.mock.calls).toEqual([[pr]]);
    expect(fake.calls).toHaveLength(1);

    await advance(INTERVAL);
    expect(fake.calls).toHaveLength(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('fetches a newly watched PR right away without delaying the others', async () => {
    const { poller, callTimes } = setup({
      [keyOf(A)]: [pullRequestInfo()],
      [keyOf(B)]: [pullRequestInfo({ number: 13 })],
    });

    poller.watch([A], vi.fn());
    await advance(300);
    poller.watch([B], vi.fn());
    await advance(1100);

    expect(callTimes(A)).toEqual([0, 1000]);
    expect(callTimes(B)).toEqual([300, 1300]);
  });

  it('keeps polling when a listener throws', async () => {
    const { poller, logger } = setup({
      [keyOf(A)]: [pullRequestInfo(), pullRequestInfo({ state: 'merged' })],
    });
    const onChange = vi.fn(() => {
      throw new Error('listener bug');
    });

    poller.watch([A], onChange);
    await advance(INTERVAL);

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('ignores invalid and duplicate targets', async () => {
    const { poller, fake, logger } = setup({ [keyOf(A)]: [pullRequestInfo()] });

    poller.watch([A, { ...A }, { repo: 'not a repo', number: 1 }, { repo: 'acme/app', number: 0 }], vi.fn());
    const noop = poller.watch([], vi.fn());
    await advance(0);

    expect(fake.calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(noop).toBeTypeOf('function');
    noop();
  });
});
