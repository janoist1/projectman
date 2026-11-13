import { Effect, Exit, Scope } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MergeRecord } from '../../db';
import { runFork, runPromise } from '../../kernel';
import type { MergeRun } from './deps';
import type { MergeSlotPeer } from './ports';
import { makeMergeQueue } from './queue';
import type { MergeQueueDeps } from './queue';

type Held = { run: MergeRun; open(): void };

/** The queue over fake deps: a merge is a promise the test opens, and the table is an array. */
function setup(options: { peerBusy?: (projectKey: string, repo: string) => boolean } = {}) {
  const rows: MergeRecord[] = [];
  const started: string[] = [];
  const released: string[] = [];
  const held = new Map<string, Held>();
  const warnings: unknown[] = [];
  const state = { stopped: false };
  const peerPumps = { count: 0 };
  const peer: MergeSlotPeer = {
    busy: (projectKey, repo) => options.peerBusy?.(projectKey, repo) ?? false,
    pump: () => void peerPumps.count++,
  };
  const row = (id: string, repo: string, extra: Partial<MergeRecord> = {}): MergeRecord =>
    ({ id, projectKey: 'PM', repo, taskKey: `PM-${id}`, landed: null, ...extra }) as MergeRecord;
  const deps: MergeQueueDeps = {
    ctx: {
      now: () => new Date(),
      repos: { taskMerges: { list: () => rows.filter((r) => !started.includes(r.id)) } },
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    } as unknown as MergeQueueDeps['ctx'],
    tasks: { find: () => null, readSchedulingTasks: () => [] },
    steps: {
      run: async (run) => {
        started.push(run.row.id);
        await new Promise<void>((resolve) => held.set(run.row.id, { run, open: resolve }));
      },
      release: async (r) => void released.push(r.id),
      abandon: async () => {},
      engine: () => null,
    },
    peer: () => peer,
    stopped: () => state.stopped,
  };
  const scope = Effect.runSync(Scope.make());
  const queue = Effect.runSync(Scope.provide(makeMergeQueue(deps), scope));
  const pump = () => runFork(queue.pump);
  const finish = async (id: string) => {
    held.get(id)!.open();
    // A settled merge frees its slot, which pumps again.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { rows, row, started, released, held, warnings, state, peerPumps, queue, pump, finish, scope };
}

describe('merge queue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips a future retry and wakes it at its durable deadline after a fresh queue starts', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.rows.push(
      t.row('1', 'web', {
        retry: {
          attempt: 2,
          cause: 'verdict_missing',
          runner: 'github_actions',
          lastRunId: 'run',
          at: new Date(Date.now() + 1000).toISOString(),
        },
      }),
      t.row('2', 'web'),
    );
    t.pump();
    expect(t.started).toEqual(['2']);
    t.held.get('2')!.open();
    await vi.advanceTimersByTimeAsync(999);
    expect(t.started).toEqual(['2']);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.started).toEqual(['2', '1']);
    t.state.stopped = true;
    t.held.get('1')!.open();
    await runPromise(Scope.close(t.scope, Exit.void));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces its single wake timer and cancels it with the queue scope', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.rows.push(
      t.row('1', 'web', {
        retry: {
          attempt: 2,
          cause: 'verdict_missing',
          runner: 'github_actions',
          lastRunId: 'run',
          at: new Date(Date.now() + 1000).toISOString(),
        },
      }),
    );
    t.pump();
    t.pump();
    expect(vi.getTimerCount()).toBe(1);
    t.state.stopped = true;
    await runPromise(Scope.close(t.scope, Exit.void));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs one merge per repository and the next one when it settled', async () => {
    const t = setup();
    t.rows.push(t.row('1', 'web'), t.row('2', 'web'), t.row('3', 'api'));
    t.pump();
    // The other repository has its own slot.
    expect(t.started).toEqual(['1', '3']);
    expect(t.queue.slot('PM', 'web')?.row.id).toBe('1');
    expect(t.queue.slot('PM', 'api')?.row.id).toBe('3');

    await t.finish('1');
    expect(t.started).toEqual(['1', '3', '2']);
    expect(t.released).toEqual(['1']);
    expect(t.peerPumps.count).toBeGreaterThan(0);
    await t.finish('2');
    await t.finish('3');
    expect(t.queue.slot('PM', 'web')).toBeUndefined();
    expect(t.queue.slot('PM', 'api')).toBeUndefined();
  });

  it('skips a repository while its slot peer is busy and starts it after the next pump', () => {
    let busy = true;
    const t = setup({ peerBusy: () => busy });
    t.rows.push(t.row('1', 'web'));
    t.pump();
    expect(t.started).toEqual([]);
    busy = false;
    t.pump();
    expect(t.started).toEqual(['1']);
  });

  it('starts a merge whose push already began with `pushing` set', () => {
    const t = setup();
    t.rows.push(t.row('1', 'web', { landed: 'remote' }), t.row('2', 'api'));
    t.pump();
    expect(t.queue.slot('PM', 'web')?.pushing).toBe(true);
    expect(t.queue.slot('PM', 'api')?.pushing).toBe(false);
  });

  it('starts a queued merge with a pushing step and merge commit before an earlier one', () => {
    const t = setup();
    t.rows.push(t.row('first', 'web'), t.row('pushing', 'web', { step: 'pushing', mergeCommit: 'abc' }));
    t.pump();
    expect(t.started).toEqual(['pushing']);
  });

  it('gives the running merge its abort signal', () => {
    const t = setup();
    t.rows.push(t.row('1', 'web'));
    t.pump();
    expect(t.held.get('1')!.run.signal?.aborted).toBe(false);
  });

  it('recovers a train before a newer prioritized request in the same repository', async () => {
    const t = setup();
    t.rows.push(t.row('new', 'web'), t.row('recovery', 'web', { trainId: 'mrg_recovery0001' }));
    t.pump();
    expect(t.started).toEqual(['recovery']);
    await t.finish('recovery');
    expect(t.started).toEqual(['recovery', 'new']);
    await t.finish('new');
  });

  it('interrupts a running merge by aborting it and waits until it settled', async () => {
    const t = setup();
    t.rows.push(t.row('1', 'web'));
    t.pump();
    const run = t.queue.slot('PM', 'web')!;

    let interrupted = false;
    void runPromise(t.queue.interrupt(run)).then(() => (interrupted = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run.signal?.aborted).toBe(true);
    // The merge has not stopped yet: the slot stays taken and nothing is released.
    expect(interrupted).toBe(false);
    expect(t.queue.slot('PM', 'web')).toBe(run);
    expect(t.released).toEqual([]);

    await t.finish('1');
    expect(interrupted).toBe(true);
    expect(t.released).toEqual(['1']);
    expect(t.queue.slot('PM', 'web')).toBeUndefined();
  });

  it('leaves a merge alone when it is not the one the slot runs', async () => {
    const t = setup();
    t.rows.push(t.row('1', 'web'));
    t.pump();
    const stale: MergeRun = { row: t.row('9', 'web'), pushing: false };
    await runPromise(t.queue.interrupt(stale));
    expect(t.held.get('1')!.run.signal?.aborted).toBe(false);
    expect(t.queue.slot('PM', 'web')?.row.id).toBe('1');
  });

  it('starts nothing once the server is stopping, even for a freed slot', async () => {
    const t = setup();
    t.rows.push(t.row('1', 'web'), t.row('2', 'web'));
    t.pump();
    t.state.stopped = true;
    await t.finish('1');
    t.pump();
    expect(t.started).toEqual(['1']);
  });

  it('interrupts the running merges when its scope closes, after they settled', async () => {
    const t = setup();
    t.rows.push(t.row('1', 'web'));
    t.pump();
    const run = t.queue.slot('PM', 'web')!;

    let closed = false;
    void runPromise(Scope.close(t.scope, Exit.void)).then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run.signal?.aborted).toBe(true);
    expect(closed).toBe(false);
    await t.finish('1');
    expect(closed).toBe(true);
    expect(t.released).toEqual(['1']);
  });

  it.each([false, true])(
    'settles a rejected merge before freeing its slot (interrupted=%s)',
    async (interrupt) => {
      const t = setup();
      t.rows.push(t.row('1', 'web'));
      const abandoned: string[] = [];
      let reject!: (cause: Error) => void;
      const result = new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
      const failing = vi.fn(async (run: MergeRun) => {
        t.started.push(run.row.id);
        return result;
      });
      const origin = Effect.runSync(Scope.make());
      const queue = Effect.runSync(
        Scope.provide(
          makeMergeQueue({
            ctx: {
              now: () => new Date(),
              repos: { taskMerges: { list: () => t.rows.filter((r) => !t.started.includes(r.id)) } },
              logger: { warn: (...args: unknown[]) => t.warnings.push(args) },
            } as unknown as MergeQueueDeps['ctx'],
            tasks: { find: () => null, readSchedulingTasks: () => [] },
            steps: {
              run: failing,
              release: async (r) => {
                expect(abandoned).toEqual([r.id]);
                t.released.push(r.id);
              },
              abandon: async (run) => void abandoned.push(run.row.id),
              engine: () => null,
            },
            peer: () => null,
            stopped: () => false,
          }),
          origin,
        ),
      );
      runFork(queue.pump);
      const interrupted = interrupt ? runPromise(queue.interrupt(queue.slot('PM', 'web')!)) : undefined;
      reject(new Error('boom'));
      await interrupted;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(failing).toHaveBeenCalled();
      if (!interrupt) expect(t.warnings.length).toBeGreaterThan(0);
      expect(abandoned).toEqual(['1']);
      expect(t.released).toContain('1');
      expect(queue.slot('PM', 'web')).toBeUndefined();
    },
  );

  it('leaves no timer behind', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.rows.push(t.row('1', 'web'));
    t.pump();
    void runPromise(t.queue.interrupt(t.queue.slot('PM', 'web')!));
    t.held.get('1')!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.queue.slot('PM', 'web')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
