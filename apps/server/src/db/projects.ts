import type { Db } from './database';

export interface ProjectRecord {
  key: string;
  name: string;
  templateId: string | null;
  configVersion: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  key: string;
  name: string;
  template_id: string | null;
  config_version: string;
  created_at: string;
  updated_at: string;
}

const toProject = (r: ProjectRow): ProjectRecord => ({
  key: r.key,
  name: r.name,
  templateId: r.template_id,
  configVersion: r.config_version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createProjectRepository(db: Db) {
  const statements = {
    list: db.prepare('SELECT * FROM projects ORDER BY key'),
    get: db.prepare('SELECT * FROM projects WHERE key = ?'),
    insert: db.prepare(
      `INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    update: db.prepare('UPDATE projects SET name = ?, config_version = ?, updated_at = ? WHERE key = ?'),
  };
  return {
    list(): ProjectRecord[] {
      return (statements.list.all() as ProjectRow[]).map(toProject);
    },
    get(key: string): ProjectRecord | null {
      const row = statements.get.get(key) as ProjectRow | undefined;
      return row ? toProject(row) : null;
    },
    insert(p: ProjectRecord): void {
      statements.insert.run(p.key, p.name, p.templateId, p.configVersion, p.createdAt, p.updatedAt);
    },
    update(key: string, patch: { name: string; configVersion: string; updatedAt: string }): void {
      statements.update.run(patch.name, patch.configVersion, patch.updatedAt, key);
    },
  };
}

/** Per-project sequences (e.g. the task key number). */
export function createCounterRepository(db: Db) {
  const next = db.prepare(
    `INSERT INTO counters (project_key, name, value) VALUES (?, ?, 1)
     ON CONFLICT (project_key, name) DO UPDATE SET value = value + 1
     RETURNING value`,
  );
  return {
    /** Atomically increments and returns the next value (starting at 1). */
    next(projectKey: string, name: string): number {
      return (next.get(projectKey, name) as { value: number }).value;
    },
  };
}
