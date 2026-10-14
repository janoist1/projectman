import { DomainError } from '../domain/errors';

/**
 * Failed attempts all clients together may use up per window, next to each client's own budget.
 * Without it a client that can change its address (or one that sends a different trusted header
 * value every time) has no limit at all. 50 is five times a client's 10: a handful of real users
 * who mistype never get near it, while guessing stays at 50 tries per 15 minutes in total, a
 * rate the Argon2id hash and the long random invitation tokens make worthless. The price is that
 * a flood of failures from one attacker can lock everybody out until the window ends; that is
 * the safer way to fail, and the owner's access layer sits in front.
 */
export const MAX_FAILED_ATTEMPTS_ALL_CLIENTS = 50;

export interface AttemptLimiterOptions {
  /** Attempts a key may use up per window. */
  max: number;
  /** Attempts all keys together may use up per window (default: no shared cap). */
  sharedMax?: number;
  windowMs: number;
  /** Message of the 429 `too_many_attempts` error. */
  message: string;
  now?: () => number;
}

export interface AttemptLimiter {
  /**
   * Reserves an attempt for `key` (the client's address) before the expensive or guessable work,
   * so concurrent attempts count too; throws 429 `too_many_attempts` once the window's budget of
   * the key, or the shared one, is used up. Call the returned `release` when the attempt
   * succeeded: only failures count, and it gives the slot back in both budgets.
   */
  reserve(key: string): () => void;
}

interface Budget {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window attempt budget per key and, optionally, for all keys together, in memory (a
 * restart resets it). Behind a local proxy every user shares the proxy's address unless it
 * names the client (`clientAddress`), which is why successful attempts give their slot back.
 */
export function createAttemptLimiter(opts: AttemptLimiterOptions): AttemptLimiter {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, Budget>();
  let shared: Budget | undefined;

  return {
    reserve(key) {
      const at = now();
      // Bound memory even when attempts arrive from many addresses.
      for (const [k, window] of windows) if (window.resetAt <= at) windows.delete(k);
      const window = windows.get(key) ?? { count: 0, resetAt: at + opts.windowMs };
      if (!shared || shared.resetAt <= at) shared = { count: 0, resetAt: at + opts.windowMs };
      const all = shared;
      // Both budgets are checked before either is charged.
      if (window.count >= opts.max || (opts.sharedMax !== undefined && all.count >= opts.sharedMax)) {
        throw new DomainError('too_many_attempts', opts.message, { status: 429 });
      }
      window.count += 1;
      all.count += 1;
      windows.set(key, window);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // A slot of an expired window is not credited to the new one.
        if (windows.get(key) === window && window.count > 0) window.count -= 1;
        if (shared === all && all.count > 0) all.count -= 1;
      };
    },
  };
}
