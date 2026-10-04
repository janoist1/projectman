import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireHeavyLock, defaultHeavyLockDir, HeavyLockError, readHeavyQueue } from './heavy-lock';
import type { HeavyLock, HeavyLockEntry } from './heavy-lock';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/heavy-holder.ts', import.meta.url));

/** Short timings: a heartbeat every 40 ms, a holder or a waiter is stale after 400 ms. */
const FAST = { heartbeatMs: 40, staleMs: 400, pollMs: 20 };

let root: string;
let dir: string;
const children: ChildProcess[] = [];
const locks: HeavyLock[] = [];

beforeEach(() => {
  // mkdtemp makes it 0700 and ours, as the lock requires of the parent of the queue folder.
  root = mkdtempSync(path.join(tmpdir(), 'pm-heavy-'));
  dir = path.join(root, 'heavy');
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(locks.splice(0).map((lock) => lock.release()));
  rmSync(root, { recursive: true, force: true });
});

async function acquire(label: string, extra: Partial<Parameters<typeof acquireHeavyLock>[0]> = {}) {
  const lock = await acquireHeavyLock({ dir, label, ...FAST, ...extra });
  locks.push(lock);
  return lock;
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A real process that takes the lock, logs, holds it for `holdMs` and releases it. */
function holder(label: string, log: string, holdMs: number, ...timing: number[]): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', FIXTURE, dir, label, log, String(holdMs), ...timing.map(String)],
    { stdio: 'inherit' },
  );
  children.push(child);
  return child;
}

const logLines = (log: string): string[] =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

const ticketFiles = (): string[] => {
  try {
    return readdirSync(path.join(dir, 'queue'));
  } catch {
    return [];
  }
};

function writeTicket(name: string, entry: Partial<HeavyLockEntry>, ageMs = 0): string {
  mkdirSync(path.join(dir, 'queue'), { recursive: true });
  const file = path.join(dir, 'queue', `${name}.json`);
  const full: HeavyLockEntry = {
    ticket: name,
    pid: process.pid,
    label: name,
    cwd: '/x',
    queuedAt: new Date().toISOString(),
    ...entry,
  };
  writeFileSync(file, JSON.stringify(full));
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
  return file;
}

function writeHolder(entry: Partial<HeavyLockEntry>, ageMs = 0): void {
  mkdirSync(path.join(dir, 'holder'), { recursive: true });
  const file = path.join(dir, 'holder', 'owner.json');
  writeFileSync(
    file,
    JSON.stringify({
      ticket: 'dead-holder',
      pid: process.pid,
      label: 'old holder',
      cwd: '/x',
      queuedAt: new Date().toISOString(),
      ...entry,
    }),
  );
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
}

/** The pid of a process that is gone. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise((resolve) => child.on('exit', resolve));
  return pid;
}

describe('the default folder', () => {
  it('is below the real /tmp, in a folder of the user', () => {
    expect(defaultHeavyLockDir()).toMatch(/\/projectman-\d+\/heavy$/);
    expect(path.isAbsolute(defaultHeavyLockDir())).toBe(true);
  });
});

describe('the heavy-run lock', () => {
  it('is taken at once when nobody holds it, and shows its holder', async () => {
    const lock = await acquire('first', { sessionId: 'ses_1' });
    expect(lock.waitedMs).toBeLessThan(1000);
    const queue = await readHeavyQueue(dir);
    expect(queue.holder).toMatchObject({ label: 'first', pid: process.pid, sessionId: 'ses_1' });
    expect(queue.holder?.since).toBeTruthy();
    expect(queue.waiting).toEqual([]);
    await lock.release();
    expect((await readHeavyQueue(dir)).holder).toBeNull();
    expect(existsSync(path.join(dir, 'holder'))).toBe(false);
  });

  it('is handed out in the order the processes queued, one at a time', async () => {
    const log = path.join(root, 'log.txt');
    const first = await acquire('first');
    // Three real processes queue behind it, each only after the earlier one's ticket is there.
    for (const label of ['a', 'b', 'c']) {
      const before = ticketFiles().length;
      holder(label, log, 100);
      await until(() => ticketFiles().length > before, `the ticket of ${label}`);
    }
    expect((await readHeavyQueue(dir)).waiting.map((e) => e.label)).toEqual(['a', 'b', 'c']);
    expect(logLines(log)).toEqual([]);
    await first.release();
    await until(() => logLines(log).length === 6, 'the three runs');
    expect(logLines(log)).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('tells a waiter who holds it and how many are ahead, and again while it waits', async () => {
    const first = await acquire('the holder');
    const waits: { holder: HeavyLockEntry | null; ahead: number; waitedMs: number }[] = [];
    const second = acquire('second', { onWait: (wait) => waits.push(wait), notifyMs: 60 });
    await until(() => waits.length >= 3, 'three notices');
    expect(waits[0]).toMatchObject({ holder: { label: 'the holder' }, ahead: 0 });
    expect(waits[2]!.waitedMs).toBeGreaterThan(waits[0]!.waitedMs);
    await first.release();
    await (await second).release();
  });

  it('removes a ticket whose heartbeat stopped, and one whose process is gone', async () => {
    writeTicket('0000000000001-1-aaaaaaaa', {}, 5000); // its process lives, its heartbeat stopped
    writeTicket('0000000000002-2-bbbbbbbb', { pid: await deadPid() }); // fresh, but its process is gone
    const lock = await acquire('me');
    expect(lock.waitedMs).toBeLessThan(2000);
    expect(ticketFiles().filter((name) => name.startsWith('00000000000'))).toEqual([]);
  });

  it('keeps a live waiter that queued earlier ahead, even when the lock is free', async () => {
    writeTicket('0000000000001-1-aaaaaaaa', {}); // alive for the next 400 ms
    await expect(acquire('late', { maxWaitMs: 250 })).rejects.toMatchObject({
      code: 'heavy_lock_timeout',
    });
    expect((await readHeavyQueue(dir)).holder).toBeNull();
  });

  it('breaks the lock of a holder whose heartbeat stopped', async () => {
    writeHolder({}, 5000); // its process lives, its heartbeat stopped
    const lock = await acquire('me');
    expect((await readHeavyQueue(dir)).holder).toMatchObject({ label: 'me' });
    await lock.release();
  });

  it('breaks the lock of a holder whose process is gone, at once', async () => {
    writeHolder({ pid: await deadPid() }); // a fresh heartbeat, but nobody to beat it
    const started = Date.now();
    const lock = await acquire('me', { staleMs: 60_000 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await readHeavyQueue(dir)).holder).toMatchObject({ label: 'me' });
    await lock.release();
  });

  it('frees the lock of a holder process that is killed, after its heartbeat is stale', async () => {
    const log = path.join(root, 'log.txt');
    const killed = holder('killed', log, 60_000, 40, 400);
    await until(() => logLines(log).includes('start killed'), 'the holder to start');
    killed.kill('SIGKILL');
    const lock = await acquire('after');
    expect((await readHeavyQueue(dir)).holder).toMatchObject({ label: 'after' });
    await lock.release();
  });

  it('frees the lock of a holder that stopped beating while its process lives', async () => {
    const log = path.join(root, 'log.txt');
    // A heartbeat every minute: it never beats in this test.
    holder('silent', log, 60_000, 60_000, 400);
    await until(() => logLines(log).includes('start silent'), 'the holder to start');
    const started = Date.now();
    const lock = await acquire('after');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect((await readHeavyQueue(dir)).holder).toMatchObject({ label: 'after' });
    await lock.release();
  });

  it('never breaks the lock of a live holder, however long it runs', async () => {
    const first = await acquire('long run');
    // Well past staleMs (400 ms): the heartbeat keeps it fresh.
    await expect(acquire('impatient', { maxWaitMs: 1200 })).rejects.toMatchObject({
      name: 'HeavyLockError',
      code: 'heavy_lock_timeout',
    });
    expect((await readHeavyQueue(dir)).holder).toMatchObject({ label: 'long run' });
    expect(existsSync(path.join(dir, 'holder', 'owner.json'))).toBe(true);
    await first.release();
    const next = await acquire('next', { maxWaitMs: 1000 });
    await next.release();
  });

  it('leaves the queue when it is aborted while waiting, with the signal reason', async () => {
    const first = await acquire('first');
    const controller = new AbortController();
    const reason = new Error('stop waiting');
    const waiting = acquire('aborted', { signal: controller.signal });
    await until(() => ticketFiles().length === 1, 'the ticket');
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(ticketFiles()).toEqual([]);
    expect((await readHeavyQueue(dir)).waiting).toEqual([]);
    // Already aborted: no ticket at all.
    await expect(acquire('late', { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    await first.release();
  });

  it('gives up after maxWaitMs with a heavy_lock_timeout, and its ticket is gone', async () => {
    const first = await acquire('first');
    const started = Date.now();
    const error = await acquire('patient', { maxWaitMs: 200 }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HeavyLockError);
    expect((error as HeavyLockError).code).toBe('heavy_lock_timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(ticketFiles()).toEqual([]);
    await first.release();
  });

  it('releases only while the holder is still its own, and more than once', async () => {
    const first = await acquire('first');
    writeHolder({ ticket: 'someone-else', label: 'someone else' });
    await first.release();
    await first.release();
    expect((await readHeavyQueue(dir)).holder).toMatchObject({ label: 'someone else' });
  });

  it('warns once when its lock was taken over, and runs on', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const first = await acquire('slept');
      writeHolder({ ticket: 'usurper', label: 'usurper' });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const warnings = write.mock.calls.filter(([text]) => String(text).includes('taken over'));
      expect(warnings).toHaveLength(1);
      await first.release();
    } finally {
      write.mockRestore();
    }
  });

  describe('refuses an unusable folder', () => {
    it('whose parent has another mode than 0700', async () => {
      chmodSync(root, 0o755);
      await expect(acquire('x')).rejects.toMatchObject({ code: 'heavy_lock_unavailable' });
    });

    it('whose parent belongs to someone else', async () => {
      // /tmp is the system's (root's, and not 0700): it is never changed, and nothing is made in it.
      await expect(acquireHeavyLock({ dir: '/tmp/heavy', label: 'x' })).rejects.toMatchObject({
        code: 'heavy_lock_unavailable',
      });
      expect(existsSync('/tmp/heavy')).toBe(false);
    });

    it('whose parent is a file', async () => {
      const file = path.join(root, 'file');
      writeFileSync(file, '');
      await expect(acquireHeavyLock({ dir: path.join(file, 'heavy'), label: 'x' })).rejects.toMatchObject({
        code: 'heavy_lock_unavailable',
      });
    });
  });
});
