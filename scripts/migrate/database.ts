import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Reading and copying the SQLite database of a home for the move (PM-143). The source is never
 * opened in place: the database files (the main file, its write-ahead log and its shared-memory
 * file) are copied to a scratch directory, and SQLite recovers the log there. A source that still
 * runs cannot be copied that way (the files would not match each other), so the tool first proves
 * that nothing has the database open.
 */

export const DB_FILE = 'db.sqlite';
const DB_SIDE_FILES = ['-wal', '-shm'] as const;

/** The database files of a home that exist (the main file, then `-wal` and `-shm`). */
export function databaseFiles(home: string): string[] {
  return [DB_FILE, ...DB_SIDE_FILES.map((suffix) => `${DB_FILE}${suffix}`)].filter((name) =>
    existsSync(join(home, name)),
  );
}

/**
 * Whether another process has the database open. SQLite keeps a shared lock on the file for as long
 * as a connection to a write-ahead-log database exists; a connection in exclusive locking mode
 * cannot be opened beside it. Opening one therefore proves that the database is closed everywhere
 * (and leaves no file behind: the probe works on a copy of the files in a scratch directory only
 * when the source is closed, which is the case it tests for).
 */
export function databaseInUse(home: string): boolean {
  const path = join(home, DB_FILE);
  if (!existsSync(path)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { fileMustExist: true, timeout: 0 });
    db.pragma('locking_mode = EXCLUSIVE');
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    db.exec('BEGIN EXCLUSIVE; ROLLBACK');
    return false;
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) return true;
    throw error;
  } finally {
    db?.close();
  }
}

export interface DatabaseSnapshot {
  /** The scratch copy, opened read-write (it is deleted by `dispose`). */
  db: Database.Database;
  dispose(): void;
}

/** A scratch copy of the home's database, opened; the source's files are only read. */
export function snapshotDatabase(home: string): DatabaseSnapshot {
  const dir = mkdtempSync(join(tmpdir(), 'pm-migrate-db-'));
  for (const name of databaseFiles(home)) copyFileSync(join(home, name), join(dir, name));
  if (!existsSync(join(dir, DB_FILE))) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`no database at ${join(home, DB_FILE)}`);
  }
  const db = new Database(join(dir, DB_FILE), { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return {
    db,
    dispose() {
      try {
        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Writes a consistent single-file copy of an open database (SQLite's backup API). */
export async function backupDatabase(db: Database.Database, destination: string): Promise<void> {
  mkdirSync(join(destination, '..'), { recursive: true });
  await db.backup(destination);
  // One self-contained file: reading the copy later must not create a write-ahead log beside it
  // (the server turns the log mode on again when it opens the database).
  const copy = new Database(destination);
  try {
    copy.pragma('journal_mode = DELETE');
  } finally {
    copy.close();
  }
}
