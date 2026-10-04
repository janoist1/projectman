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

  it('does not queue at all without a folder', async () => {
    const executor = createFullTestExecutor({ logger, tmpDir: NO_TMP });
    const result = await executor.run(spec, new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'error', reason: 'sandbox_unavailable' });
    expect(warn).toHaveBeenCalledTimes(1); // the run directory only
  });
});
