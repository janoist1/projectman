import { Data, Effect, FiberMap } from 'effect';
import type { Scope } from 'effect';
import type { Task } from '@projectman/shared';
import type { BranchMerger } from '../../contracts';
import type { DomainContext } from '../../core/base';
import { abortable, runFork } from '../../kernel';
import type { MergeRun } from './deps';
import type { MergeSlotPeer } from './ports';
import type { MergeSteps } from './steps';

export type MergeQueueDeps = {
  ctx: Pick<DomainContext, 'repos' | 'logger'>;
  tasks: { find(projectKey: string, taskKey: string): Task | null | undefined };
  steps: Pick<MergeSteps, 'run' | 'release'> & {
    engine(task: Task): { merger?: BranchMerger } | null | undefined;
  };
  /** The other user of the repository's slot; null: none registered. */
  peer: () => MergeSlotPeer | null;
  /** Whether the server is stopping: nothing new starts. */
  stopped: () => boolean;
};

export interface MergeQueueEffects {
  /** Starts the queued merges whose repository's slot is free. */
  pump: Effect.Effect<void>;
  /** The merge that runs in the repository's slot, if any. */
  slot(projectKey: string, repo: string): MergeRun | undefined;
  /** Interrupts the slot's fiber if it still runs `run`; it ends after the merge settled at its next checkpoint. */
  interrupt(run: MergeRun): Effect.Effect<void>;
}

/** The merge program threw something its own error handling did not take (a failing `block`). */
class MergeRunFailed extends Data.TaggedError('MergeRunFailed')<{ cause: unknown }> {}

/**
 * Durable FIFO per project/repository; the queue itself is the `merge` table, this is the slot:
 * one fiber per repository (`FiberMap`, keyed `projectKey:repo`). The merge is a sequential async
 * program with checkpoints (`steps.run`); interrupting the fiber aborts its signal and waits for the
 * program to settle (`abortable`), so a slot is free only after the merge stopped and was released.
 */
export const makeMergeQueue = (deps: MergeQueueDeps): Effect.Effect<MergeQueueEffects, never, Scope.Scope> =>
  Effect.gen(function* () {
    const slots = yield* FiberMap.make<string>();
    // State, not a Ref (docs/EFFECT.md). `pushing` is set by the steps while the merge runs.
    const active = new Map<string, MergeRun>();
    const keyOf = (run: MergeRun) => `${run.row.projectKey}:${run.row.repo}`;

    const cleanup = async (run: MergeRun) => {
      const { row } = run;
      try {
        const task = deps.tasks.find(row.projectKey, row.taskKey);
        await deps.steps.release(row, task ? deps.steps.engine(task)?.merger : undefined);
      } catch (err) {
        deps.ctx.logger.warn({ err, mergeId: row.id }, 'could not release a finished merge');
      }
    };

    const program = (run: MergeRun) =>
      abortable(
        (signal) => {
          run.signal = signal;
          return deps.steps.run(run);
        },
        (cause) => new MergeRunFailed({ cause }),
      ).pipe(
        Effect.catchTag('MergeRunFailed', (failed) =>
          Effect.sync(() =>
            deps.ctx.logger.warn({ err: failed.cause, mergeId: run.row.id }, 'the merge run failed'),
          ),
        ),
        Effect.ensuring(Effect.promise(() => cleanup(run))),
      );

    const pump: Effect.Effect<void> = Effect.gen(function* () {
      if (deps.stopped()) return;
      for (const row of deps.ctx.repos.taskMerges.list('queued')) {
        const key = `${row.projectKey}:${row.repo}`;
        if (active.has(key) || deps.peer()?.busy(row.projectKey, row.repo)) continue;
        const run: MergeRun = { row, pushing: row.landed === 'remote' };
        active.set(key, run);
        const fiber = yield* FiberMap.run(slots, key, program(run), { onlyIfMissing: true });
        // The slot frees when the fiber is gone (the FiberMap's own observer, added first, has
        // dropped the key by then, so the pump can use it again).
        fiber.addObserver(() => {
          active.delete(key);
          // A waiting document write takes the free slot before the next merge.
          deps.peer()?.pump();
          runFork(pump);
        });
      }
    });

    return {
      pump,
      slot: (projectKey, repo) => active.get(`${projectKey}:${repo}`),
      interrupt: (run) =>
        Effect.suspend(() =>
          active.get(keyOf(run)) === run ? FiberMap.remove(slots, keyOf(run)) : Effect.void,
        ),
    };
  });
