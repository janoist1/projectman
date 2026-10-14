import { Effect, Exit, FiberMap, Scope } from 'effect';
import type { DomainContext } from '../../core/base';
import { runFork } from '../../kernel';

/**
 * The timers of the session manager: the end of a done task's turn, the wait for input and the
 * cleanup of a done task, one `FiberMap` per group (docs/EFFECT.md). `makeSessionTimers` is the
 * Effect program; `SessionTimers` is the plain facade the parts (`InputWaits`, `TurnFinishes`,
 * `DoneCleanup`) use.
 */

export type SessionTimerGroup = 'turn' | 'input' | 'cleanup';

const GROUPS: readonly SessionTimerGroup[] = ['turn', 'input', 'cleanup'];

export interface SessionTimersEffects {
  /**
   * Calls `fire` once `delayMs` has passed (at least 1 ms). A key that is waiting already keeps its
   * first deadline: the second call does nothing.
   */
  readonly arm: (
    group: SessionTimerGroup,
    key: string,
    delayMs: number,
    fire: () => void,
  ) => Effect.Effect<void>;
  /** Drops the pending call of the key; it is not invoked. */
  readonly disarm: (group: SessionTimerGroup, key: string) => Effect.Effect<void>;
}

export const makeSessionTimers: Effect.Effect<SessionTimersEffects, never, Scope.Scope> = Effect.gen(
  function* () {
    const maps = new Map<SessionTimerGroup, FiberMap.FiberMap<string>>();
    for (const group of GROUPS) maps.set(group, yield* FiberMap.make<string>());
    const mapOf = (group: SessionTimerGroup) => maps.get(group)!;
    return {
      arm: (group, key, delayMs, fire) =>
        Effect.gen(function* () {
          // A zero delay is `yieldNow` in Effect: the call would run on the arming call's stack.
          const fiber = yield* FiberMap.run(mapOf(group), key, Effect.sleep(Math.max(1, delayMs)), {
            onlyIfMissing: true,
          });
          // The map releases the key first, so a call may arm the same key again or disarm it.
          fiber.addObserver((exit) => {
            if (Exit.isSuccess(exit)) fire();
          });
        }),
      disarm: (group, key) => FiberMap.remove(mapOf(group), key),
    };
  },
);

/**
 * Facade: the timers of the session manager. `close()` drops every pending call; a closed set
 * arms nothing. The sleeps keep the process alive (the old timers were unref'd): the manager's
 * shutdown closes them.
 */
export class SessionTimers {
  private readonly scope = Scope.makeUnsafe();
  private readonly core: SessionTimersEffects;
  private readonly logger: Pick<DomainContext['logger'], 'error'>;
  private closed = false;

  constructor(logger: Pick<DomainContext['logger'], 'error'>) {
    this.logger = logger;
    this.core = Effect.runSync(Scope.provide(makeSessionTimers, this.scope));
  }

  arm(group: SessionTimerGroup, key: string, delayMs: number, fire: () => void): void {
    if (this.closed) return;
    const guarded = () => {
      try {
        fire();
      } catch (err) {
        this.logger.error({ err, group, key }, 'session timer failed');
      }
    };
    runFork(this.core.arm(group, key, delayMs, guarded));
  }

  disarm(group: SessionTimerGroup, key: string): void {
    if (this.closed) return;
    runFork(this.core.disarm(group, key));
  }

  close(): void {
    this.closed = true;
    runFork(Scope.close(this.scope, Exit.void));
  }
}
