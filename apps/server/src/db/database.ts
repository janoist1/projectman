import Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION, migrations } from './migrations';
import { BASELINE_RELEASE, BASELINE_SQL, BASELINE_VERSION } from './schema/baseline-0152';

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
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    if (path !== ':memory:') db.pragma('journal_mode = WAL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
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
 * Initializes an empty database from the baseline, then applies newer migrations.
 * Refuses pre-baseline, foreign unversioned and newer-build databases before writing.
 */
export function migrate(db: Db): number {
  let current = schemaVersion(db);
  const refusal = schemaRefusal(current, hasSchemaObjects(db));
  if (refusal) throw new Error(refusal);
  if (current === 0) {
    db.transaction(() => {
      db.exec(BASELINE_SQL);
      db.pragma(`user_version = ${BASELINE_VERSION}`);
    })();
    current = BASELINE_VERSION;
  }
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

/** Whether version zero belongs to an empty file or to an unversioned foreign database. */
export function hasSchemaObjects(db: Db): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() !== undefined;
}

/** Shared, read-only refusal for runtime startup and migration tools. */
export function schemaRefusal(version: number, hasObjects: boolean): string | null {
  if (version > LATEST_SCHEMA_VERSION)
    return (
      `The database is at schema version ${version}, but this build of projectman knows only up to ` +
      `${LATEST_SCHEMA_VERSION}. Run a newer build, or restore a backup made by this one.`
    );
  if (version > 0 && version < BASELINE_VERSION)
    return `The database is at schema version ${version}, but this build of projectman starts only from version ${BASELINE_VERSION}: older migrations were replaced by a baseline. Start projectman ${BASELINE_RELEASE} on this database once (it upgrades it to version ${BASELINE_VERSION} or later), then this build. See docs/DEPLOY.md, "A database from before the baseline".`;
  if (version === 0 && hasObjects)
    return 'The database has tables but no schema version, so projectman did not create it. Open an empty file or a projectman database.';
  return null;
}
