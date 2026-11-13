/** How long an outage check waits for a provider's status (PM-449). */
const PROVIDER_STATUS_WAIT_MS = 20_000;

/** Failures and late answers are dropped, without waiting for a hanging provider. */
export function waitForStatus<A>(
  ask: () => Promise<A | null>,
  ms = PROVIDER_STATUS_WAIT_MS,
): Promise<A | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const settle = (value: A | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    try {
      ask().then(settle, () => settle(null));
    } catch {
      settle(null);
    }
  });
}
