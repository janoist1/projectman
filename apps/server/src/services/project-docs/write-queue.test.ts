import { Clock, Effect, Exit, Fiber, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocWriteRecord } from '../../db';
import { runFork, runPromise } from '../../kernel';
import { makeDocWriteQueue, type DocWriteQueueDeps } from './write-queue';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup() {
  const rows: DocWriteRecord[] = [];
  const started: string[] = [];
  const events: string[] = [];
  const held = new Map<string, { resolve(): void; reject(error: unknown): void }>();
  const state = { stopped: false, busy: false };
  const warn = vi.fn();
  const deps: DocWriteQueueDeps = {
    ctx: {
      repos: { docWrites: { list: () => rows.filter((row) => !started.includes(row.id)) } },
      logger: { warn },
    } as unknown as DocWriteQueueDeps['ctx'],
    start: (row) => {
      started.push(row.id);
      events.push(row.id);
    },
    run: (row) => new Promise<void>((resolve, reject) => held.set(row.id, { resolve, reject })),
    peer: {
      busy: () => state.busy,
      pump: () => {
        events.push('peer');
      },
    },
    stopped: () => state.stopped,
  };
  const scope = Scope.makeUnsafe();
  const queue = Effect.runSync(Scope.provide(makeDocWriteQueue(deps), scope));
  const row = (id: string, repo = 'web') => ({ id, projectKey: 'PM', repo }) as DocWriteRecord;
  const pump = () => runFork(queue.pump);
  const finish = async (id: string) => {
    held.get(id)!.resolve();
    await turn();
  };
  const close = () => runPromise(Scope.close(scope, Exit.void));
  return { rows, started, events, held, state, warn, deps, scope, queue, row, pump, finish, close };
}

describe('document write queue', () => {
  afterEach(() => vi.useRealTimers());

  it('runs one write per repository and gives the next write the slot before its peer', async () => {
    const t = setup();
    t.rows.push(t.row('1'), t.row('2'), t.row('3', 'api'));
    t.pump();
    expect(t.started).toEqual(['1', '3']);
    expect(t.queue.slot('PM', 'web')?.row.id).toBe('1');
    t.events.length = 0;
    await t.finish('1');
    expect(t.events).toEqual(['2', 'peer']);
    expect(t.queue.slot('PM', 'web')?.row.id).toBe('2');
    await t.finish('2');
    await t.finish('3');
    expect(t.queue.slot('PM', 'web')).toBeUndefined();
    await t.close();
  });

  it('looks up peer methods at each pump and skips busy repositories', async () => {
    const t = setup();
    t.rows.push(t.row('1'));
    const busy = vi.spyOn(t.deps.peer, 'busy').mockReturnValue(true);
    t.pump();
    expect(t.started).toEqual([]);
    busy.mockReturnValue(false);
    t.pump();
    expect(t.started).toEqual(['1']);
    await t.finish('1');
    await t.close();
  });

  it('starts nothing while stopping', async () => {
    const t = setup();
    t.rows.push(t.row('1'));
    t.state.stopped = true;
    t.pump();
    expect(t.started).toEqual([]);
    await t.close();
  });

  it('waits through the running write on scope close and clears a pending wait timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = setup();
    t.rows.push(t.row('1'), t.row('2'));
    t.pump();
    const late = vi.fn();
    const waiting = runPromise(t.queue.wait(t.queue.slot('PM', 'web')!, 60_000, late));
    t.state.stopped = true;
    let closed = false;
    const closing = t.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(t.queue.slot('PM', 'web')?.row.id).toBe('1');
    t.held.get('1')!.resolve();
    await closing;
    await waiting;
    await vi.advanceTimersByTimeAsync(0);
    expect(t.started).toEqual(['1']);
    expect(t.queue.slot('PM', 'web')).toBeUndefined();
    expect(late).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a rejected write and frees its slot', async () => {
    const t = setup();
    t.rows.push(t.row('1'));
    t.pump();
    const error = new Error('boom');
    t.held.get('1')!.reject(error);
    await turn();
    expect(t.warn).toHaveBeenCalledWith(
      { err: error, writeId: '1' },
      'could not record how a document write ended',
    );
    expect(t.queue.slot('PM', 'web')).toBeUndefined();
    await t.close();
  });

  for (const finishesEarly of [false, true]) {
    it(
      finishesEarly
        ? 'cancels the deadline when the write ends first'
        : 'calls late exactly at the deadline under TestClock',
      async () => {
        const t = setup();
        t.rows.push(t.row('1'));
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const clock = yield* TestClock.make();
              yield* Effect.gen(function* () {
                const queue = yield* makeDocWriteQueue(t.deps);
                yield* queue.pump;
                const late = vi.fn();
                const waiting = yield* Effect.forkChild(queue.wait(queue.slot('PM', 'web')!, 100, late), {
                  startImmediately: true,
                });
                yield* TestClock.adjust(99);
                expect(late).not.toHaveBeenCalled();
                if (finishesEarly) {
                  yield* Effect.promise(() => t.finish('1'));
                  yield* Fiber.join(waiting);
                }
                yield* TestClock.adjust(1);
                if (finishesEarly) {
                  yield* TestClock.adjust(1000);
                  expect(late).not.toHaveBeenCalled();
                } else {
                  yield* Fiber.join(waiting);
                  expect(late).toHaveBeenCalledTimes(1);
                  yield* Effect.promise(() => t.finish('1'));
                }
              }).pipe(Effect.provideService(Clock.Clock, clock));
            }),
          ),
        );
        await t.close();
      },
    );
  }
});
