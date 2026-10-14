import { Cause, Clock, Data, Effect, Exit } from 'effect';
import type { HeavyLockEntry } from './heavy-lock';

export type TurnResult =
  { acquired: true } | { acquired: false; holder: HeavyLockEntry | null; ahead: number };
export interface LockWaitDeps {
  /** One complete filesystem round; cooperative abort never cuts it in half. May reject. */
  takeTurn: () => Promise<TurnResult>;
  /** Recovery and cleanup callbacks never reject. */
  remakeQueue: () => Promise<void>;
  touchTicket: () => Promise<void>;
  removeTicket: () => Promise<void>;
  onWait?: (wait: { holder: HeavyLockEntry | null; ahead: number; waitedMs: number }) => void;
  signal?: AbortSignal;
  /** Wall-clock time when the ticket was made. */
  queuedAt: number;
  heartbeatMs: number;
  pollMs: number;
  notifyMs: number;
  maxWaitMs?: number;
}
export class LockWaitAborted extends Data.TaggedError('LockWaitAborted')<{ reason: unknown }> {}
export class LockWaitTimedOut extends Data.TaggedError('LockWaitTimedOut')<{}> {}
export class LockQueueUnusable extends Data.TaggedError('LockQueueUnusable')<{ cause: unknown }> {}

const abortOf = (signal: AbortSignal) =>
  Effect.callback<never, LockWaitAborted>((resume) => {
    const onAbort = () => resume(Effect.fail(new LockWaitAborted({ reason: signal.reason })));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', onAbort));
  });

export const waitForLock = (
  deps: LockWaitDeps,
): Effect.Effect<number, LockWaitAborted | LockWaitTimedOut | LockQueueUnusable> =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep(deps.heartbeatMs).pipe(Effect.andThen(Effect.promise(deps.touchTicket)))),
      );
      let failedRounds = 0;
      let lastNotice: number | undefined;
      for (;;) {
        if (deps.signal?.aborted)
          return yield* Effect.fail(new LockWaitAborted({ reason: deps.signal.reason }));
        const turn = yield* Effect.exit(Effect.tryPromise({ try: deps.takeTurn, catch: (cause) => cause }));
        let result: TurnResult | undefined;
        if (Exit.isSuccess(turn)) {
          result = turn.value;
          failedRounds = 0;
        } else {
          if (++failedRounds >= 20)
            return yield* Effect.fail(new LockQueueUnusable({ cause: Cause.squash(turn.cause) }));
          // The folder may have been removed: make it again before the next round.
          yield* Effect.promise(deps.remakeQueue);
        }
        const now = yield* Clock.currentTimeMillis;
        const waitedMs = now - deps.queuedAt;
        if (result?.acquired) return waitedMs;
        if (result && (lastNotice === undefined || now - lastNotice >= deps.notifyMs)) {
          lastNotice = now;
          try {
            deps.onWait?.({ holder: result.holder, ahead: result.ahead, waitedMs });
          } catch {
            /* A broken display never stops the wait. */
          }
        }
        if (deps.maxWaitMs !== undefined && waitedMs >= deps.maxWaitMs)
          return yield* Effect.fail(new LockWaitTimedOut());
        const ms =
          deps.maxWaitMs === undefined
            ? deps.pollMs
            : Math.max(1, Math.min(deps.pollMs, deps.maxWaitMs - waitedMs));
        yield* deps.signal ? Effect.raceFirst(Effect.sleep(ms), abortOf(deps.signal)) : Effect.sleep(ms);
      }
    }),
  ).pipe(Effect.onError(() => Effect.promise(deps.removeTicket)));

export interface HolderBeatDeps {
  /** Touches the owner only while it is ours; never rejects. */
  beat: () => Promise<boolean>;
  /** Called once when the lock no longer belongs to this holder. */
  takenOver: () => void;
  heartbeatMs: number;
}
export const holderHeartbeat = (deps: HolderBeatDeps): Effect.Effect<never> =>
  Effect.suspend(() => {
    let warned = false;
    return Effect.forever(
      Effect.sleep(deps.heartbeatMs).pipe(
        Effect.andThen(Effect.uninterruptible(Effect.promise(deps.beat))),
        Effect.tap((ours) =>
          Effect.sync(() => {
            if (!ours && !warned) {
              warned = true;
              deps.takenOver();
            }
          }),
        ),
      ),
    );
  });
