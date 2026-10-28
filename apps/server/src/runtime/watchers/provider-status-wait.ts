import { Data, Effect } from 'effect';
import { runPromise } from '../../kernel';

/** How long an outage check waits for a provider's status (PM-449). */
const PROVIDER_STATUS_WAIT_MS = 20_000;

class StatusFailed extends Data.TaggedError('StatusFailed')<{ cause: unknown }> {}

/** Failures and late answers are dropped, without waiting for a hanging provider. */
export const statusWithin = <A>(ask: () => Promise<A | null>, ms: number): Effect.Effect<A | null> =>
  Effect.tryPromise({ try: () => ask(), catch: (cause) => new StatusFailed({ cause }) }).pipe(
    Effect.timeoutOrElse({ duration: ms, orElse: () => Effect.succeed(null) }),
    Effect.catchTag('StatusFailed', () => Effect.succeed(null)),
  );

export function waitForStatus<A>(
  ask: () => Promise<A | null>,
  ms = PROVIDER_STATUS_WAIT_MS,
): Promise<A | null> {
  return runPromise(statusWithin(ask, ms));
}
