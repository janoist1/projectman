import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { machinePlaces as capacityOf, placeWorkers, TARGETED_TEST_FILES_MAX } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machinePlaces } from '../../../scripts/heavy/vitest-places.mjs';
import { acquireHeavyLock, heavyCommandKey, machineHost, readHeavyQueue } from '../src/full-test/heavy-lock';
import type { HeavyLock } from '../src/full-test/heavy-lock';

const CLAIM = Symbol.for('projectman.machinePlaces');

interface FakeVitest {
  config: {
    reporters: unknown[];
    related?: string[];
    maxWorkers?: number;
    minWorkers?: number;
    poolOptions?: {
      threads?: { isolate?: boolean; maxThreads?: number; minThreads?: number };
      forks?: { maxForks?: number };
    };
  };
  onClose(fn: () => unknown): void;
}

let root: string;
let dir: string;
let closers: (() => unknown)[];
const locks: HeavyLock[] = [];
const children: ChildProcess[] = [];

/** What vitest hands a plugin: the resolved config, and a way to run something when the run closes. */
function fakeVitest(): FakeVitest {
  return {
    config: { reporters: ['default'], poolOptions: { threads: { isolate: false } } },
    onClose: (fn) => closers.push(fn),
  };
}

const configure = (vitest: FakeVitest) => machinePlaces().configureVitest({ vitest });
const close = () => Promise.all(closers.splice(0).map((fn) => fn()));

/** The reporter the plugin adds, which learns the files when the run starts. */
const reporter = (vitest: FakeVitest) =>
  vitest.config.reporters.at(-1) as { onTestRunStart(specs: { moduleId: string }[]): Promise<void> };

const held = async (): Promise<number[]> =>
  (await readHeavyQueue(dir)).holders.map((holder) => holder.granted ?? 0);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pm-places-'));
  dir = path.join(root, 'heavy');
  closers = [];
  Reflect.deleteProperty(globalThis, CLAIM);
  vi.stubEnv('PROJECTMAN_HEAVY_LOCK_DIR', dir);
  vi.stubEnv('PROJECTMAN_HEAVY_LOCK_HELD', '');
  vi.stubEnv('PROJECTMAN_SESSION_ID', '');
  vi.stubEnv('VITEST_MAX_FORKS', '');
  vi.stubEnv('VITEST_MAX_THREADS', '');
});

afterEach(async () => {
  await close();
  await Promise.all(locks.splice(0).map((lock) => lock.release()));
  for (const child of children.splice(0)) child.kill('SIGKILL');
  Reflect.deleteProperty(globalThis, CLAIM);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('the vitest places plugin', () => {
  it('takes two to four places, sets the workers from them, and gives them back when the run closes', async () => {
    const vitest = fakeVitest();
    await configure(vitest);
    const [granted] = await held();
    expect(granted).toBeGreaterThanOrEqual(2);
    expect(granted).toBeLessThanOrEqual(4);
    const workers = placeWorkers(granted!, machineHost());
    expect(vitest.config).toMatchObject({
      maxWorkers: workers,
      minWorkers: 1,
      poolOptions: {
        // The threads' minimum is their maximum, and the config's own setting stays.
        threads: { isolate: false, maxThreads: workers, minThreads: workers },
        forks: { maxForks: workers },
      },
    });
    await close();
    expect(await held()).toEqual([]);
  });

  it('shrinks to the files of the run once it knows them, and gives back the places it cannot use', async () => {
    const vitest = fakeVitest();
    await configure(vitest);
    const [granted] = await held();
    const workers = placeWorkers(granted!, machineHost());
    await reporter(vitest).onTestRunStart([{ moduleId: 'a.test.ts' }, { moduleId: 'a.test.ts' }]);
    // One file is one worker, whatever the number of specs (projects) it appears in.
    expect(vitest.config.maxWorkers).toBe(1);
    expect(vitest.config.poolOptions?.threads).toMatchObject({ maxThreads: 1, minThreads: 1 });
    expect(await held()).toEqual([Math.min(granted!, 1 + Math.min(workers, 1))]);
  });

  describe('the file threshold', () => {
    const specs = (count: number) => Array.from({ length: count }, (_, i) => ({ moduleId: `f${i}.test.ts` }));

    it('turns a related run over the threshold into a full run: gives back its places, asks for all, says why', async () => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const vitest = fakeVitest();
      vitest.config.related = ['test/helpers/app-harness.ts'];
      await configure(vitest);
      await reporter(vitest).onTestRunStart(specs(TARGETED_TEST_FILES_MAX + 1));
      expect(await held()).toEqual([capacityOf(machineHost())]);
      expect(String(write.mock.calls.map(([line]) => line))).toContain(
        `selected ${TARGETED_TEST_FILES_MAX + 1} test files`,
      );
      await close();
      expect(await held()).toEqual([]);
    });

    it('keeps a related run of few files on its small share', async () => {
      const vitest = fakeVitest();
      vitest.config.related = ['src/a.ts'];
      await configure(vitest);
      const [granted] = await held();
      const workers = placeWorkers(granted!, machineHost());
      await reporter(vitest).onTestRunStart(specs(10));
      expect(await held()).toEqual([Math.min(granted!, 1 + Math.min(workers, 10))]);
    });

    it('does not apply to a run of named files', async () => {
      const vitest = fakeVitest();
      await configure(vitest);
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const [granted] = await held();
      const workers = placeWorkers(granted!, machineHost());
      await reporter(vitest).onTestRunStart(specs(TARGETED_TEST_FILES_MAX + 1));
      // Still its own share, never the full run's.
      expect(await held()).toEqual([Math.min(granted!, 1 + workers)]);
      expect(write).not.toHaveBeenCalled();
    });
  });

  it('takes one claim for the projects of a run, which configure it one after the other', async () => {
    const vitest = fakeVitest();
    await configure(vitest);
    await configure(vitest);
    expect(await held()).toHaveLength(1);
    // The reporter is added once.
    expect(vitest.config.reporters).toHaveLength(2);
  });

  it('asks for no places under the ticket of a holder, and takes the workers from the machine', async () => {
    const outer = await acquireHeavyLock({ dir, label: 'outer', places: { min: 2, max: 2 } });
    locks.push(outer);
    vi.stubEnv('PROJECTMAN_HEAVY_LOCK_HELD', outer.ticket);
    const vitest = fakeVitest();
    await configure(vitest);
    expect(await held()).toEqual([2]);
    expect(vitest.config.maxWorkers).toBeGreaterThanOrEqual(1);
  });

  it('keeps the worker limit the caller set', async () => {
    vi.stubEnv('VITEST_MAX_THREADS', '3');
    const vitest = fakeVitest();
    await configure(vitest);
    expect(vitest.config.maxWorkers).toBe(3);
    expect(vitest.config.poolOptions?.forks?.maxForks).toBe(3);
  });

  it('stops the run with 79 when the same command of the session is already running', async () => {
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(other);
    const command = heavyCommandKey(process.cwd(), process.argv.slice(2));
    // The first run is another process's: this one is the second call of the same command.
    mkdirSync(path.join(dir, 'holders'), { recursive: true });
    writeFileSync(
      path.join(dir, 'holders', 'other.json'),
      JSON.stringify({
        ticket: 'other',
        pid: other.pid,
        label: 'other',
        cwd: process.cwd(),
        sessionId: 'ses_1',
        command,
        queuedAt: new Date().toISOString(),
        granted: 1,
      }),
    );
    vi.stubEnv('PROJECTMAN_SESSION_ID', 'ses_1');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(configure(fakeVitest())).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(79);
  });
});
