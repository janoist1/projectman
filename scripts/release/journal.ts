import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  HybridRecoveryCode,
  ReleaseCommitSha,
  ReleaseDeployBegin,
  ReleaseDeployChange,
  ReleaseHash,
  ReleaseImageRef,
} from '@projectman/shared';
import { refused } from '../cloud/errors';
import { releaseIdSchema } from './receipt';

/**
 * The hybrid coordinator's journal (PM-751): what the local watcher is doing, on disk. It is written before every
 * side effect, so a watcher that was stopped (a crash, a reboot, a kill) finds out where it was. It holds no
 * secret: identifiers, hashes, paths, and fixed-text failures. The cloud's durable deployment (PM-752) is the
 * other half of the record; neither is ever deleted to make a problem go away.
 */

export const JOURNAL_FILE = 'journal.json';
const LOCK_FILE = 'watch.lock';
export const JOURNAL_ARCHIVE_DIR = 'journals';

const LOCAL_PHASES = [
  'claim',
  'prepare',
  'bind',
  'quiesce',
  'drain',
  'import',
  'cloud_start',
  'cloud_verify',
  'engine_stop',
  'engine_start',
  'engine_verify',
  'report_live',
  'resume',
  'publish',
  'rollback_engine',
  'rollback_cloud',
  'report_failed',
  'recovery_required',
  'complete',
] as const;
export const LocalPhase = z.enum(LOCAL_PHASES);
export type LocalPhase = z.infer<typeof LocalPhase>;

/** Why the attempt goes back, as the coordinator's own fixed vocabulary (it never carries a raw error). */
const LOCAL_FAILURE_CODES = [
  'prepare_failed',
  'quiesce_refused',
  'drain_timeout',
  'switch_refused',
  'cloud_import_failed',
  'cloud_start_failed',
  'cloud_verify_failed',
  'engine_start_failed',
  'engine_verify_failed',
  'live_refused',
] as const;
export const JournalFailureCode = z.enum([...LOCAL_FAILURE_CODES, ...HybridRecoveryCode.options]);
export type JournalFailureCode = z.infer<typeof JournalFailureCode>;

const absolutePath = z
  .string()
  .min(2)
  .refine(
    (value) =>
      path.isAbsolute(value) &&
      path.normalize(value) === value &&
      !value.endsWith(path.sep) &&
      !/[\0\r\n]/.test(value),
    'a normalized absolute path',
  );
const timestamp = z.iso.datetime();

const pendingRequestSchema = z.discriminatedUnion('op', [
  ReleaseDeployBegin.extend({ op: z.literal('release_deploy_begin') }),
  ReleaseDeployChange.extend({ op: z.literal('release_deploy_change') }),
]);

export const hybridReleaseJournalSchema = z.strictObject({
  version: z.literal(1),
  releaseId: releaseIdSchema,
  attemptId: z.uuid(),
  controllerId: z.uuid(),
  targetHash: ReleaseHash,
  commit: ReleaseCommitSha,
  /** The deployment revision this journal has seen accepted. */
  revision: z.number().int().nonnegative(),
  phase: LocalPhase,
  configSha256: ReleaseHash,
  outputDir: absolutePath,
  receiptPath: absolutePath.nullable(),
  receiptSha256: ReleaseHash.nullable(),
  /** What ran before the switch: where the rollback goes back to. */
  previous: z.strictObject({
    image: ReleaseImageRef,
    engineRoot: absolutePath,
    engineCommit: ReleaseCommitSha,
    enginePid: z.number().int().positive(),
    engineBootId: z.string().min(1).max(200),
    plistPath: absolutePath,
    plistSha256: ReleaseHash,
    schemaVersion: z.number().int().nonnegative(),
  }),
  pauseId: z.string().nullable(),
  /** The request that may have been sent: resent with the same id and body after a lost answer, never rebuilt. */
  pendingRequest: pendingRequestSchema.nullable(),
  publish: z.strictObject({
    tag: z.string().nullable(),
    url: z.string().nullable(),
    attemptedAt: timestamp.nullable(),
  }),
  failure: z.strictObject({ code: JournalFailureCode, message: z.string().max(2000) }).nullable(),
  startedAt: timestamp,
  updatedAt: timestamp,
});
export type HybridReleaseJournal = z.output<typeof hybridReleaseJournalSchema>;

/** Phases from which nothing is left to do: the journal may be archived. */
const TERMINAL_PHASES: readonly LocalPhase[] = ['complete'];

export type JournalRead = { kind: 'none' } | { kind: 'ok'; journal: HybridReleaseJournal };

const FILE_MODE = 0o600;

function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** A 0600 file written to a new temporary name, synced, renamed over the target, and the directory synced. */
function writeAtomic(file: string, content: string, replace: boolean): void {
  const dir = path.dirname(file);
  const temporary = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    if (replace) fs.renameSync(temporary, file);
    else {
      // A new file only: the hard link fails when one stands there already.
      fs.linkSync(temporary, file);
      fs.rmSync(temporary, { force: true });
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw refused('a release journal exists already: it is never overwritten');
    throw error;
  }
  fsyncDirectory(dir);
}

/** A regular file of ours, no wider than 0600, read through its descriptor. */
function readPrivateText(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw refused('the release state file cannot be opened safely');
  }
  try {
    const stat = fs.fstatSync(fd);
    const mine = process.getuid?.();
    if (!stat.isFile() || (mine !== undefined && stat.uid !== mine) || (stat.mode & 0o177) !== 0)
      throw refused('the release state file must be a regular 0600 file of ours');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** The journal as the coordinator uses it: tests replace it with one that fails after a given write. */
export interface JournalPort {
  read(): JournalRead;
  /** The first record of an attempt; refuses when a journal is there. */
  create(journal: HybridReleaseJournal): void;
  /** The next record: replaces the file atomically. */
  write(journal: HybridReleaseJournal): void;
  /** Moves the finished journal to the archive; the archive is never pruned. */
  archive(journal: HybridReleaseJournal): void;
}

export class JournalStore implements JournalPort {
  private readonly file: string;
  private readonly archiveDir: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, JOURNAL_FILE);
    this.archiveDir = path.join(stateDir, JOURNAL_ARCHIVE_DIR);
  }

  read(): JournalRead {
    const text = readPrivateText(this.file);
    if (text === null) return { kind: 'none' };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw refused(
        'the release journal is corrupt: it stays where it is and nothing runs until a person looks',
      );
    }
    // A journal of a newer coordinator is never read as an older one: it could drop a field that matters.
    if (raw && typeof raw === 'object' && (raw as { version?: unknown }).version !== 1)
      throw refused(
        'the release journal has another version: update the coordinator, do not delete the journal',
      );
    const parsed = hybridReleaseJournalSchema.safeParse(raw);
    if (!parsed.success)
      throw refused(
        'the release journal is not valid: it stays where it is and nothing runs until a person looks',
      );
    return { kind: 'ok', journal: parsed.data };
  }

  create(journal: HybridReleaseJournal): void {
    writeAtomic(this.file, `${JSON.stringify(hybridReleaseJournalSchema.parse(journal), null, 2)}\n`, false);
  }

  write(journal: HybridReleaseJournal): void {
    writeAtomic(this.file, `${JSON.stringify(hybridReleaseJournalSchema.parse(journal), null, 2)}\n`, true);
  }

  /** True when the archive file is a valid copy of this very attempt; anything else standing there is refused. */
  private archivedAlready(target: string, journal: HybridReleaseJournal): boolean {
    const text = readPrivateText(target);
    if (text === null) return false;
    let raw: unknown = null;
    try {
      raw = JSON.parse(text);
    } catch {
      // Not JSON: refused below.
    }
    const parsed = hybridReleaseJournalSchema.safeParse(raw);
    if (
      parsed.success &&
      parsed.data.attemptId === journal.attemptId &&
      parsed.data.releaseId === journal.releaseId
    )
      return true;
    throw refused('a different journal archive stands where this attempt would be archived');
  }

  archive(journal: HybridReleaseJournal): void {
    if (!fs.existsSync(this.archiveDir)) fs.mkdirSync(this.archiveDir, { mode: 0o700 });
    const target = path.join(this.archiveDir, `${journal.releaseId}-${journal.attemptId}.json`);
    if (!this.archivedAlready(target, journal))
      writeAtomic(target, `${JSON.stringify(hybridReleaseJournalSchema.parse(journal), null, 2)}\n`, false);
    // A round that stopped after the archive was written but before the journal was removed finishes here.
    fs.rmSync(this.file, { force: true });
    fsyncDirectory(path.dirname(this.file));
  }
}

/** True when the watcher's journal has an unfinished attempt; unreadable counts as unfinished. */
export function hasActiveJournal(stateDir: string): boolean {
  try {
    const read = new JournalStore(stateDir).read();
    return read.kind === 'ok' && !TERMINAL_PHASES.includes(read.journal.phase);
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// The local exclusion: one watcher per state directory.
// ---------------------------------------------------------------------------------------------

interface LockDeps {
  pid: number;
  /** Whether a process with this id runs (a process of another user counts as running). */
  isAlive(pid: number): boolean;
  now(): Date;
}

const processLockDeps: LockDeps = {
  pid: process.pid,
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  now: () => new Date(),
};

const lockContent = z.strictObject({ pid: z.number().int().positive(), nonce: z.string(), at: timestamp });

interface HeldLocalLock {
  release(): void;
}

/**
 * The state directory's exclusion lock: the file names the owner's pid and a nonce. A lock whose process is gone
 * is cleaned (only that file, only after it was read as ours); one that is unreadable or alive refuses the run.
 */
export function acquireLocalLock(stateDir: string, deps: LockDeps = processLockDeps): HeldLocalLock {
  const file = path.join(stateDir, LOCK_FILE);
  const mine = { pid: deps.pid, nonce: randomBytes(8).toString('hex'), at: deps.now().toISOString() };
  const text = `${JSON.stringify(mine)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(
        file,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        FILE_MODE,
      );
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {
        release() {
          try {
            if (fs.readFileSync(file, 'utf8') === text) fs.rmSync(file, { force: true });
          } catch {
            // The lock is gone already.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let owner: z.output<typeof lockContent>;
    try {
      const body = readPrivateText(file);
      if (body === null) continue;
      owner = lockContent.parse(JSON.parse(body));
    } catch {
      throw refused('the release lock is unreadable: another watcher may run, nothing is removed');
    }
    if (deps.isAlive(owner.pid)) throw refused('another release watcher runs on this state directory');
    // The owner is gone: this exact stale lock is cleaned, then the loop takes the lock once more.
    try {
      if (readPrivateText(file) === `${JSON.stringify(owner)}\n`) fs.rmSync(file, { force: true });
    } catch {
      throw refused('the stale release lock cannot be cleaned');
    }
  }
  throw refused('the release lock could not be taken');
}

/** Whether the old single-target live watcher has a journal in one of these homes: never both at once. */
export function oldLiveJournalExists(homes: readonly string[]): boolean {
  return homes.some(
    (home) =>
      fs.lstatSync(path.join(home, 'release', 'journal.json'), { throwIfNoEntry: false }) !== undefined,
  );
}
