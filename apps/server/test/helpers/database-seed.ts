import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db';
import type { Db } from '../../src/db';

let memoryTemplate: Buffer | undefined;
let fileTemplate: Buffer | undefined;

/** The bytes of an in-memory database with every migration applied, built once per test process. */
function migratedMemory(): Buffer {
  if (memoryTemplate) return memoryTemplate;
  const db = openDatabase(':memory:');
  memoryTemplate = db.serialize();
  db.close();
  return memoryTemplate;
}

/** The same as a database file (its header says WAL, which a memory database cannot open). */
function migratedFile(): Buffer {
  if (fileTemplate) return fileTemplate;
  const dir = mkdtempSync(join(tmpdir(), 'pm-db-seed-'));
  try {
    const file = join(dir, 'db.sqlite');
    openDatabase(file).close();
    fileTemplate = readFileSync(file);
    return fileTemplate;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `openDatabase(':memory:')` without running the migrations again (about 45 ms of SQL each time):
 * the database starts from a copy of one that is migrated already (or from `bytes`, a serialized
 * database of the caller's own).
 */
export function openMigratedMemoryDatabase(bytes: Buffer = migratedMemory()): Db {
  const db = new Database(bytes);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Writes a migrated database file at `path`; `openDatabase(path)` then finds nothing to migrate. */
export function seedDatabaseFile(path: string): void {
  writeFileSync(path, migratedFile());
}
