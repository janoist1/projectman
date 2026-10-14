import { Data, Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { abortable, runFork, runPromise } from './effect';

class Boom extends Data.TaggedError('Boom')<{ cause: unknown }> {}

/** A promise settled from outside, to hold a function at a checkpoint. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe('kernel/effect', () => {
  describe('runPromise', () => {
    it('resolves with the value', async () => {
      await expect(runPromise(Effect.succeed(7))).resolves.toBe(7);
    });

    it('rejects with the original error, not a wrapper', async () => {
      const err = new Error('original');
      await expect(runPromise(Effect.promise(() => Promise.reject(err)))).rejects.toBe(err);
      await expect(runPromise(Effect.fail(err))).rejects.toBe(err);
    });
  });

  describe('runFork', () => {
    it('runs on the caller stack, before the call returns', () => {
      const seen: string[] = [];
      runFork(Effect.sync(() => seen.push('effect')));
      seen.push('after');
      expect(seen).toEqual(['effect', 'after']);
    });

    it('has run a fiber started from inside another one by the time the outer call returns', () => {
      const seen: string[] = [];
      runFork(
        Effect.sync(() => {
          seen.push('outer');
          runFork(Effect.sync(() => seen.push('inner')));
        }),
      );
      expect(seen).toEqual(['outer', 'inner']);
    });
  });

  describe('abortable', () => {
    it('returns the value of the function and passes it a live signal', async () => {
      let aborted: boolean | undefined;
      const value = await runPromise(
        abortable(
          async (signal) => {
            aborted = signal.aborted;
            return 'done';
          },
          (cause) => new Boom({ cause }),
        ),
      );
      expect(value).toBe('done');
      expect(aborted).toBe(false);
    });

    it('turns a rejection into the typed failure', async () => {
      const err = new Error('nope');
      const failed = await runPromise(
        abortable(
          () => Promise.reject(err),
          (cause) => new Boom({ cause }),
        ).pipe(Effect.flip),
      );
      expect(failed).toBeInstanceOf(Boom);
      expect(failed.cause).toBe(err);
    });

    it('aborts the signal on interruption and waits for the promise to settle', async () => {
      const hold = gate();
      const seen: string[] = [];
      let signal!: AbortSignal;
      const fiber = runFork(
        abortable(
          async (s) => {
            signal = s;
            await hold.opened;
            seen.push('settled');
            return 1;
          },
          (cause) => new Boom({ cause }),
        ).pipe(Effect.ensuring(Effect.sync(() => seen.push('finalizer')))),
      );
      expect(signal.aborted).toBe(false);

      fiber.interruptUnsafe();
      expect(signal.aborted).toBe(true);
      // The fiber is still alive: the function has not stopped yet.
      expect(fiber.pollUnsafe()).toBeUndefined();
      expect(seen).toEqual([]);

      hold.open();
      await new Promise<void>((resolve) => fiber.addObserver(() => resolve()));
      // The finalizer ran after the function stopped, never beside it.
      expect(seen).toEqual(['settled', 'finalizer']);
      expect(Exit.isFailure(fiber.pollUnsafe()!)).toBe(true);
    });

    it('does not abort the signal when the function finishes by itself', async () => {
      let signal!: AbortSignal;
      await runPromise(
        abortable(
          async (s) => {
            signal = s;
          },
          (cause) => new Boom({ cause }),
        ),
      );
      expect(signal.aborted).toBe(false);
    });
  });
});
