import Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION, migrations, SESSION_PROVIDER_REPAIR } from './migrations';

export type Db = Database.Database;

let statementsRun = 0;

/**
 * How many prepared statements the runtime connections ran since the process started (PM-1120): the memory log
 * prints the difference between two lines, so a busy period shows up next to its event loop delay.
 */
export function statementCount(): number {
  return statementsRun;
}

type Counted = Record<'run' | 'get' | 'all' | 'iterate', (...args: unknown[]) => unknown>;

/** Makes every statement the connection prepares count each run. */
function countStatements(db: Db): void {
  const prepare = db.prepare.bind(db) as (source: string) => Counted;
  db.prepare = ((source: string) => {
    const statement = prepare(source);
    for (const method of ['run', 'get', 'all', 'iterate'] as const) {
      const original = statement[method].bind(statement);
      statement[method] = (...args) => {
        statementsRun += 1;
        return original(...args);
      };
    }
    return statement;
  }) as Db['prepare'];
}

/**
 * Opens (or creates) the runtime database and applies pending migrations.
 * Pass ":memory:" for an in-memory database (tests).
 */
export function openDatabase(path: string): Db {
  const db = new Database(path);
  countStatements(db);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * Opens a second connection to the runtime database for a worker thread (PM-767): it never migrates, and gives up
 * quickly on a lock so it does not hold the server's writes back. The caller checks `schemaVersion` first.
 */
export function openAuxiliaryDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 50');
  db.pragma('cache_size = -8192');
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
  // Rows written by an older build that shares this database (see SESSION_PROVIDER_REPAIR).
  if (current >= 9) db.exec(SESSION_PROVIDER_REPAIR);
  return current;
}

export function schemaVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }));
}
