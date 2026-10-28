import type { EngineId } from '@projectman/shared';
import type { Db } from './database';

export interface ProjectEngineRecord {
  project_key: string;
  engine_id: EngineId;
  is_default: number;
  added_by: string;
  added_at: string;
  /** `engines.revoked_at`: set when the engine was revoked. */
  revoked_at: string | null;
}

/** The project–engine bindings (PM-1060). A new default takes the old one off in the same transaction of the caller. */
export function createProjectEngineRepository(db: Db) {
  const select =
    'SELECT project_engines.*, engines.revoked_at AS revoked_at FROM project_engines JOIN engines ON engines.id = project_engines.engine_id';
  return {
    get(projectKey: string, engineId: string): ProjectEngineRecord | null {
      return (
        (db.prepare(`${select} WHERE project_key = ? AND engine_id = ?`).get(projectKey, engineId) as
          ProjectEngineRecord | undefined) ?? null
      );
    },
    /** The project's bindings in the order they were made. */
    list(projectKey: string): ProjectEngineRecord[] {
      return db
        .prepare(`${select} WHERE project_key = ? ORDER BY project_engines.rowid`)
        .all(projectKey) as ProjectEngineRecord[];
    },
    /** The projects bound to the engine. */
    projectKeysOf(engineId: string): string[] {
      return (
        db
          .prepare('SELECT project_key FROM project_engines WHERE engine_id = ? ORDER BY project_key')
          .all(engineId) as { project_key: string }[]
      ).map((row) => row.project_key);
    },
    insert(input: { projectKey: string; engineId: string; addedBy: string; at: string }): void {
      db.prepare(
        'INSERT INTO project_engines (project_key, engine_id, is_default, added_by, added_at) VALUES (?, ?, 0, ?, ?)',
      ).run(input.projectKey, input.engineId, input.addedBy, input.at);
    },
    /** Makes the binding the project's default and takes the previous default off. */
    setDefault(projectKey: string, engineId: string): void {
      db.prepare('UPDATE project_engines SET is_default = 0 WHERE project_key = ? AND is_default = 1').run(
        projectKey,
      );
      db.prepare('UPDATE project_engines SET is_default = 1 WHERE project_key = ? AND engine_id = ?').run(
        projectKey,
        engineId,
      );
    },
    remove(projectKey: string, engineId: string): void {
      db.prepare('DELETE FROM project_engines WHERE project_key = ? AND engine_id = ?').run(
        projectKey,
        engineId,
      );
    },
    /** The project has a session on the engine that is not closed (`exited` / `failed`). */
    hasOpenSession(projectKey: string, engineId: string): boolean {
      return !!db
        .prepare(
          "SELECT 1 FROM sessions WHERE project_key = ? AND engine_id = ? AND state NOT IN ('exited', 'failed') LIMIT 1",
        )
        .get(projectKey, engineId);
    },
  };
}
