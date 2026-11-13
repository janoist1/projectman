import { Data, Effect, Exit, FiberMap } from 'effect';
import type { Scope } from 'effect';
import { openPrerequisites } from '@projectman/shared';
import { prerequisiteCards } from '../../core/tasks';
import type { Task } from '@projectman/shared';
import type { BranchMerger, TaskSchedulingReader } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { MergeRecord } from '../../db';
import { abortable, runFork } from '../../kernel';
import type { MergeRun } from './deps';
import type { MergeSlotPeer } from './ports';
import type { MergeSteps } from './steps';
import { holdsRepoQueue, waitingForRetry } from './check-retry';

export type MergeQueueDeps = {
  ctx: Pick<DomainContext, 'repos' | 'logger' | 'now'>;
  tasks: TaskSchedulingReader & {
    find(projectKey: string, taskKey: string): Task | null | undefined;
  };
  steps: Pick<MergeSteps, 'run' | 'release' | 'abandon'> & {
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
    const timers = yield* FiberMap.make<string>();
    // State, not a Ref (docs/EFFECT.md). `pushing` is set by the steps while the merge runs.
    const active = new Map<string, MergeRun>();
    const keyOf = (run: MergeRun) => `${run.row.projectKey}:${run.row.repo}`;

    const cleanup = async (run: MergeRun) => {
      // The train owns its shared checkout, including startup recovery.
      if (run.train) return;
      const { row } = run;
      try {
        const task = deps.tasks.find(row.projectKey, row.taskKey);
        await deps.steps.release(row, task ? deps.steps.engine(task)?.merger : undefined);
      } catch (err) {
        deps.ctx.logger.warn({ err, mergeId: row.id }, 'could not release a finished merge');
      }
    };

    const program = (run: MergeRun) => {
      let cause: unknown = new Error('the merge run ended without settling its state');
      return abortable(
        (signal) => {
          run.signal = signal;
          return deps.steps.run(run);
        },
        (cause) => new MergeRunFailed({ cause }),
      ).pipe(
        Effect.catchTag('MergeRunFailed', (failed) =>
          Effect.promise(async () => {
            deps.ctx.logger.warn({ err: failed.cause, mergeId: run.row.id }, 'the merge run failed');
            cause = failed.cause;
          }),
        ),
        // An interruption drops the promise's rejection, bypassing catchTag. Always settle any
        // remaining running row before freeing the slot, even when its error handler failed.
        Effect.ensuring(
          Effect.promise(async () => {
            // Shutdown retains an in-flight publication for startup recovery.
            if (!deps.stopped() || !run.pushing) await deps.steps.abandon(run, cause);
            await cleanup(run);
          }),
        ),
      );
    };

    const pump: Effect.Effect<void> = Effect.gen(function* () {
      if (deps.stopped()) return;
      // A merge whose push may have landed (it was pushing, with a merge commit) goes first, whatever its rank.
      const mayHaveLanded = (row: MergeRecord) => (row.step === 'pushing' && row.mergeCommit ? 0 : 1);
      const queued = deps.ctx.repos.taskMerges
        .list('queued')
        .sort((a, b) => mayHaveLanded(a) - mayHaveLanded(b));
      const now = deps.ctx.now();
      // A startup leader must finish the old publication before a new candidate can use this repo.
      const recovering = new Map<string, string>();
      for (const row of queued)
        if (row.trainId) {
          const key = `${row.projectKey}:${row.repo}`;
          if (!recovering.has(key)) recovering.set(key, row.id);
        }
      // A row waiting for the remote holds its repository's queue: every other card needs the same remote.
      const holding = new Map<string, string>();
      for (const row of queued) {
        const key = `${row.projectKey}:${row.repo}`;
        if (holdsRepoQueue(row) && !holding.has(key)) holding.set(key, row.id);
      }
      for (const row of queued) {
        if (waitingForRetry(row, now)) continue;
        const key = `${row.projectKey}:${row.repo}`;
        if (holding.has(key) && holding.get(key) !== row.id) continue;
        if (recovering.has(key) && recovering.get(key) !== row.id) continue;
        const task = deps.tasks.find(row.projectKey, row.taskKey);
        if (
          !row.trainId &&
          row.landed !== 'remote' &&
          task &&
          openPrerequisites(task, prerequisiteCards(deps.tasks, row.projectKey, task)).length > 0
        )
          continue;
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
      const next = queued
        .filter((row) => waitingForRetry(row, now))
        .reduce((earliest, row) => Math.min(earliest, Date.parse(row.retry!.at)), Infinity);
      yield* FiberMap.remove(timers, 'retry');
      if (Number.isFinite(next)) {
        const timer = yield* FiberMap.run(timers, 'retry', Effect.sleep(Math.max(1, next - now.getTime())));
        timer.addObserver((exit) => {
          if (Exit.isSuccess(exit) && !deps.stopped()) runFork(pump);
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
