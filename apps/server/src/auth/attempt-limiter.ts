import { DomainError } from '../domain/errors';

export interface AttemptLimiterOptions {
  /** Attempts a key may use up per window. */
  max: number;
  windowMs: number;
  /** Message of the 429 `too_many_attempts` error. */
  message: string;
  now?: () => number;
}

export interface AttemptLimiter {
  /**
   * Reserves an attempt for `key` (the peer address) before the expensive or guessable work,
   * so concurrent attempts count too; throws 429 `too_many_attempts` once the window's budget
   * is used up. Call the returned `release` when the attempt succeeded: only failures count.
   */
  reserve(key: string): () => void;
}

/**
 * Fixed-window attempt budget per key, in memory (a restart resets it). Behind a local proxy
 * (`tailscale serve`) every user shares the proxy's address, which is why successful attempts
 * give their slot back.
 */
export function createAttemptLimiter(opts: AttemptLimiterOptions): AttemptLimiter {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    reserve(key) {
      const at = now();
      // Bound memory even when attempts arrive from many addresses.
      for (const [k, window] of windows) if (window.resetAt <= at) windows.delete(k);
      const window = windows.get(key) ?? { count: 0, resetAt: at + opts.windowMs };
      if (window.count >= opts.max) {
        throw new DomainError('too_many_attempts', opts.message, { status: 429 });
      }
      window.count += 1;
      windows.set(key, window);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (windows.get(key) === window && window.count > 0) window.count -= 1;
      };
    },
  };
}
