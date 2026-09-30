import type { Db } from './database';
import { parseJson, toJson } from './json';

/**
 * An automatic session start that admission refused for now, as stored: what it needs to be
 * rebuilt (`spec`) and why it waits (`waiting`). Both are JSON the admission module writes and
 * validates when it reads them back (src/domain/admission/deferred-starts.ts).
 */
export interface DeferredStartRecord {
  /** One deferral per key: a later attempt of the same start replaces it. */
  key: string;
  projectKey: string;
  /** The task whose card shows why the start waits; null for a general chat. */
  taskKey: string | null;
  spec: unknown;
  waiting: unknown;
}

interface DeferredStartRow {
  key: string;
  project_key: string;
  task_key: string | null;
  spec: string;
  waiting: string;
}

/** The starts admission deferred, so that they survive a server restart. */
export function createDeferredStartRepository(db: Db) {
  const statements = {
    // REPLACE, not an update: a start that is deferred again counts as the newest.
    save: db.prepare(
      `INSERT OR REPLACE INTO deferred_starts (key, project_key, task_key, spec, waiting)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    remove: db.prepare('DELETE FROM deferred_starts WHERE key = ?'),
    list: db.prepare('SELECT * FROM deferred_starts ORDER BY seq'),
  };
  return {
    /** Stores the deferral, replacing the one of the same key. */
    save(record: DeferredStartRecord): void {
      statements.save.run(
        record.key,
        record.projectKey,
        record.taskKey,
        toJson(record.spec),
        toJson(record.waiting),
      );
    },
    remove(key: string): void {
      statements.remove.run(key);
    },
    /** Every stored deferral, oldest first. A value that is not JSON reads as null. */
    list(): DeferredStartRecord[] {
      return (statements.list.all() as DeferredStartRow[]).map((row) => ({
        key: row.key,
        projectKey: row.project_key,
        taskKey: row.task_key,
        spec: parseJson<unknown>(row.spec, null),
        waiting: parseJson<unknown>(row.waiting, null),
      }));
    },
  };
}
