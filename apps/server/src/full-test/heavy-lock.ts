import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The machine's heavy-run queue (PM-332, PM-336): one full test, type check or screenshot run at a time
 * across the members' sandboxes, the server's full test and the integrating session. Only node built-ins
 * are used: the CLI (`scripts/heavy/cli.ts`) imports this file directly, and `full-test/index.ts` loads the
 * sandbox runtime. macOS has no `flock` or `lockf`, so the lock is a directory.
 *
 * Layout of the queue folder `dir` (its parent, `projectman-<uid>`, is ours and 0700):
 * - `holder/`: the lock itself (`mkdir` is atomic), with `owner.json` inside;
 * - `queue/<ticket>.json`: one file per waiter. The ticket sorts by the time the waiter queued.
 */

export interface HeavyLockEntry {
  /** `${Date.now() zero-padded to 13}-${pid}-${8 hex}`: sorts by queue time. */
  ticket: string;
  pid: number;
  label: string;
  cwd: string;
  /** `PROJECTMAN_SESSION_ID` of a member's session, when set. */
  sessionId?: string;
  /** ISO. */
  queuedAt: string;
  /** ISO, the holder only: when it got the lock. */
  since?: string;
}

export interface HeavyLockOptions {
  /** The queue folder, e.g. `defaultHeavyLockDir()`. */
  dir: string;
  label: string;
  /** Default `process.cwd()`. */
  cwd?: string;
  sessionId?: string;
  /** Aborting while waiting removes the ticket and rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Then rejects with `HeavyLockError` `heavy_lock_timeout`. */
  maxWaitMs?: number;
  /** When waiting starts, then every `notifyMs` (30 s). */
  onWait?: (wait: { holder: HeavyLockEntry | null; ahead: number; waitedMs: number }) => void;
  /** 5_000. */
  heartbeatMs?: number;
  /** 30_000. */
  staleMs?: number;
  /** 500. */
  pollMs?: number;
  /** 30_000. */
  notifyMs?: number;
}

export interface HeavyLock {
  readonly waitedMs: number;
  /** Idempotent; removes the holder only while it is still this ticket's. */
  release(): Promise<void>;
}

export class HeavyLockError extends Error {
  readonly code: 'heavy_lock_timeout' | 'heavy_lock_unavailable';
  constructor(code: HeavyLockError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HeavyLockError';
    this.code = code;
  }
}

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_NOTIFY_MS = 30_000;
/** Poll rounds in a row that may fail (the folder was removed under us, say) before the lock is given up. */
const MAX_FAILED_ROUNDS = 20;

export function defaultHeavyLockDir(): string {
  return path.join(realpathSync('/tmp'), `projectman-${process.getuid?.() ?? 'user'}`, 'heavy');
}

const layout = (dir: string) => ({
  holder: path.join(dir, 'holder'),
  owner: path.join(dir, 'holder', 'owner.json'),
  queue: path.join(dir, 'queue'),
});

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as NodeJS.ErrnoException).code : undefined;
}

/** False for a process that is gone; a process of another user (EPERM) is alive. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) !== 'ESRCH';
  }
}

/** The file is written under another name and renamed, so a reader never sees half of it. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function parseEntry(text: string): HeavyLockEntry | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const entry = value as Partial<HeavyLockEntry>;
    if (typeof entry.ticket !== 'string' || typeof entry.pid !== 'number') return undefined;
    return entry as HeavyLockEntry;
  } catch {
    return undefined;
  }
}

/** The entry in a file and the file's modification time, or nothing when it is missing or broken. */
async function readEntry(file: string): Promise<{ entry?: HeavyLockEntry; mtimeMs: number } | undefined> {
  try {
    const { mtimeMs } = await stat(file);
    const entry = parseEntry(await readFile(file, 'utf8'));
    return { ...(entry ? { entry } : {}), mtimeMs };
  } catch {
    return undefined;
  }
}

/** Makes the folder; the parent must be ours and 0700, whatever else is in `/tmp`. */
async function prepare(dir: string): Promise<void> {
  const parent = path.dirname(dir);
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const info = await lstat(parent);
    const uid = process.getuid?.();
    if (!info.isDirectory()) throw new Error(`${parent} is not a directory`);
    if (uid !== undefined && info.uid !== uid) throw new Error(`${parent} belongs to another user`);
    if ((info.mode & 0o777) !== 0o700)
      throw new Error(`${parent} has mode ${(info.mode & 0o777).toString(8)}, not 700`);
    await mkdir(layout(dir).queue, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new HeavyLockError(
      'heavy_lock_unavailable',
      `the heavy-run queue folder ${dir} cannot be used: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

interface Waiter {
  entry: HeavyLockEntry;
  file: string;
  mtimeMs: number;
}

/** The tickets in queue order. */
async function listTickets(queueDir: string): Promise<Waiter[]> {
  let names: string[];
  try {
    names = await readdir(queueDir);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return [];
    throw err;
  }
  const waiters: Waiter[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(queueDir, name);
    const read = await readEntry(file);
    if (read?.entry) waiters.push({ entry: read.entry, file, mtimeMs: read.mtimeMs });
  }
  return waiters;
}

/** Who holds the lock and who waits, in queue order (for the PM-300 display). Removes nothing. */
export async function readHeavyQueue(
  dir: string,
  options: { staleMs?: number } = {},
): Promise<{ holder: HeavyLockEntry | null; waiting: HeavyLockEntry[] }> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const paths = layout(dir);
  const holder = (await readEntry(paths.owner))?.entry ?? null;
  const now = Date.now();
  const waiting = (await listTickets(paths.queue).catch(() => [] as Waiter[]))
    .filter((w) => now - w.mtimeMs <= staleMs && pidAlive(w.entry.pid))
    .map((w) => w.entry);
  return { holder, waiting };
}

/** Resolves after `ms`, or rejects with the signal's reason. The timer keeps the process alive: it is waiting. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Waits for the lock in queue order. Waiters and the holder write a heartbeat (the modification time of
 * their file); a ticket or a holder whose heartbeat stopped, or whose process is gone, is removed by the
 * waiter at the head of the queue. A live holder is never broken, however long it runs.
 */
export async function acquireHeavyLock(opts: HeavyLockOptions): Promise<HeavyLock> {
  const { dir, signal } = opts;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const notifyMs = opts.notifyMs ?? DEFAULT_NOTIFY_MS;
  if (signal?.aborted) throw signal.reason;
  await prepare(dir);

  const paths = layout(dir);
  const queuedAt = Date.now();
  const ticket = `${String(queuedAt).padStart(13, '0')}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const entry: HeavyLockEntry = {
    ticket,
    pid: process.pid,
    label: opts.label,
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    queuedAt: new Date(queuedAt).toISOString(),
  };
  const ticketFile = path.join(paths.queue, `${ticket}.json`);
  const stale = (mtimeMs: number, pid: number): boolean => Date.now() - mtimeMs > staleMs || !pidAlive(pid);

  const touch = (file: string): Promise<void> => {
    const now = new Date();
    return utimes(file, now, now).catch(() => undefined);
  };

  /** Our ticket, the live tickets in queue order; the stale ones are removed. */
  const sweep = async (): Promise<HeavyLockEntry[]> => {
    const tickets = await listTickets(paths.queue);
    const live: HeavyLockEntry[] = [];
    let present = false;
    for (const waiter of tickets) {
      if (waiter.entry.ticket === ticket) {
        present = true;
        live.push(waiter.entry);
      } else if (stale(waiter.mtimeMs, waiter.entry.pid)) await rm(waiter.file, { force: true });
      else live.push(waiter.entry);
    }
    if (!present) {
      // Removed under us (a long sleep, a cleaned folder): back in at the same place.
      await writeAtomic(ticketFile, JSON.stringify(entry));
      live.push(entry);
      live.sort((a, b) => (a.ticket < b.ticket ? -1 : 1));
    }
    return live;
  };

  type Round = { acquired: true } | { acquired: false; holder: HeavyLockEntry | null; ahead: number };

  const round = async (): Promise<Round> => {
    const live = await sweep();
    const ahead = Math.max(
      0,
      live.findIndex((e) => e.ticket === ticket),
    );
    const head = ahead === 0;
    const owner = await readEntry(paths.owner);
    let holderExists = owner !== undefined;
    if (!holderExists) {
      // `holder/` without an `owner.json`: being made right now, or left half-made.
      const dirInfo = await stat(paths.holder).catch(() => undefined);
      if (dirInfo) {
        holderExists = true;
        if (head && Date.now() - dirInfo.mtimeMs > staleMs) {
          await breakHolder(paths.holder);
          holderExists = false;
        }
      }
    } else if (stale(owner!.mtimeMs, owner!.entry?.pid ?? 0)) {
      // Only the head of the queue breaks it, so two waiters never break one lock and the second
      // takes the first one's new holder.
      if (head) {
        await breakHolder(paths.holder);
        holderExists = false;
      }
    }
    if (holderExists) return { acquired: false, holder: owner?.entry ?? null, ahead };
    if (!head) return { acquired: false, holder: null, ahead };
    try {
      await mkdir(paths.holder, { mode: 0o700 });
    } catch (err) {
      if (errorCode(err) === 'EEXIST') return { acquired: false, holder: null, ahead };
      throw err;
    }
    try {
      await writeAtomic(paths.owner, JSON.stringify({ ...entry, since: new Date().toISOString() }));
    } catch (err) {
      await rm(paths.holder, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    await rm(ticketFile, { force: true });
    return { acquired: true };
  };

  const ticketTimer = setInterval(() => void touch(ticketFile), heartbeatMs);
  ticketTimer.unref();
  let failedRounds = 0;
  let lastNotice = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      let result: Round | undefined;
      try {
        result = await round();
        failedRounds = 0;
      } catch (err) {
        if (++failedRounds >= MAX_FAILED_ROUNDS)
          throw new HeavyLockError(
            'heavy_lock_unavailable',
            `the heavy-run queue folder ${dir} cannot be used: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        // The folder may have been removed: make it again before the next round.
        await mkdir(paths.queue, { recursive: true, mode: 0o700 }).catch(() => undefined);
      }
      if (result?.acquired) break;
      const waitedMs = Date.now() - queuedAt;
      if (result && (lastNotice === 0 || Date.now() - lastNotice >= notifyMs)) {
        lastNotice = Date.now();
        try {
          opts.onWait?.({ holder: result.holder, ahead: result.ahead, waitedMs });
        } catch {
          // A broken display never stops the wait.
        }
      }
      if (opts.maxWaitMs !== undefined && waitedMs >= opts.maxWaitMs)
        throw new HeavyLockError(
          'heavy_lock_timeout',
          `the heavy-run queue did not free up in ${Math.round(opts.maxWaitMs / 1000)} s`,
        );
      await sleep(
        opts.maxWaitMs === undefined ? pollMs : Math.max(1, Math.min(pollMs, opts.maxWaitMs - waitedMs)),
        signal,
      );
    }
  } catch (err) {
    clearInterval(ticketTimer);
    await rm(ticketFile, { force: true }).catch(() => undefined);
    throw err;
  }
  clearInterval(ticketTimer);

  const waitedMs = Date.now() - queuedAt;
  let warned = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      const owner = await readEntry(paths.owner);
      if (owner?.entry?.ticket === ticket) {
        await touch(paths.owner);
        return;
      }
      if (!warned) {
        warned = true;
        process.stderr.write(
          `heavy: the machine's heavy-run lock of "${opts.label}" was taken over by someone else (the machine slept?); running on.\n`,
        );
      }
    })();
  }, heartbeatMs);
  heartbeat.unref();

  let released: Promise<void> | undefined;
  return {
    waitedMs,
    release() {
      released ??= (async () => {
        clearInterval(heartbeat);
        const owner = await readEntry(paths.owner);
        if (owner?.entry?.ticket === ticket) await breakHolder(paths.holder);
      })().catch(() => undefined);
      return released;
    },
  };
}

/** Moves the holder away (atomic, so one process wins) and removes it. */
async function breakHolder(holder: string): Promise<void> {
  const moved = `${holder}.stale-${randomBytes(4).toString('hex')}`;
  try {
    await rename(holder, moved);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
    throw err;
  }
  await rm(moved, { recursive: true, force: true });
}
