import { Effect, FiberHandle, Scope } from 'effect';
import type { FastifyBaseLogger } from 'fastify';
import { runFork } from '../../kernel';

export interface RefreshLoopDeps {
  /** Milliseconds between two ticks. */
  readonly intervalMs: number;
  /** Starts one refresh and returns at once. */
  readonly tick: () => void;
  readonly logger: FastifyBaseLogger;
}

export interface RefreshLoopEffects {
  /** Ticks every interval from now on; replaces a running loop. */
  readonly start: Effect.Effect<void>;
  /** Drops the loop without cutting refresh work already handed to the background. */
  readonly stop: Effect.Effect<void>;
}

export const makeRefreshLoop = (
  deps: RefreshLoopDeps,
): Effect.Effect<RefreshLoopEffects, never, Scope.Scope> =>
  Effect.gen(function* () {
    const handle = yield* FiberHandle.make();
    const tick = Effect.sync(deps.tick).pipe(
      Effect.catchDefect((err) => Effect.sync(() => deps.logger.warn({ err }, 'plan usage refresh failed'))),
    );
    const loop = Effect.forever(Effect.andThen(Effect.sleep(Math.max(1, deps.intervalMs)), tick));
    return {
      start: Effect.asVoid(FiberHandle.run(handle, loop)),
      stop: FiberHandle.clear(handle),
    };
  });

/** One refresh fiber; stopping retains the empty handle so the monitor can restart. */
export class RefreshLoop {
  private readonly scope = Scope.makeUnsafe();
  private readonly core: RefreshLoopEffects;

  constructor(deps: RefreshLoopDeps) {
    this.core = Effect.runSync(Scope.provide(makeRefreshLoop(deps), this.scope));
  }

  start(): void {
    runFork(this.core.start);
  }

  stop(): void {
    runFork(this.core.stop);
  }
}
