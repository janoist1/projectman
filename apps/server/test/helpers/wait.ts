interface WaitOptions {
  /** How long to keep asking before giving up. */
  timeoutMs?: number;
  /** The pause between two asks. */
  intervalMs?: number;
  /** What is waited for; names the failure. A function is called only when the wait fails. */
  what?: string | (() => string);
}

type Check<T> = () => T | undefined | null | false | Promise<T | undefined | null | false>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 20;

/** The last ask is made after the deadline, so a condition that came true in the final pause counts. */
async function poll<T>(check: Check<T>, options: WaitOptions): Promise<T | undefined> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = DEFAULT_INTERVAL_MS } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Asks `check` until it returns something truthy and returns that value; throws once the deadline
 * has passed. `check` may be async. A bare string is the `what` shorthand.
 */
export async function waitFor<T>(check: Check<T>, options: WaitOptions | string = {}): Promise<T> {
  const { what = 'condition', ...timing } = typeof options === 'string' ? { what: options } : options;
  const value = await poll(check, timing);
  if (value) return value;
  throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}`);
}

/** Like `waitFor`, for a test that asserts the outcome itself: resolves `false` instead of throwing. */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  options: Omit<WaitOptions, 'what'> = {},
): Promise<boolean> {
  return Boolean(await poll(check, options));
}
