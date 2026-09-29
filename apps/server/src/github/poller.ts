import type { FastifyBaseLogger } from 'fastify';
import type { PullRequestInfo } from '../contracts';
import { toGithubError, type GithubErrorCode } from './errors';
import { pullRequestFingerprint } from './pull-request';
import { isValidPullRequestNumber, isValidRepo } from './refs';

export interface PullRequestTarget {
  /** "owner/name" */
  repo: string;
  number: number;
}

export interface PullRequestPollerOptions {
  /** Each watched PR is fetched this often while it keeps answering. */
  intervalMs: number;
  /** Upper bound for every backoff delay. */
  maxBackoffMs: number;
  /** Minimum pause after GitHub reported rate limiting. */
  rateLimitBackoffMs: number;
  /** Fetches one PR; rejects with a GithubError. Must stop when the signal aborts. */
  fetch(target: PullRequestTarget, signal: AbortSignal): Promise<PullRequestInfo>;
  logger: FastifyBaseLogger;
}

export interface PullRequestPoller {
  /** Same semantics as GithubService.watch. */
  watch(targets: readonly PullRequestTarget[], onChange: (pr: PullRequestInfo) => void): () => void;
}

/**
 * These failures concern every call, not one PR: polling stops for the rest of the round and
 * pauses as a whole (exponential backoff), instead of hammering GitHub with the other PRs.
 * After the pause every PR is picked up again at once. Server errors and timeouts can be caused
 * by one heavy PR, so they only back off that PR.
 */
const GLOBAL_FAILURES: ReadonlySet<GithubErrorCode> = new Set([
  'rate_limited',
  'not_authenticated',
  'not_installed',
  'unreachable',
]);

interface TargetState {
  target: PullRequestTarget;
  /** Consecutive failures that concern only this PR (not found, timeout, server error …). */
  failures: number;
  /** Earliest time (epoch ms) this PR may be fetched again. */
  dueAt: number;
  latest: { fingerprint: string; pr: PullRequestInfo } | null;
}

interface Subscription {
  keys: ReadonlySet<string>;
  onChange: (pr: PullRequestInfo) => void;
  /** Fingerprint of what this subscriber was last told, per PR. */
  lastSeen: Map<string, string>;
}

/**
 * One polling loop for all watchers of a service:
 * - PRs are fetched one at a time; rounds never overlap (the next round is scheduled only
 *   when the previous one has finished);
 * - each PR is fetched every `intervalMs`; a PR watched by several subscribers is fetched
 *   once per round;
 * - each subscriber hears about a PR the first time it is known, then only when it changes
 *   (see pullRequestFingerprint);
 * - a PR that keeps failing is retried after 2×, 4×, 8× … the interval (capped), without
 *   holding up the others; rate limiting, no network or a missing/logged-out gh pauses
 *   everything the same way;
 * - a merged PR cannot change state any more, so it is re-checked only every maxBackoffMs.
 */
export function createPullRequestPoller(opts: PullRequestPollerOptions): PullRequestPoller {
  const { logger } = opts;
  const subscriptions = new Set<Subscription>();
  const targets = new Map<string, TargetState>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDueAt = Number.POSITIVE_INFINITY;
  /** Aborts the in-flight fetch when the last subscriber leaves; non-null while a round runs. */
  let round: AbortController | null = null;
  let globalFailures = 0;
  let pausedUntil = 0;
  const longestDelay = Math.max(opts.maxBackoffMs, opts.intervalMs);

  function backoffDelay(failures: number, minimum = 0): number {
    const exponential = opts.intervalMs * 2 ** Math.min(failures, 30);
    return Math.min(Math.max(exponential, minimum), longestDelay);
  }

  function watch(list: readonly PullRequestTarget[], onChange: (pr: PullRequestInfo) => void): () => void {
    const keys = new Set<string>();
    for (const target of list) {
      if (!isValidRepo(target.repo) || !isValidPullRequestNumber(target.number)) {
        logger.warn(
          { repo: target.repo, number: target.number },
          'github: ignoring invalid pull request to watch',
        );
        continue;
      }
      const key = `${target.repo}#${target.number}`;
      keys.add(key);
      if (!targets.has(key)) {
        targets.set(key, {
          target: { repo: target.repo, number: target.number },
          failures: 0,
          dueAt: 0,
          latest: null,
        });
      }
    }
    if (keys.size === 0) return () => {};

    const subscription: Subscription = { keys, onChange, lastSeen: new Map() };
    subscriptions.add(subscription);
    // PRs another subscriber already knows are reported right away (after watch() returns).
    queueMicrotask(() => {
      for (const key of keys) notify(subscription, key);
    });
    schedule();
    return () => unsubscribe(subscription);
  }

  function unsubscribe(subscription: Subscription): void {
    if (!subscriptions.delete(subscription)) return;
    for (const key of subscription.keys) {
      if (![...subscriptions].some((other) => other.keys.has(key))) targets.delete(key);
    }
    if (subscriptions.size === 0) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      timerDueAt = Number.POSITIVE_INFINITY;
      round?.abort();
    }
  }

  function notify(subscription: Subscription, key: string): void {
    const latest = targets.get(key)?.latest;
    if (!latest || !subscriptions.has(subscription)) return;
    if (subscription.lastSeen.get(key) === latest.fingerprint) return;
    subscription.lastSeen.set(key, latest.fingerprint);
    try {
      subscription.onChange(latest.pr);
    } catch (err) {
      logger.error({ err, key }, 'github: pull request change listener threw');
    }
  }

  /** Arms the timer for the earliest due PR, unless a round is running (it reschedules itself). */
  function schedule(): void {
    if (round !== null || subscriptions.size === 0) return;
    let dueAt = Number.POSITIVE_INFINITY;
    for (const state of targets.values()) dueAt = Math.min(dueAt, state.dueAt);
    if (dueAt === Number.POSITIVE_INFINITY) return;
    dueAt = Math.max(dueAt, pausedUntil);
    if (timer !== null) {
      if (timerDueAt <= dueAt) return;
      clearTimeout(timer);
    }
    timerDueAt = dueAt;
    timer = setTimeout(startRound, Math.max(0, dueAt - Date.now()));
    timer.unref?.();
  }

  function startRound(): void {
    timer = null;
    timerDueAt = Number.POSITIVE_INFINITY;
    const controller = new AbortController();
    round = controller;
    runRound(controller.signal)
      .catch((err: unknown) => logger.error({ err }, 'github: pull request polling round failed'))
      .finally(() => {
        round = null;
        schedule();
      });
  }

  async function runRound(signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    // Longest-waiting first, so a round cut short by rate limiting does not starve anyone.
    const due = [...targets.entries()]
      .filter(([, state]) => state.dueAt <= startedAt)
      .sort(([, a], [, b]) => a.dueAt - b.dueAt);

    for (const [key, state] of due) {
      if (signal.aborted) return;
      if (targets.get(key) !== state) continue; // no longer watched
      try {
        const pr = await opts.fetch(state.target, signal);
        state.failures = 0;
        state.dueAt = startedAt + (pr.state === 'merged' ? longestDelay : opts.intervalMs);
        state.latest = { fingerprint: pullRequestFingerprint(pr), pr };
        globalFailures = 0;
        for (const subscription of [...subscriptions]) {
          if (subscription.keys.has(key)) notify(subscription, key);
        }
      } catch (err) {
        if (signal.aborted) return;
        const error = toGithubError(err);
        if (GLOBAL_FAILURES.has(error.code)) {
          globalFailures += 1;
          const delay = backoffDelay(
            globalFailures,
            error.code === 'rate_limited' ? opts.rateLimitBackoffMs : 0,
          );
          pausedUntil = Date.now() + delay;
          logger.warn(
            { code: error.code, err: error.message, retryInMs: delay },
            'github: pausing pull request polling',
          );
          return;
        }
        state.failures += 1;
        const delay = backoffDelay(state.failures);
        state.dueAt = Date.now() + delay;
        logger.warn(
          {
            ...state.target,
            code: error.code,
            err: error.message,
            failures: state.failures,
            retryInMs: delay,
          },
          'github: polling a pull request failed',
        );
      }
    }
  }

  return { watch };
}
