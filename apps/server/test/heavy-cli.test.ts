import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machinePlaces, placeWorkers } from '@projectman/shared';
import { EXIT_ALREADY_RUNNING, EXIT_QUEUE_UNAVAILABLE, parseHeavyArgs } from '../../../scripts/heavy/run';
import { guardWorkerParent } from '../../../scripts/lib/worker-parent-guard.mjs';
import { acquireHeavyLock, heavyCommandKey, machineHost, readHeavyQueue } from '../src/full-test/heavy-lock';
import type { HeavyLock } from '../src/full-test/heavy-lock';
import { waitFor } from './helpers/wait';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = path.join(ROOT, 'scripts/heavy/cli.ts');
const GUARD = path.join(ROOT, 'scripts/lib/worker-parent-guard.mjs');
const LOCK_MODULE = path.join(ROOT, 'apps/server/src/full-test/heavy-lock.ts');

let root: string;
let dir: string;
const locks: HeavyLock[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pm-heavy-cli-'));
  dir = path.join(root, 'heavy');
});

afterEach(async () => {
  await Promise.all(locks.splice(0).map((lock) => lock.release()));
  rmSync(root, { recursive: true, force: true });
});

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The CLI as a real process on a folder of its own; `onStderr` sees what it has written so far. */
function heavy(
  args: string[],
  env: Record<string, string | undefined> = {},
  onStderr?: (text: string) => void,
  onStart?: (child: ChildProcess) => void,
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        PROJECTMAN_HEAVY_LOCK_DIR: dir,
        PROJECTMAN_HEAVY_LOCK_HELD: undefined,
        PROJECTMAN_SESSION_ID: undefined,
        VITEST_MAX_FORKS: undefined,
        VITEST_MAX_THREADS: undefined,
        ...env,
      },
    });
    onStart?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      onStderr?.(stderr);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const node = (script: string): string[] => ['node', '-e', script];

/** A command that prints the queue as it sees it: who holds the places, the variable and the workers. */
const queueReader = (): string[] => [
  process.execPath,
  '--import',
  'tsx',
  '--input-type=module',
  '-e',
  `const { readHeavyQueue } = await import(${JSON.stringify(LOCK_MODULE)});
   const queue = await readHeavyQueue(${JSON.stringify(dir)});
   console.log(JSON.stringify({ holder: queue.holder, holders: queue.holders, held: process.env.PROJECTMAN_HEAVY_LOCK_HELD, forks: process.env.VITEST_MAX_FORKS, threads: process.env.VITEST_MAX_THREADS }));`,
];

interface Seen {
  holder: { label: string; sessionId?: string; ticket: string } | null;
  holders: { label: string; ticket: string; granted?: number }[];
  held: string;
  forks: string;
  threads: string;
}

describe('the arguments of the heavy CLI', () => {
  it('takes the options up to the first other argument, and everything after as the command', () => {
    expect(parseHeavyArgs(['--label', 'a b', '--max-wait', '90', 'npm', 'test', '--label', 'x'])).toEqual({
      label: 'a b',
      maxWaitSeconds: 90,
      command: ['npm', 'test', '--label', 'x'],
    });
    expect(parseHeavyArgs(['--', 'npm', '--version'])).toEqual({ command: ['npm', '--version'] });
    expect(parseHeavyArgs(['npm', 'run', 'x'])).toEqual({ command: ['npm', 'run', 'x'] });
  });

  it.each([
    ['all', 'all'],
    ['3', { min: 3, max: 3 }],
    ['2-4', { min: 2, max: 4 }],
  ])('reads --places %s', (value, places) => {
    expect(parseHeavyArgs(['--places', value, 'x'])).toEqual({ places, command: ['x'] });
  });

  it('refuses places that are not all, a number or a range', () => {
    for (const value of ['0', '4-2', 'many', '2-']) {
      expect(parseHeavyArgs(['--places', value, 'x'])).toMatchObject({ error: expect.any(String) });
    }
  });

  it('refuses a missing command, an unknown option and a bad number', () => {
    expect(parseHeavyArgs([])).toEqual({ error: 'no command' });
    expect(parseHeavyArgs(['--label', 'x'])).toEqual({ error: 'no command' });
    expect(parseHeavyArgs(['--nope', 'x'])).toEqual({ error: 'unknown option --nope' });
    expect(parseHeavyArgs(['--max-wait'])).toEqual({ error: '--max-wait needs a value' });
    expect(parseHeavyArgs(['--max-wait', 'soon', 'x'])).toMatchObject({ error: expect.any(String) });
  });
});

describe('the heavy CLI', () => {
  it('preserves the child exit status when process-group cleanup is denied', () => {
    const guard = pathToFileURL(path.join(ROOT, 'scripts/lib/child-guard.mjs')).href;
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `process.kill = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
         process.argv = [process.execPath, 'guard', process.execPath, '-e', 'process.exit(7)'];
         await import(${JSON.stringify(guard)});`,
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(7);
    expect(run.stderr).toBe('');
  });

  it("exits with the command's status", async () => {
    expect((await heavy(node('process.exit(0)'))).code).toBe(0);
    expect((await heavy(node('process.exit(3)'))).code).toBe(3);
  });

  it('exits with 128 plus the number of the signal that ended the command', async () => {
    expect((await heavy(node("process.kill(process.pid, 'SIGTERM')"))).code).toBe(143);
  });

  it('exits with 127 for a command that does not exist, and 2 for a bad call', async () => {
    const missing = await heavy(['pm-no-such-command']);
    expect(missing.code).toBe(127);
    expect(missing.stderr).toContain('cannot start pm-no-such-command');
    const usage = await heavy([]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('usage: npm run heavy');
  });

  it('holds the lock while the command runs, names the session, and releases it after', async () => {
    const ran = await heavy(['--label', 'my run', '--', ...queueReader()], {
      PROJECTMAN_SESSION_ID: 'ses_7',
    });
    expect(ran.stderr).toBe('');
    const seen = JSON.parse(ran.stdout) as Seen;
    expect(seen.holder).toMatchObject({ label: 'my run', sessionId: 'ses_7' });
    // What a nested run carries: the holder's ticket.
    expect(seen.held).toBe(seen.holder?.ticket);
    expect((await readHeavyQueue(dir)).holder).toBeNull();
  });

  it('holds some of the places for the command and gives its workers from them', async () => {
    const ran = await heavy(['--places', '2-4', ...queueReader()]);
    const seen = JSON.parse(ran.stdout) as Seen;
    expect(seen.holders).toHaveLength(1);
    const granted = seen.holders[0]!.granted!;
    expect(granted).toBeGreaterThanOrEqual(2);
    expect(granted).toBeLessThanOrEqual(4);
    expect(seen.held).toBe(seen.holders[0]!.ticket);
    const workers = String(placeWorkers(granted, machineHost()));
    expect([seen.forks, seen.threads]).toEqual([workers, workers]);
    expect((await readHeavyQueue(dir)).holders).toEqual([]);
  });

  it('runs two commands at once on one folder, within the places of the machine', async () => {
    // Each waits until it sees both holders: it can only do so when the pool lets both hold at once. Then
    // it keeps its places until the other has seen them too, so a slow start of one cannot fail the other.
    const seen = path.join(root, 'seen');
    const pair = [
      process.execPath,
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `const { readHeavyQueue } = await import(${JSON.stringify(LOCK_MODULE)});
       const fs = await import('node:fs');
       const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
       const until = Date.now() + 90000;
       let queue;
       do {
         queue = await readHeavyQueue(${JSON.stringify(dir)});
         if (queue.holders.length >= 2) break;
         await sleep(50);
       } while (Date.now() < until);
       fs.mkdirSync(${JSON.stringify(seen)}, { recursive: true });
       fs.writeFileSync(${JSON.stringify(seen)} + '/' + process.pid, '');
       while (fs.readdirSync(${JSON.stringify(seen)}).length < 2 && Date.now() < until) await sleep(50);
       console.log(JSON.stringify(queue.holders.map((holder) => holder.granted)));`,
    ];
    const [one, two] = await Promise.all([
      heavy(['--places', '1', ...pair]),
      heavy(['--places', '1', ...pair]),
    ]);
    expect([one.code, two.code]).toEqual([0, 0]);
    for (const ran of [one, two]) {
      const granted = JSON.parse(ran.stdout) as number[];
      expect(granted).toHaveLength(2);
      expect(granted.reduce((sum, places) => sum + places, 0)).toBeLessThanOrEqual(
        machinePlaces(machineHost()),
      );
    }
    // Two real processes start slowly on a busy machine.
  }, 120_000);

  it('keeps the worker limit the caller set', async () => {
    const ran = await heavy(['--places', '2-4', ...queueReader()], { VITEST_MAX_FORKS: '7' });
    const seen = JSON.parse(ran.stdout) as Seen;
    expect(seen.forks).toBe('7');
  });

  it('labels the run by the folder and the command, at most 120 characters', async () => {
    const ran = await heavy(queueReader());
    const { holder } = JSON.parse(ran.stdout) as { holder: { label: string } };
    expect(holder.label.startsWith(`${path.basename(ROOT)}: ${process.execPath}`)).toBe(true);
    expect(holder.label).toHaveLength(120);
  });

  it('says who it waits for, starts when the holder lets go, and says how long it waited', async () => {
    const holder = await acquireHeavyLock({ dir, label: 'the long test' });
    locks.push(holder);
    const ran = await heavy(['--label', 'next', ...node('process.exit(5)')], {}, (stderr) => {
      // Once it has told the wait, the holder lets go.
      if (stderr.includes('waiting')) void holder.release();
    });
    expect(ran.code).toBe(5);
    // Who holds the places, how many are free, and how many are ahead.
    expect(ran.stderr).toMatch(
      /heavy: waiting for the machine's heavy-run queue \(0 of \d+ places free\): "the long test" since \d\d:\d\d:\d\d \(\d+ of \d+ places\), 0 ahead of you \(waited 0m00s\)\n/,
    );
    expect(ran.stderr).toMatch(/heavy: started after 0m0\ds\n/);
  });

  it('exits with 79 at once when the same command of the session is already running', async () => {
    const command = node('process.exit(0)');
    const first = await acquireHeavyLock({
      dir,
      label: 'first',
      sessionId: 'ses_9',
      // The CLI runs in the repository folder, without the trailing slash `ROOT` has.
      command: heavyCommandKey(path.resolve(ROOT), command),
      places: { min: 1, max: 1 },
    });
    locks.push(first);
    const ran = await heavy(command, { PROJECTMAN_SESSION_ID: 'ses_9' });
    expect(ran.code).toBe(EXIT_ALREADY_RUNNING);
    expect(EXIT_ALREADY_RUNNING).toBe(79);
    // It names the run that is still going, and it did not queue.
    expect(ran.stderr).toContain(`pid ${process.pid}`);
    expect((await readHeavyQueue(dir)).waiting).toEqual([]);
  });

  it('exits with 75 when --max-wait runs out, and leaves the queue', async () => {
    const holder = await acquireHeavyLock({ dir, label: 'busy' });
    locks.push(holder);
    const ran = await heavy(['--max-wait', '0.4', ...node('process.exit(0)')]);
    expect(ran.code).toBe(75);
    expect(ran.stderr).toContain('waiting for the machine');
    const queue = await readHeavyQueue(dir);
    expect(queue.waiting).toEqual([]);
    expect(queue.holder?.label).toBe('busy');
  });

  it('does not queue inside a run that holds the lock', async () => {
    const holder = await acquireHeavyLock({ dir, label: 'the outer run' });
    locks.push(holder);
    const ran = await heavy(node('console.log(process.env.PROJECTMAN_HEAVY_LOCK_HELD)'), {
      PROJECTMAN_HEAVY_LOCK_HELD: '1',
    });
    expect(ran).toEqual({ code: 0, stdout: '1\n', stderr: '' });
    expect((await readHeavyQueue(dir)).holder?.label).toBe('the outer run');
  });

  it('does not queue inside a run that holds some of the places, by its ticket', async () => {
    const outer = await acquireHeavyLock({ dir, label: 'the outer run', places: { min: 2, max: 2 } });
    locks.push(outer);
    const ran = await heavy(node('console.log(process.env.PROJECTMAN_HEAVY_LOCK_HELD)'), {
      PROJECTMAN_HEAVY_LOCK_HELD: outer.ticket,
    });
    expect(ran).toEqual({ code: 0, stdout: `${outer.ticket}\n`, stderr: '' });
  });

  it('does not take a hand-set 1 as a hold when no older holder lives', async () => {
    const other = await acquireHeavyLock({ dir, label: 'someone else', places: { min: 1, max: 1 } });
    locks.push(other);
    const ran = await heavy(['--places', '1', ...queueReader()], { PROJECTMAN_HEAVY_LOCK_HELD: '1' });
    const seen = JSON.parse(ran.stdout) as Seen;
    // It asked for a place of its own, behind the pool's rules.
    expect(seen.holders.map((holder) => holder.label)).toContain('someone else');
    expect(seen.held).toBe(seen.holders.find((holder) => holder.label !== 'someone else')?.ticket);
  });

  it('does not run the command, and says so, when the folder is unusable (PM-346)', async () => {
    const marker = path.join(root, 'ran');
    // /tmp is not ours and not 0700: the queue cannot be used there, and nothing is made in it.
    const ran = await heavy(node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`), {
      PROJECTMAN_HEAVY_LOCK_DIR: '/tmp/heavy',
    });
    expect(ran.code).toBe(EXIT_QUEUE_UNAVAILABLE);
    expect(EXIT_QUEUE_UNAVAILABLE).toBe(78);
    expect(existsSync(marker)).toBe(false);
    const lines = ran.stderr.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^heavy: the machine's heavy-run queue cannot be used, so this did not run: /);
    expect(lines[1]).toMatch(/^heavy: .+/);
    expect(lines[2]).toContain('would overload the machine');
    expect(lines[3]).toContain('do not ask for it to run outside your sandbox');
  });
});

/** True while the process lives. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Starting and stopping a real worker process: slower than the default wait. */
const WORKER_WAIT_MS = 20_000;

describe('an interrupted heavy run (PM-863)', () => {
  /**
   * The command is a leader that starts a worker which ignores SIGTERM, like a vitest worker that
   * outlives its npm. Returns the worker's pid once it is ready.
   */
  async function startWithWorker(): Promise<{ heavy: ChildProcess; closed: Promise<void>; worker: number }> {
    const pidFile = path.join(root, 'worker.pid');
    const leader = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
      worker.stdout.once('data', () => writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid)));
      setInterval(() => {}, 1000);`;
    let started: ChildProcess | undefined;
    const closed = heavy(node(leader), {}, undefined, (child) => (started = child)).then(() => undefined);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', {
      what: 'the worker to start',
      timeoutMs: WORKER_WAIT_MS,
    });
    return { heavy: started!, closed, worker: Number(readFileSync(pidFile, 'utf8')) };
  }

  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    'stops the command, its workers and the queue entry after %s',
    async (signal) => {
      const run = await startWithWorker();
      expect(alive(run.worker)).toBe(true);
      expect((await readHeavyQueue(dir)).holder).not.toBeNull();
      run.heavy.kill(signal);
      await run.closed;
      // The lock is let go only after the group is gone.
      expect(alive(run.worker)).toBe(false);
      expect((await readHeavyQueue(dir)).holder).toBeNull();
    },
  );

  it('stops the command and its workers when the heavy CLI is killed with SIGKILL', async () => {
    const run = await startWithWorker();
    run.heavy.kill('SIGKILL');
    await run.closed;
    await waitFor(() => !alive(run.worker), { what: 'the worker to stop', timeoutMs: WORKER_WAIT_MS });
  });
});

describe('a worker of a run that did not go through the heavy CLI (PM-869)', () => {
  it('leaves when its parent is killed with SIGKILL, even if it ignores SIGTERM', async () => {
    const pidFile = path.join(root, 'worker.pid');
    const worker = `
      import { guardWorkerParent } from ${JSON.stringify(pathToFileURL(GUARD).href)};
      process.on('SIGTERM', () => {});
      process.exit = () => { throw new Error('process.exit is replaced, as in a vitest worker'); };
      guardWorkerParent({ intervalMs: 100 });
      process.send('ready');
      setInterval(() => {}, 1000);`;
    const parent = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const worker = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(worker)}], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      worker.once('message', () => writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid)));
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', parent], { stdio: 'ignore' });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', {
      what: 'the worker to start',
      timeoutMs: WORKER_WAIT_MS,
    });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    child.kill('SIGKILL');
    await waitFor(() => !alive(pid), { what: 'the worker to leave', timeoutMs: WORKER_WAIT_MS });
  });

  it('does nothing in a process that was not forked with a channel to its parent', () => {
    const exit = vi.fn();
    expect(guardWorkerParent({ target: { ppid: 1, on: vi.fn() } as unknown as NodeJS.Process, exit })).toBe(
      false,
    );
    expect(exit).not.toHaveBeenCalled();
  });
});
