import { Clock, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it, vi } from 'vitest';
import { runPromise } from '../../../kernel';
import { probeWithin, type ProbeProcess } from './plan-usage-probe';

function processOf(running = true) {
  let answer!: (value: unknown) => void;
  let close!: () => void;
  const child: ProbeProcess = {
    answer: new Promise((resolve) => {
      answer = resolve;
    }),
    closed: new Promise((resolve) => {
      close = () => {
        running = false;
        resolve();
      };
    }),
    end: vi.fn(),
    running: () => running,
    kill: vi.fn(),
  };
  return { child, answer, close };
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

describe('plan usage probe under the TestClock', () => {
  it('returns the answer, ends stdin once and cancels reaping on closure', async () => {
    const { child, answer, close } = processOf();
    await run(
      Effect.gen(function* () {
        const probe = yield* Effect.forkChild(probeWithin(child, 100, 50), { startImmediately: true });
        answer({ usage: 42 });
        expect(yield* Fiber.join(probe)).toEqual({ usage: 42 });
        expect(child.end).toHaveBeenCalledTimes(1);
        close();
        yield* flush();
        yield* TestClock.adjust(50);
        yield* flush();
        expect(child.kill).not.toHaveBeenCalled();
      }),
    );
  });

  it('times out exactly at the answer deadline and kills after the grace period', async () => {
    const { child } = processOf();
    await run(
      Effect.gen(function* () {
        let settled = false;
        const probe = yield* Effect.forkChild(
          probeWithin(child, 100, 50).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                settled = true;
              }),
            ),
          ),
          { startImmediately: true },
        );
        yield* TestClock.adjust(99);
        yield* flush();
        expect(settled).toBe(false);
        expect(child.end).not.toHaveBeenCalled();
        yield* TestClock.adjust(1);
        yield* flush();
        expect(yield* Fiber.join(probe)).toBeNull();
        expect(child.end).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust(49);
        yield* flush();
        expect(child.kill).not.toHaveBeenCalled();
        yield* TestClock.adjust(1);
        yield* flush();
        expect(child.kill).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it('does not kill a process that never started', async () => {
    const { child, answer, close } = processOf(false);
    answer(null);
    close();
    await run(
      Effect.gen(function* () {
        expect(yield* probeWithin(child, 100, 50)).toBeNull();
        yield* flush();
        yield* TestClock.adjust(50);
        yield* flush();
        expect(child.kill).not.toHaveBeenCalled();
      }),
    );
  });
});
