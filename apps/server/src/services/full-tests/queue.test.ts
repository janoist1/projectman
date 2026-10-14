import { Effect, Exit, Scope } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FullTestRunRecord } from '../../db';
import { runFork, runPromise } from '../../kernel';
import { makeFullTestQueue } from './queue';
import type { FullTestQueueEffects } from './queue';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(step?: (run: FullTestRunRecord, signal: AbortSignal) => Promise<void>) {
  const rows: FullTestRunRecord[] = [];
  const started: string[] = [];
  const held = new Map<string, { signal: AbortSignal; end(): void }>();
  const warn = vi.fn();
  const scope = Scope.makeUnsafe();
  let stopped = false;
  const core = Effect.runSync(
    Scope.provide(
      makeFullTestQueue({
        next: () => (stopped ? undefined : rows[0]),
        step: async (run, signal) => {
          rows.shift();
          started.push(run.id);
          if (step) return step(run, signal);
          await new Promise<void>((resolve) => held.set(run.id, { signal, end: resolve }));
        },
        logger: { warn },
      }),
      scope,
    ),
  );
  const enqueue = (...ids: string[]) => rows.push(...ids.map((id) => ({ id }) as FullTestRunRecord));
  const pump = () => runFork(core.pump);
  const finish = async (id: string) => {
    held.get(id)!.end();
    await turn();
  };
  const close = () => {
    stopped = true;
    return runPromise(Scope.close(scope, Exit.void));
  };
  return { core, enqueue, pump, finish, close, held, started, warn };
}

describe('full test queue', () => {
  afterEach(() => vi.useRealTimers());

  it('runs in order without overlapping, including runs queued during a step', async () => {
    const t = setup();
    t.enqueue('1', '2');
    t.pump();
    t.pump();
    expect(t.started).toEqual(['1']);
    t.enqueue('3');
    await t.finish('1');
    expect(t.started).toEqual(['1', '2']);
    await t.finish('2');
    expect(t.started).toEqual(['1', '2', '3']);
    await t.finish('3');
    // A completed drain can be pumped again.
    t.enqueue('4');
    t.pump();
    expect(t.started).toEqual(['1', '2', '3', '4']);
    await t.finish('4');
    await t.close();
  });

  it('aborts synchronously, waits for cleanup and then runs the next step', async () => {
    const t = setup();
    t.enqueue('1', '2');
    t.pump();
    let aborted = false;
    const aborting = runPromise(t.core.abort('1')).then(() => {
      aborted = true;
    });
    expect(t.held.get('1')!.signal.aborted).toBe(true);
    await turn();
    expect(aborted).toBe(false);
    expect(t.started).toEqual(['1']);
    await t.finish('1');
    await aborting;
    expect(t.started).toEqual(['1', '2']);
    expect(t.warn).not.toHaveBeenCalled();
    await t.finish('2');
    await t.close();
  });

  it('ignores aborts for a run that is not executing', async () => {
    const t = setup();
    t.enqueue('1');
    t.pump();
    await runPromise(t.core.abort('missing'));
    expect(t.held.get('1')!.signal.aborted).toBe(false);
    await t.finish('1');
    await t.close();
  });

  it('can request its own abort without deadlocking', async () => {
    let core: FullTestQueueEffects;
    const t = setup(async (run, signal) => {
      // Like cancel() in the facade, a checkpoint happens after an async lookup.
      await Promise.resolve();
      runFork(core.abort(run.id));
      expect(signal.aborted).toBe(true);
    });
    core = t.core;
    t.enqueue('1', '2');
    t.pump();
    await turn();
    expect(t.started).toEqual(['1', '2']);
    expect(t.warn).not.toHaveBeenCalled();
    await t.close();
  });

  it('logs a failed step and continues draining', async () => {
    const t = setup(async (run) => {
      if (run.id === '1') throw new Error('boom');
    });
    t.enqueue('1', '2');
    t.pump();
    await turn();
    expect(t.started).toEqual(['1', '2']);
    expect(t.warn).toHaveBeenCalledExactlyOnceWith({ err: expect.anything() }, 'the full test queue failed');
    await t.close();
  });

  it('waits for the executing step on scope closure and leaves no timers', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.enqueue('1', '2');
    t.pump();
    let closed = false;
    const closing = t.close().then(() => {
      closed = true;
    });
    expect(t.held.get('1')!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    t.held.get('1')!.end();
    await closing;
    await vi.advanceTimersByTimeAsync(0);
    expect(t.started).toEqual(['1']);
    expect(t.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
