import { Data, Deferred, Effect, FiberMap } from 'effect';
import type { Scope } from 'effect';
import { OPEN_RELEASE_WORK_ADMISSION } from '../../contracts';
import type { ReleaseWorkAdmission } from '../../contracts';
import type { DocWriteRecord } from '../../db';
import type { DomainContext } from '../../core/base';
import { abortable, runFork } from '../../kernel';
import type { DocWriteSlotPeer } from './ports';

export type DocWriteQueueDeps = {
  ctx: Pick<DomainContext, 'repos' | 'logger'>;
  /** Marks a queued row running, just before its fiber starts. */
  start(row: DocWriteRecord): void;
  /** Records how the write ended itself and does not reject for a failed write. */
  run(row: DocWriteRecord): Promise<void>;
  peer: Pick<DocWriteSlotPeer, 'busy' | 'pump'>;
  stopped: () => boolean;
  /** The release gate (PM-752): a write starts only with a permit; absent: never held. */
  work?: ReleaseWorkAdmission;
};

/** The write that runs in a repository's slot; done completes when its slot is free again. */
export type DocWriteRun = { readonly row: DocWriteRecord; readonly done: Deferred.Deferred<void> };

export interface DocWriteQueueEffects {
  pump: Effect.Effect<void>;
  slot(projectKey: string, repo: string): DocWriteRun | undefined;
  /** Calls late at the deadline if the write has not finished. */
  wait(run: DocWriteRun, ms: number, late: () => void): Effect.Effect<void>;
}

class DocWriteRunFailed extends Data.TaggedError('DocWriteRunFailed')<{ cause: unknown }> {}

/** Durable FIFO per repository, sharing its slot with member-initiated merges (PM-495). */
export const makeDocWriteQueue = (
  deps: DocWriteQueueDeps,
): Effect.Effect<DocWriteQueueEffects, never, Scope.Scope> =>
  Effect.gen(function* () {
    const slots = yield* FiberMap.make<string>();
    const active = new Map<string, DocWriteRun>();
    const program = (run: DocWriteRun) =>
      // The write ignores the abort signal: closing the scope waits through push and advance.
      abortable(
        () => deps.run(run.row),
        (cause) => new DocWriteRunFailed({ cause }),
      ).pipe(
        Effect.catchTag('DocWriteRunFailed', (failed) =>
          Effect.sync(() =>
            deps.ctx.logger.warn(
              { err: failed.cause, writeId: run.row.id },
              'could not record how a document write ended',
            ),
          ),
        ),
      );
    const pump: Effect.Effect<void> = Effect.gen(function* () {
      if (deps.stopped()) return;
      for (const row of deps.ctx.repos.docWrites.list('queued')) {
        const key = `${row.projectKey}:${row.repo}`;
        if (active.has(key) || deps.peer.busy(row.projectKey, row.repo)) continue;
        // A hybrid release's maintenance fence (PM-752): the queued write waits until the fence is down.
        const permit = (deps.work ?? OPEN_RELEASE_WORK_ADMISSION).tryAcquire('document_write', row.id);
        if (!permit) continue;
        deps.start(row);
        const run: DocWriteRun = { row, done: Deferred.makeUnsafe<void>() };
        active.set(key, run);
        const fiber = yield* FiberMap.run(slots, key, program(run), { onlyIfMissing: true });
        fiber.addObserver(() => {
          permit.release();
          active.delete(key);
          // A waiting write gets the free slot before the next merge.
          runFork(pump);
          deps.peer.pump();
          Deferred.doneUnsafe(run.done, Effect.void);
        });
      }
    });
    return {
      pump,
      slot: (projectKey, repo) => active.get(`${projectKey}:${repo}`),
      wait: (run, ms, late) =>
        Deferred.await(run.done).pipe(
          Effect.timeoutOrElse({ duration: ms, orElse: () => Effect.sync(late) }),
          Effect.asVoid,
        ),
    };
  });
