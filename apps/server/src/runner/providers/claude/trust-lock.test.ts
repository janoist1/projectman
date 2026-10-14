import { Clock, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it, vi } from 'vitest';
import { runPromise } from '../../../kernel';
import { ConfigLockFailed, takeConfigLock, type ConfigLockDeps } from './trust-lock';

function depsOf(overrides: Partial<ConfigLockDeps> = {}): ConfigLockDeps {
  return {
    mkdir: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({ mtimeMs: Date.now() })),
    staleMs: 10_000,
    waitMs: 100,
    pauseMs: () => 20,
    ...overrides,
  };
}
const flush = () => Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
function run(body: Effect.Effect<void>) {
  return runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* body.pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  );
}

describe('config lock under the TestClock', () => {
  it('takes a free lock without sleeping', async () => {
    const deps = depsOf();
    await run(
      Effect.gen(function* () {
        expect(yield* takeConfigLock('config.lock', deps).pipe(Effect.orDie)).toBe(true);
        expect(deps.mkdir).toHaveBeenCalledExactlyOnceWith('config.lock');
        expect(deps.stat).not.toHaveBeenCalled();
      }),
    );
  });

  it('retries a fresh busy lock until the wait deadline without removing it', async () => {
    const deps = depsOf({
      mkdir: vi.fn(async () => {
        throw { code: 'EEXIST' };
      }),
    });
    await run(
      Effect.gen(function* () {
        let settled = false;
        const lock = yield* Effect.forkChild(
          takeConfigLock('config.lock', deps).pipe(
            Effect.orDie,
            Effect.tap(() =>
              Effect.sync(() => {
                settled = true;
              }),
            ),
          ),
          { startImmediately: true },
        );
        yield* flush();
        for (let step = 0; step < 4; step++) {
          yield* TestClock.adjust(20);
          yield* flush();
        }
        yield* TestClock.adjust(19);
        yield* flush();
        expect(settled).toBe(false);
        yield* TestClock.adjust(1);
        yield* flush();
        expect(yield* Fiber.join(lock)).toBe(false);
        expect(deps.mkdir).toHaveBeenCalledTimes(6);
        expect(deps.rmdir).not.toHaveBeenCalled();
      }),
    );
  });

  it.each(['stale', 'released', 'remove-failed'])('retries a %s lock without sleeping', async (kind) => {
    const mkdir = vi.fn().mockRejectedValueOnce({ code: 'EEXIST' }).mockResolvedValue(undefined);
    const deps = depsOf({
      mkdir,
      stat:
        kind === 'released'
          ? vi.fn(async () => {
              throw { code: 'ENOENT' };
            })
          : vi.fn(async () => ({ mtimeMs: Date.now() - 10_001 })),
      ...(kind === 'remove-failed'
        ? {
            rmdir: vi.fn(async () => {
              throw { code: 'EACCES' };
            }),
          }
        : {}),
    });
    await run(
      Effect.gen(function* () {
        expect(yield* takeConfigLock('config.lock', deps).pipe(Effect.orDie)).toBe(true);
        expect(mkdir).toHaveBeenCalledTimes(2);
        expect(deps.rmdir).toHaveBeenCalledTimes(kind === 'released' ? 0 : 1);
      }),
    );
  });

  it.each(['mkdir', 'stat'] as const)(
    'preserves an unexpected %s failure as the cause',
    async (operation) => {
      const cause = { code: 'EACCES' };
      const deps = depsOf({
        mkdir: vi.fn(async () => {
          throw operation === 'mkdir' ? cause : { code: 'EEXIST' };
        }),
        stat: vi.fn(async () => {
          throw cause;
        }),
      });
      await run(
        Effect.gen(function* () {
          const error = yield* takeConfigLock('config.lock', deps).pipe(Effect.flip, Effect.orDie);
          expect(error).toBeInstanceOf(ConfigLockFailed);
          expect(error.cause).toBe(cause);
        }),
      );
    },
  );
});
