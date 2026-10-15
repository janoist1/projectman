import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullTestSpec } from '../contracts';
import { createFullTestExecutor } from './index';
import { acquireHeavyLock, readHeavyQueue } from './heavy-lock';
import type { HeavyLock } from './heavy-lock';

/**
 * The executor behind the machine's heavy-run queue (PM-336). The run directory cannot be made (the
 * temporary directory below does not exist), so a run that gets its turn ends at once with
 * `sandbox_unavailable`, in every environment: nothing here starts the sandbox.
 */
const NO_TMP = '/pm-no-such-root';

let root: string;
let dir: string;
const locks: HeavyLock[] = [];
const warn = vi.fn();
const logger = { warn } as unknown as FastifyBaseLogger;

const spec: FullTestSpec = {
  runId: 'ftr_queue',
  cwd: '/work/PM-1-checkout',
  command: 'npm test',
  maxWorkers: 2,
  timeoutMs: 100,
  sandbox: { denyRead: [], allowRead: [] },
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pm-heavy-exec-'));
  dir = path.join(root, 'heavy');
  warn.mockClear();
});

afterEach(async () => {
  await Promise.all(locks.splice(0).map((lock) => lock.release()));
  rmSync(root, { recursive: true, force: true });
});

const hold = async (label: string): Promise<HeavyLock> => {
  const lock = await acquireHeavyLock({ dir, label, pollMs: 20 });
  locks.push(lock);
  return lock;
};

describe('the full test executor in the heavy-run queue', () => {
  it('waits for its turn without the wait counting into the run, and gives the lock back', async () => {
    const other = await hold('a member run');
    setTimeout(() => void other.release(), 700);
    const executor = createFullTestExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: dir });
    const waitStarted = Date.now();
    const result = await executor.run(spec, new AbortController().signal);
    expect(Date.now() - waitStarted).toBeGreaterThanOrEqual(600);
    // `started` (the duration, and with it the timeout, 100 ms here) begins when the lock is held.
    expect(result).toMatchObject({ outcome: 'error', reason: 'sandbox_unavailable' });
    expect(result.durationMs).toBeLessThan(400);
    expect((await readHeavyQueue(dir)).holder).toBeNull();
  });

  it('shows the waiting run, named by its checkout, in the queue', async () => {
    const other = await hold('a member run');
    const executor = createFullTestExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: dir });
    const running = executor.run(spec, new AbortController().signal);
    const deadline = Date.now() + 5000;
    let waiting = (await readHeavyQueue(dir)).waiting;
    while (waiting.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      waiting = (await readHeavyQueue(dir)).waiting;
    }
    expect(waiting.map((entry) => entry.label)).toEqual(['server full test PM-1-checkout']);
    await other.release();
    await running;
  });

  it('ends like an aborted run when it is stopped while it waits, and leaves the queue', async () => {
    const other = await hold('a member run');
    const executor = createFullTestExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: dir });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await executor.run(spec, controller.signal);
    expect(result).toMatchObject({ outcome: 'error', reason: 'killed', failedFiles: [] });
    const queue = await readHeavyQueue(dir);
    expect(queue.waiting).toEqual([]);
    expect(queue.holder?.label).toBe('a member run');
    await other.release();
  });

  it('runs without the queue, with a warning, when its folder cannot be used', async () => {
    // /tmp is not ours and not 0700.
    const executor = createFullTestExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: '/tmp/heavy' });
    const result = await executor.run(spec, new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'error', reason: 'sandbox_unavailable' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'ftr_queue' }),
      expect.stringContaining('heavy-run queue is unavailable'),
    );
  });

  it('reports the start only once it holds the lock', async () => {
    const other = await hold('a member run');
    const executor = createFullTestExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: dir });
    const onStarted = vi.fn(async () => (await readHeavyQueue(dir)).holder?.label);
    const seen: Promise<string | undefined>[] = [];
    const running = executor.run(spec, new AbortController().signal, () => seen.push(onStarted()));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onStarted).not.toHaveBeenCalled();
    await other.release();
    await running;
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(await seen[0]).toBe('server full test PM-1-checkout');
  });

  it('reports the start at once without a queue, or when the queue is unavailable', async () => {
    const without = vi.fn();
    await createFullTestExecutor({ logger, tmpDir: NO_TMP }).run(spec, new AbortController().signal, without);
    expect(without).toHaveBeenCalledTimes(1);
    const unavailable = vi.fn();
    await createFullTestExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: '/tmp/heavy' }).run(
      spec,
      new AbortController().signal,
      unavailable,
    );
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it('never reports the start of a run stopped while it waited', async () => {
    const other = await hold('a member run');
    const executor = createFullTestExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: dir });
    const controller = new AbortController();
    const onStarted = vi.fn();
    setTimeout(() => controller.abort(), 100);
    await executor.run(spec, controller.signal, onStarted);
    expect(onStarted).not.toHaveBeenCalled();
    await other.release();
  });

  describe('when the run requires the queue (PM-658)', () => {
    const required: FullTestSpec = { ...spec, requireHeavyLock: true };

    it.each([
      ['no folder', undefined],
      // /tmp is not ours and not 0700.
      ['an unusable folder', '/tmp/heavy'],
    ])('ends as heavy_lock_unavailable with %s, and starts nothing', async (_name, heavyLockDir) => {
      const onStarted = vi.fn();
      const executor = createFullTestExecutor({ logger, tmpDir: NO_TMP, heavyLockDir });
      const result = await executor.run(required, new AbortController().signal, onStarted);
      expect(result).toEqual({
        outcome: 'error',
        reason: 'heavy_lock_unavailable',
        exitCode: null,
        durationMs: 0,
        failedFiles: [],
        outputTail: expect.stringContaining('heavy-run queue is unavailable'),
      });
      expect(onStarted).not.toHaveBeenCalled();
      // The run directory is never even tried (it could not be made at NO_TMP: that would warn).
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('run directory'));
    });

    it.each([undefined, false])('keeps the earlier behaviour when requireHeavyLock is %s', async (flag) => {
      const onStarted = vi.fn();
      const optional: FullTestSpec = flag === undefined ? spec : { ...spec, requireHeavyLock: flag };
      for (const heavyLockDir of [undefined, '/tmp/heavy']) {
        const result = await createFullTestExecutor({ logger, tmpDir: NO_TMP, heavyLockDir }).run(
          optional,
          new AbortController().signal,
          onStarted,
        );
        expect(result).toMatchObject({ outcome: 'error', reason: 'sandbox_unavailable' });
      }
      expect(onStarted).toHaveBeenCalledTimes(2);
    });

    it('waits for its turn, runs with the lock and gives it back', async () => {
      const other = await hold('a member run');
      setTimeout(() => void other.release(), 300);
      const holders: (string | undefined)[] = [];
      const executor = createFullTestExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: dir });
      const result = await executor.run(required, new AbortController().signal, () => {
        void readHeavyQueue(dir).then((queue) => holders.push(queue.holder?.label));
      });
      expect(result).toMatchObject({ outcome: 'error', reason: 'sandbox_unavailable' });
      await vi.waitFor(() => expect(holders).toEqual(['server full test PM-1-checkout']));
      expect((await readHeavyQueue(dir)).holder).toBeNull();
    });

    it('is killed, not unavailable, when it is stopped while it waits', async () => {
      const other = await hold('a member run');
      const onStarted = vi.fn();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 150);
      const result = await createFullTestExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: dir }).run(
        required,
        controller.signal,
        onStarted,
      );
      expect(result).toMatchObject({ outcome: 'error', reason: 'killed' });
      expect(onStarted).not.toHaveBeenCalled();
      expect((await readHeavyQueue(dir)).waiting).toEqual([]);
      await other.release();
    });
  });

  describe('when the run asks for the dependency preparation (PM-681)', () => {
    const prepared: FullTestSpec = {
      ...spec,
      npmCi: { ref: { projectKey: 'PM', repo: 'projectman' }, mergeId: 'mrg_1' },
    };

    it.each([
      ['no queue folder', false],
      ['a queue folder', true],
    ])('ends as dependency_install_failed with %s, and starts nothing', async (_name, withQueue) => {
      const onStarted = vi.fn();
      const executor = createFullTestExecutor({
        logger,
        tmpDir: NO_TMP,
        heavyLockDir: withQueue ? dir : undefined,
      });
      const result = await executor.run(
        { ...prepared, requireHeavyLock: true },
        new AbortController().signal,
        onStarted,
      );
      expect(result).toEqual({
        outcome: 'error',
        reason: 'dependency_install_failed',
        exitCode: null,
        durationMs: 0,
        failedFiles: [],
        outputTail: 'dependency preparation is not supported by this executor',
      });
      expect(onStarted).not.toHaveBeenCalled();
      // Neither the queue nor the run directory is tried.
      expect(warn).not.toHaveBeenCalled();
      if (withQueue) expect((await readHeavyQueue(dir)).waiting).toEqual([]);
    });

    it('keeps the earlier behaviour when npmCi is missing', async () => {
      const onStarted = vi.fn();
      const result = await createFullTestExecutor({ logger, tmpDir: NO_TMP }).run(
        spec,
        new AbortController().signal,
        onStarted,
      );
      expect(result).toMatchObject({ outcome: 'error', reason: 'sandbox_unavailable' });
      expect(onStarted).toHaveBeenCalledTimes(1);
    });
  });

  it('does not queue at all without a folder', async () => {
    const executor = createFullTestExecutor({ logger, tmpDir: NO_TMP });
    const result = await executor.run(spec, new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'error', reason: 'sandbox_unavailable' });
    expect(warn).toHaveBeenCalledTimes(1); // the run directory only
  });
});
