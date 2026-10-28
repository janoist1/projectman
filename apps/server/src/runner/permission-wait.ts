import { Data, Duration, Effect } from 'effect';
import type { PermissionBroker, PermissionDecision, PermissionRequestInfo } from '../contracts';

/** How one request ended. The session's exit is an interruption, not an outcome. */
export type PermissionWaitOutcome =
  | { readonly kind: 'decided'; readonly decision: PermissionDecision }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'withdrawn' }
  | { readonly kind: 'failed'; readonly cause: unknown };

class BrokerFailed extends Data.TaggedError('BrokerFailed')<{ readonly cause: unknown }> {}

export interface PermissionWaitInput {
  broker: PermissionBroker;
  request: PermissionRequestInfo;
  /** How long the request may wait for a human. */
  timeoutMs: number;
  /** Aborts when the CLI stops waiting (the hook request closed). */
  withdrawn: AbortSignal;
}

const withdrawnOutcome = (signal: AbortSignal): Effect.Effect<PermissionWaitOutcome> =>
  Effect.callback((resume) => {
    const onAbort = () => resume(Effect.succeed({ kind: 'withdrawn' }));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', onAbort));
  });

export const awaitPermission = (input: PermissionWaitInput): Effect.Effect<PermissionWaitOutcome> => {
  const brokerDecision = Effect.callback<PermissionDecision, BrokerFailed>((resume) => {
    const controller = new AbortController();
    try {
      input.broker.decide(input.request, controller.signal).then(
        (decision) => resume(Effect.succeed(decision)),
        (cause) => resume(Effect.fail(new BrokerFailed({ cause }))),
      );
    } catch (cause) {
      resume(Effect.fail(new BrokerFailed({ cause })));
    }
    // Do not wait for the broker: the denial must reach the CLI before its hook timeout.
    return Effect.sync(() => controller.abort(new Error('permission request ended')));
  });
  return brokerDecision.pipe(
    Effect.map((decision): PermissionWaitOutcome => ({ kind: 'decided', decision })),
    Effect.catchTag('BrokerFailed', ({ cause }) =>
      Effect.succeed<PermissionWaitOutcome>({ kind: 'failed', cause }),
    ),
    Effect.timeoutOrElse({
      duration: Duration.millis(input.timeoutMs),
      orElse: () => Effect.succeed<PermissionWaitOutcome>({ kind: 'timeout' }),
    }),
    Effect.raceFirst(withdrawnOutcome(input.withdrawn)),
  );
};
