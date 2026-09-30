import Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION, migrations } from './migrations';

export type Db = Database.Database;

/**
 * Opens (or creates) the runtime database and applies pending migrations.
 * Pass ":memory:" for an in-memory database (tests).
 */
export function openDatabase(path: string): Db {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * Applies every migration newer than `PRAGMA user_version`; returns the resulting version.
 * A database written by a newer build is refused: this build would misread it.
 */
export function migrate(db: Db): number {
  let current = schemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION)
    throw new Error(
      `The database is at schema version ${current}, but this build of projectman knows only up to ` +
        `${LATEST_SCHEMA_VERSION}. Run a newer build, or restore a backup made by this one.`,
    );
  const pending = [...migrations].filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
    current = migration.version;
  }
  return current;
}

export function schemaVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }));
}
