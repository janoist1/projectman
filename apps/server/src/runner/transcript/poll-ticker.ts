import { Effect } from 'effect';

/** Calls `tick` every `intervalMs` (at least 1 ms) until interrupted: the tailer's polling fallback. */
export const pollEvery = (intervalMs: number, tick: () => void): Effect.Effect<never> =>
  Effect.forever(Effect.sleep(Math.max(1, intervalMs)).pipe(Effect.andThen(Effect.sync(tick))), {
    disableYield: true,
  });
