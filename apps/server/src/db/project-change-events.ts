import type { ProjectChangeKind } from '@projectman/shared';
import type { Db } from './database';

export interface ProjectChangeRow {
  seq: number;
  projectKey: string;
  kind: ProjectChangeKind;
  entityId: string | null;
  at: string;
}

interface ChangeRow {
  seq: number;
  project_key: string;
  kind: ProjectChangeKind;
  entity_id: string | null;
  at: string;
}

/**
 * The durable project change journal (PM-761). `append` belongs in the transaction of the change it
 * announces, so a rollback leaves no entry. The generation is created once with the database: another
 * one means the journal is not the one a cursor was issued for.
 */
export function createProjectChangeEventRepository(db: Db) {
  const insert = db.prepare(
    'INSERT INTO project_change_events (project_key, kind, entity_id, at) VALUES (?, ?, ?, ?)',
  );
  return {
    generation(): string {
      const row = db
        .prepare("SELECT value FROM instance_meta WHERE key = 'project_change_generation'")
        .get() as { value: string } | undefined;
      if (!row) throw new Error('The database has no event generation');
      return row.value;
    },
    append(projectKey: string, kind: ProjectChangeKind, entityId: string | null, at: string): number {
      return Number(insert.run(projectKey, kind, entityId, at).lastInsertRowid);
    },
    /** The entries of the project behind `afterSeq`, oldest first. */
    list(projectKey: string, afterSeq: number, limit: number): ProjectChangeRow[] {
      const rows = db
        .prepare(
          `SELECT seq, project_key, kind, entity_id, at FROM project_change_events
           WHERE project_key = ? AND seq > ? ORDER BY seq LIMIT ?`,
        )
        .all(projectKey, afterSeq, limit) as ChangeRow[];
      return rows.map((row) => ({
        seq: row.seq,
        projectKey: row.project_key,
        kind: row.kind,
        entityId: row.entity_id,
        at: row.at,
      }));
    },
    /** Every project key (an entry of the instance, such as the default engine, belongs to all of them). */
    projectKeys(): string[] {
      return (db.prepare('SELECT key FROM projects ORDER BY key').all() as { key: string }[]).map(
        (row) => row.key,
      );
    },
    /** The projects that have a session on the engine (the stored `sessions.engine_id`). */
    projectKeysOnEngine(engineId: string): string[] {
      return (
        db
          .prepare('SELECT DISTINCT project_key FROM sessions WHERE engine_id = ? ORDER BY project_key')
          .all(engineId) as { project_key: string }[]
      ).map((row) => row.project_key);
    },
    /** The sequence number of the newest entry of any project, 0 when the journal is empty. */
    latestSeq(): number {
      const row = db.prepare('SELECT MAX(seq) AS seq FROM project_change_events').get() as {
        seq: number | null;
      };
      return row.seq ?? 0;
    },
    /** The sequence number of the project's newest entry, 0 when it has none. */
    head(projectKey: string): number {
      const row = db
        .prepare('SELECT MAX(seq) AS seq FROM project_change_events WHERE project_key = ?')
        .get(projectKey) as { seq: number | null };
      return row.seq ?? 0;
    },
  };
}
