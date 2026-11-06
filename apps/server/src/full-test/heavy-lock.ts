import { machinePlaces } from '@projectman/shared';
import { Effect, Exit, Scope } from 'effect';
import { runPromise } from '../kernel';
import { holderHeartbeat, waitForLock } from './heavy-lock-core';
import { readFreshPressure } from './machine-pressure';
import type { HeavyWait, LockWaitAborted, LockWaitTimedOut, LockQueueUnusable } from './heavy-lock-core';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export { defaultHeavyLockDir } from './heavy-lock-dir';
export type { HeavyWait } from './heavy-lock-core';

/**
 * The machine's heavy-run pool (PM-332, PM-336, PM-1278): the places of the machine, one place per heavy node
 * process, handed out in queue order to the members' sandboxes, the server's full test and the integrating
 * session. A full run asks for all places and so runs alone; a workspace test run asks for 2 to 4. Only node
 * built-ins, Effect (through heavy-lock-core and kernel) and the pure capacity formula of shared are used: the
 * CLI (`scripts/heavy/cli.ts`) imports this file directly, independently of the sandbox runtime. macOS has
 * no `flock` or `lockf`, so the full grant is a directory.
 *
 * Layout of the folder `dir` (its parent, `projectman-<uid>`, is ours and 0700):
 * - `queue/<ticket>.json`: one file per waiter. The ticket sorts by the time the waiter queued. Only the
 *   head of the queue hands out places, and only to itself, so the pool needs no mutex;
 * - `holders/<ticket>.json`: a partial grant, with the places in `granted`;
 * - `holder/owner.json`: a grant of all places (`mkdir` of `holder/` is atomic). The older builds had only
 *   this one holder: their entry has no `granted` and counts as all places, and a request without `places`
 *   counts as `'all'`. A new full grant takes `holder/` too, so an older build waits behind it;
 * - `pressure.json`: the engine's reading of the machine's memory pressure (`machine-pressure.ts`). While a
 *   fresh one is `critical` the head hands out nothing; a stale or missing one holds nothing back.
 */

/** `'all'` is `{ min: capacity, max: capacity }`. */
export type PlacesRequest = 'all' | { min: number; max: number };

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
  /** ISO, the holder only: when it got the places. */
  since?: string;
  /** The request; absent (an older build) means `'all'`. */
  places?: PlacesRequest;
  /** The holder only: the places it holds now. Absent (an older build) means all. */
  granted?: number;
  /** `cwd` and the command, at most `COMMAND_MAX` characters: the key of the duplicate rule. */
  command?: string;
}

/** The longest `command` of an entry. */
export const COMMAND_MAX = 300;

export interface HeavyLockOptions {
  /** The pool's folder, e.g. `defaultHeavyLockDir()`. */
  dir: string;
  label: string;
  /** Default `process.cwd()`. */
  cwd?: string;
  sessionId?: string;
  /** Default `'all'`. */
  places?: PlacesRequest;
  /** The key of the duplicate rule (with the session id); see `heavyCommandKey`. */
  command?: string;
  /** The pool's size; default `machinePlaces` of this machine. */
  capacity?: number;
  /** Aborting while waiting removes the ticket and rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Then rejects with `HeavyLockError` `heavy_lock_timeout`. */
  maxWaitMs?: number;
  /** When waiting starts, then every `notifyMs` (30 s). */
  onWait?: (wait: HeavyWait & { waitedMs: number }) => void;
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
  /** The holder's ticket: what a nested run carries in `PROJECTMAN_HEAVY_LOCK_HELD`. */
  readonly ticket: string;
  /** The places held now. */
  readonly granted: number;
  /** Gives back places down to `places` (never more, never below 1); a no-op otherwise. */
  reduce(places: number): Promise<void>;
  /** Idempotent; removes the holder only while it is still this ticket's. */
  release(): Promise<void>;
  /** `release` for a process that is exiting, where nothing async runs any more. */
  releaseSync(): void;
}

export class HeavyLockError extends Error {
  readonly code: 'heavy_lock_timeout' | 'heavy_lock_unavailable' | 'heavy_lock_duplicate';
  /** `heavy_lock_duplicate`: the entry that is running the same command. */
  readonly running?: HeavyLockEntry;
  constructor(
    code: HeavyLockError['code'],
    message: string,
    options?: { cause?: unknown; running?: HeavyLockEntry },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HeavyLockError';
    this.code = code;
    if (options?.running) this.running = options.running;
  }
}

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_NOTIFY_MS = 30_000;

const layout = (dir: string) => ({
  holder: path.join(dir, 'holder'),
  owner: path.join(dir, 'holder', 'owner.json'),
  holders: path.join(dir, 'holders'),
  queue: path.join(dir, 'queue'),
});

/** This machine's input of `machinePlaces`: the cores, and the memory the cgroup of a container allows. */
export function machineHost(): { cpus: number; memoryBytes: number } {
  return {
    cpus: os.availableParallelism(),
    memoryBytes: Math.min(os.totalmem(), process.constrainedMemory() || Infinity),
  };
}

/** The key of the duplicate rule: the folder and the command, at most `COMMAND_MAX` characters. */
export function heavyCommandKey(cwd: string, argv: readonly string[]): string {
  return [cwd, ...argv].join(' ').slice(0, COMMAND_MAX);
}

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
    await mkdir(layout(dir).holders, { recursive: true, mode: 0o700 });
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

/** A holder: a file of `holders/`, or the `holder/owner.json` of a full grant or of an older build. */
interface Holder extends Waiter {
  /** The places it holds: an entry without `granted` (an older build) holds all. */
  granted: number;
  full: boolean;
}

/** Every holder file, stale ones included, `holder/owner.json` first. */
async function listHolders(dir: string, capacity: number): Promise<Holder[]> {
  const paths = layout(dir);
  const holders: Holder[] = [];
  const owner = await readEntry(paths.owner);
  if (owner?.entry)
    holders.push({
      entry: owner.entry,
      file: paths.owner,
      mtimeMs: owner.mtimeMs,
      granted: placesOf(owner.entry.granted, capacity),
      full: true,
    });
  for (const waiter of await listTickets(paths.holders).catch(() => [] as Waiter[]))
    holders.push({ ...waiter, granted: placesOf(waiter.entry.granted, capacity), full: false });
  return holders;
}

/** A recorded number of places, or all when there is none. */
const placesOf = (granted: unknown, capacity: number): number =>
  typeof granted === 'number' && Number.isFinite(granted) && granted >= 1
    ? Math.min(Math.floor(granted), capacity)
    : capacity;

/** Who holds places and who waits, in queue order (for the PM-300 display). Removes nothing. */
export async function readHeavyQueue(
  dir: string,
  options: { staleMs?: number; capacity?: number } = {},
): Promise<{ holder: HeavyLockEntry | null; holders: HeavyLockEntry[]; waiting: HeavyLockEntry[] }> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const capacity = options.capacity ?? machinePlaces(machineHost());
  const paths = layout(dir);
  const now = Date.now();
  const holders = (await listHolders(dir, capacity).catch(() => [] as Holder[]))
    .filter((h) => h.full || (now - h.mtimeMs <= staleMs && pidAlive(h.entry.pid)))
    .map((h) => h.entry);
  const waiting = (await listTickets(paths.queue).catch(() => [] as Waiter[]))
    .filter((w) => now - w.mtimeMs <= staleMs && pidAlive(w.entry.pid))
    .map((w) => w.entry);
  return { holder: holders[0] ?? null, holders, waiting };
}

/** Live holder and waiter session ids (PM-569). Reads only; an unreadable queue gives no sessions. */
export async function readHeavyRunSessions(
  dir: string,
  options: { staleMs?: number } = {},
): Promise<string[]> {
  try {
    const paths = layout(dir);
    const entries = await listTickets(paths.queue);
    entries.push(...(await listHolders(dir, 1)));
    const now = Date.now();
    return [
      ...new Set(
        entries
          .filter(
            ({ entry, mtimeMs }) =>
              now - mtimeMs <= (options.staleMs ?? DEFAULT_STALE_MS) && pidAlive(entry.pid),
          )
          .map(({ entry }) => entry.sessionId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
  } catch {
    return [];
  }
}

/** Fresh entries of a session, including the full-grant holder used by older builds. */
async function sessionRuns(dir: string, sessionId: string): Promise<Waiter[]> {
  const entries = [...(await listTickets(layout(dir).queue)), ...(await listHolders(dir, 1))];
  const now = Date.now();
  return entries.filter(
    ({ entry, mtimeMs }) =>
      entry.sessionId === sessionId &&
      Number.isInteger(entry.pid) &&
      entry.pid > 1 &&
      now - mtimeMs < DEFAULT_STALE_MS,
  );
}

/** Stop this session's leftover runs on their engine; never signal a stale or replaced entry. */
export async function endHeavySessionRuns(
  dir: string,
  sessionId: string,
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => unknown = process.kill,
): Promise<number> {
  const stopped = new Map<string, HeavyLockEntry>();
  const signal = (entry: HeavyLockEntry, value: 'SIGTERM' | 'SIGKILL'): boolean => {
    try {
      kill(entry.pid, value);
      return true;
    } catch {
      return false;
    }
  };
  for (const { entry } of await sessionRuns(dir, sessionId)) {
    if (!stopped.has(entry.ticket) && signal(entry, 'SIGTERM')) stopped.set(entry.ticket, entry);
  }
  if (stopped.size > 0)
    setTimeout(() => {
      void sessionRuns(dir, sessionId)
        .then((entries) => {
          for (const { entry } of entries) {
            if (stopped.get(entry.ticket)?.pid === entry.pid) signal(entry, 'SIGKILL');
          }
        })
        .catch(() => undefined);
    }, 10_000).unref();
  return stopped.size;
}

/**
 * Waits for the lock in queue order. Waiters and the holder write a heartbeat (the modification time of
 * their file); a ticket or a holder whose heartbeat stopped, or whose process is gone, is removed by the
 * waiter at the head of the queue. A live holder is never broken, however long it runs.
 * A held lock keeps the process alive until release().
 */
export async function acquireHeavyLock(opts: HeavyLockOptions): Promise<HeavyLock> {
  const { dir, signal } = opts;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const notifyMs = opts.notifyMs ?? DEFAULT_NOTIFY_MS;
  const capacity = Math.max(1, Math.floor(opts.capacity ?? machinePlaces(machineHost())));
  const request = opts.places ?? 'all';
  const wantMin = request === 'all' ? capacity : clampPlaces(request.min, capacity);
  const wantMax = request === 'all' ? capacity : Math.max(wantMin, clampPlaces(request.max, capacity));
  if (signal?.aborted) throw signal.reason;
  await prepare(dir);

  const paths = layout(dir);
  if (opts.sessionId && opts.command) {
    // The same command from the same session, while the first lives (waiting or holding): not again.
    const running = await findRunning(dir, opts.sessionId, opts.command, capacity, staleMs);
    if (running)
      throw new HeavyLockError('heavy_lock_duplicate', alreadyRunningMessage(running), { running });
  }
  const queuedAt = Date.now();
  const ticket = `${String(queuedAt).padStart(13, '0')}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const entry: HeavyLockEntry = {
    ticket,
    pid: process.pid,
    label: opts.label,
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    queuedAt: new Date(queuedAt).toISOString(),
    places: request,
    ...(opts.command ? { command: opts.command.slice(0, COMMAND_MAX) } : {}),
  };
  /** The file this process holds its places in, and what it holds: set when the turn comes. */
  let holderFile = paths.owner;
  let granted = 0;
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

  type Round = { acquired: true } | ({ acquired: false } & HeavyWait);

  const round = async (): Promise<Round> => {
    const live = await sweep();
    const ahead = Math.max(
      0,
      live.findIndex((e) => e.ticket === ticket),
    );
    const head = ahead === 0;
    const holders = await listHolders(dir, capacity);
    const owner = await readEntry(paths.owner);
    // `holder/` without an `owner.json`: being made right now, or left half-made. It holds all places.
    let halfMade = false;
    if (owner === undefined) {
      const dirInfo = await stat(paths.holder).catch(() => undefined);
      if (dirInfo) {
        halfMade = true;
        if (head && Date.now() - dirInfo.mtimeMs > staleMs) {
          await breakHolder(paths.holder);
          halfMade = false;
        }
      }
    }
    const holding: Holder[] = [];
    for (const holder of holders) {
      if (!stale(holder.mtimeMs, holder.entry.pid)) holding.push(holder);
      // Only the head of the queue breaks a holder, so two waiters never break one and the second
      // takes the first one's new grant. The others count it until then.
      else if (!head) holding.push(holder);
      else if (holder.full) await breakHolder(paths.holder);
      else await rm(holder.file, { force: true });
    }
    const used = holding.reduce((sum, h) => sum + h.granted, 0);
    const free = Math.max(0, capacity - (halfMade ? capacity : used));
    // The engine's reading of the machine (PM-1314): a fresh critical one hands out nothing.
    const critical = (await readFreshPressure(dir)) === 'critical';
    const waitInfo = (): Round => ({
      acquired: false,
      holder: holding[0]?.entry ?? null,
      holders: holding.map((h) => h.entry),
      ahead,
      free,
      capacity,
      ...(critical ? { pressure: 'critical' as const } : {}),
    });
    if (!head || free < wantMin || critical) return waitInfo();
    const count = Math.min(wantMax, free);
    const since = new Date().toISOString();
    const grantedEntry = { ...entry, since, granted: count };
    if (count >= capacity) {
      // All places: `holder/` as in the older builds, which then wait behind it.
      try {
        await mkdir(paths.holder, { mode: 0o700 });
      } catch (err) {
        if (errorCode(err) === 'EEXIST') return waitInfo();
        throw err;
      }
      try {
        await writeAtomic(paths.owner, JSON.stringify(grantedEntry));
      } catch (err) {
        await rm(paths.holder, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
      holderFile = paths.owner;
    } else {
      holderFile = path.join(paths.holders, `${ticket}.json`);
      await writeAtomic(holderFile, JSON.stringify(grantedEntry));
    }
    granted = count;
    await rm(ticketFile, { force: true });
    return { acquired: true };
  };

  const lockScope = Scope.makeUnsafe();
  const toCallerError = (err: LockWaitAborted | LockWaitTimedOut | LockQueueUnusable): unknown => {
    if (err._tag === 'LockWaitAborted') return err.reason;
    if (err._tag === 'LockWaitTimedOut')
      return new HeavyLockError(
        'heavy_lock_timeout',
        `the heavy-run queue did not free up in ${Math.round(opts.maxWaitMs! / 1000)} s`,
      );
    const cause = err.cause;
    return new HeavyLockError(
      'heavy_lock_unavailable',
      `the heavy-run queue folder ${dir} cannot be used: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  };
  const waitedMs = await runPromise(
    waitForLock({
      takeTurn: round,
      remakeQueue: () =>
        mkdir(paths.queue, { recursive: true, mode: 0o700 })
          .then(() => undefined)
          .catch(() => undefined),
      touchTicket: () => touch(ticketFile),
      removeTicket: () => rm(ticketFile, { force: true }).catch(() => undefined),
      onWait: opts.onWait,
      signal,
      queuedAt,
      heartbeatMs,
      pollMs,
      notifyMs,
      maxWaitMs: opts.maxWaitMs,
    }).pipe(
      Effect.tap(() =>
        Effect.forkIn(
          holderHeartbeat({
            heartbeatMs,
            beat: async () => {
              const own = await readEntry(holderFile);
              if (own?.entry?.ticket !== ticket) return false;
              await touch(holderFile);
              return true;
            },
            takenOver: () =>
              process.stderr.write(
                `heavy: the machine's heavy-run lock of "${opts.label}" was taken over by someone else (the machine slept?); running on.\n`,
              ),
          }),
          lockScope,
          { startImmediately: true },
        ),
      ),
      Effect.mapError(toCallerError),
    ),
  );

  let released: Promise<void> | undefined;
  return {
    waitedMs,
    ticket,
    get granted() {
      return granted;
    },
    async reduce(places) {
      const next = Math.floor(places);
      if (released || !(next >= 1) || next >= granted) return;
      const own = await readEntry(holderFile);
      if (own?.entry?.ticket !== ticket) return;
      await writeAtomic(holderFile, JSON.stringify({ ...own.entry, granted: next }));
      granted = next;
    },
    releaseSync() {
      // For a process that is exiting: nothing async runs any more.
      try {
        if (parseEntry(readFileSync(holderFile, 'utf8'))?.ticket !== ticket) return;
        rmSync(holderFile === paths.owner ? paths.holder : holderFile, { recursive: true, force: true });
      } catch {
        /* Nothing left to release. */
      }
    },
    release() {
      released ??= runPromise(Scope.close(lockScope, Exit.void))
        .then(async () => {
          const own = await readEntry(holderFile);
          if (own?.entry?.ticket !== ticket) return;
          if (holderFile === paths.owner) await breakHolder(paths.holder);
          else await rm(holderFile, { force: true });
        })
        .catch(() => undefined);
      return released;
    },
  };
}

const clampPlaces = (value: number, capacity: number): number =>
  Math.max(1, Math.min(capacity, Math.floor(Number.isFinite(value) ? value : 1)));

/** `HH:MM` of an ISO time, `?` when it cannot be read. */
export function clockMinutes(iso: string | undefined): string {
  const date = iso ? new Date(iso) : undefined;
  if (!date || Number.isNaN(date.getTime())) return '?';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** What the second call of a command tells (exit status 79): the first one is still running. */
export function alreadyRunningMessage(running: HeavyLockEntry): string {
  return (
    `the same command is already running in your session since ${clockMinutes(running.since ?? running.queuedAt)} (pid ${running.pid}): ` +
    'wait for its completion notification and read its output; this call did not start it again.'
  );
}

/** A live waiter or holder of this session with the same command and another pid, if any. */
async function findRunning(
  dir: string,
  sessionId: string,
  command: string,
  capacity: number,
  staleMs: number,
): Promise<HeavyLockEntry | undefined> {
  const paths = layout(dir);
  const key = command.slice(0, COMMAND_MAX);
  const now = Date.now();
  const entries = [
    ...(await listHolders(dir, capacity).catch(() => [] as Waiter[])),
    ...(await listTickets(paths.queue).catch(() => [] as Waiter[])),
  ];
  return entries.find(
    ({ entry, mtimeMs }) =>
      entry.sessionId === sessionId &&
      entry.command === key &&
      entry.pid !== process.pid &&
      now - mtimeMs <= staleMs &&
      pidAlive(entry.pid),
  )?.entry;
}

/**
 * Whether a nested run may go on without asking for places: `held` is what the holder passed down in
 * `PROJECTMAN_HEAVY_LOCK_HELD`, its ticket, and the holder is alive. A bare `1` (older builds) is good only
 * while a holder of the old kind, `holder/owner.json`, is alive: setting it by hand frees nobody.
 */
export async function heavyHeldBy(dir: string, held: string | undefined): Promise<boolean> {
  if (!held) return false;
  const now = Date.now();
  const live = ({ entry, mtimeMs }: Waiter): boolean =>
    now - mtimeMs <= DEFAULT_STALE_MS && pidAlive(entry.pid);
  const paths = layout(dir);
  const owner = await readEntry(paths.owner);
  const ownerLive =
    owner?.entry !== undefined && live({ entry: owner.entry, file: paths.owner, mtimeMs: owner.mtimeMs });
  if (held === '1') return ownerLive;
  if (ownerLive && owner!.entry!.ticket === held) return true;
  const own = await readEntry(path.join(layout(dir).holders, `${path.basename(held)}.json`));
  return (
    own?.entry !== undefined &&
    own.entry.ticket === held &&
    live({ entry: own.entry, file: '', mtimeMs: own.mtimeMs })
  );
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
