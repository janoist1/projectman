export interface ShutdownWaitDeps {
  /** The runner's deadline (ms): what has not stopped by then is cut once with `forceLater`. */
  readonly waitMs: number;
  /** How long (ms) after the deadline the wait goes on for the answers of the cut sessions. */
  readonly graceMs: number;
  /** One poll's sleep (ms), at least 1. */
  readonly pollMs: number;
  /** Whether a session whose process runs has not come to its stop yet. */
  readonly stillStopping: () => boolean;
  /** Cuts the sessions of the open pauses whose deadline is still ahead. */
  readonly forceLater: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls until no session is stopping or the deadline plus the grace has passed. The wait is a count of
 * polls times `pollMs`, not wall-clock time: the time `forceLater` takes does not count. A rejected
 * `forceLater` rejects it with the original error.
 */
export async function waitForShutdownStops(deps: ShutdownWaitDeps): Promise<void> {
  const limit = deps.waitMs + deps.graceMs;
  let forced = false;
  for (let waited = 0; deps.stillStopping() && waited < limit; waited += deps.pollMs) {
    // A pause that was open before (a person's, longer) would let the stop cut the sessions mid-turn:
    // what has not stopped by the deadline is cut with one Esc, as the shutdown's own pause would.
    if (!forced && waited >= deps.waitMs) {
      forced = true;
      await deps.forceLater();
    }
    await sleep(deps.pollMs);
  }
}
