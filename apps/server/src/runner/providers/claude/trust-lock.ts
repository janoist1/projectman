import { Clock, Data, Effect } from 'effect';

export interface ConfigLockDeps {
  mkdir(path: string): Promise<unknown>;
  rmdir(path: string): Promise<unknown>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  /** proper-lockfile's stale time and how long a busy lock is waited for. */
  staleMs: number;
  waitMs: number;
  /** The pause between two attempts (40–79 ms in production). */
  pauseMs(): number;
}

export class ConfigLockFailed extends Data.TaggedError('ConfigLockFailed')<{ cause: unknown }> {}

/** Takes the proper-lockfile style lock directory; false when it stayed busy for `waitMs`. */
export const takeConfigLock = (
  lockPath: string,
  deps: ConfigLockDeps,
): Effect.Effect<boolean, ConfigLockFailed> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + deps.waitMs;
    const attempt = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (cause) => new ConfigLockFailed({ cause }) });
    for (;;) {
      const held = yield* attempt(() => deps.mkdir(lockPath)).pipe(
        Effect.as(true),
        Effect.catchTag('ConfigLockFailed', (error) =>
          (error.cause as { code?: string })?.code === 'EEXIST' ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
      if (held) return true;
      const retry = yield* attempt(() => deps.stat(lockPath)).pipe(
        Effect.flatMap(({ mtimeMs }) =>
          Date.now() - mtimeMs > deps.staleMs
            ? attempt(() => deps.rmdir(lockPath)).pipe(
                Effect.catchTag('ConfigLockFailed', () => Effect.void),
                Effect.as(true),
              ) // abandoned by a crashed process
            : Effect.succeed(false),
        ),
        Effect.catchTag('ConfigLockFailed', (error) =>
          (error.cause as { code?: string })?.code === 'ENOENT'
            ? Effect.succeed(true) // released meanwhile
            : Effect.fail(error),
        ),
      );
      if (retry) continue;
      if ((yield* Clock.currentTimeMillis) >= deadline) return false;
      yield* Effect.sleep(deps.pauseMs());
    }
  });
