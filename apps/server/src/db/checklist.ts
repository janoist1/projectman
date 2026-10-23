import { ChecklistItem } from '@projectman/shared';
import type { Db } from './database';

export function createChecklistRepository(db: Db) {
  return {
    get(projectKey: string) {
      const row = db
        .prepare('SELECT base_template_id FROM project_checklists WHERE project_key = ?')
        .get(projectKey) as { base_template_id: string | null } | undefined;
      if (!row) return null;
      const rows = db
        .prepare(
          `SELECT id, title, hint, source, template_id AS templateId, condition, state, reason, reopened, updated_at AS updatedAt, updated_by AS updatedBy FROM project_checklist_items WHERE project_key = ? ORDER BY position`,
        )
        .all(projectKey);
      return {
        baseTemplateId: row.base_template_id,
        items: rows.map((row) => ChecklistItem.parse({ ...(row as object), conditionHolds: null })),
      };
    },
    create(projectKey: string, baseTemplateId: string | null, at: string) {
      db.prepare(
        'INSERT INTO project_checklists (project_key, base_template_id, created_at) VALUES (?, ?, ?)',
      ).run(projectKey, baseTemplateId, at);
    },
    put(projectKey: string, item: ChecklistItem, position: number) {
      db.prepare(
        `INSERT INTO project_checklist_items (project_key, id, position, title, hint, source, template_id, condition, state, reason, reopened, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_key, id) DO UPDATE SET title=excluded.title, hint=excluded.hint, source=excluded.source, template_id=excluded.template_id, condition=excluded.condition, state=excluded.state, reason=excluded.reason, reopened=excluded.reopened, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      ).run(
        projectKey,
        item.id,
        position,
        item.title,
        item.hint,
        item.source,
        item.templateId,
        item.condition,
        item.state,
        item.reason,
        item.reopened,
        item.updatedAt,
        item.updatedBy,
      );
    },
  };
}
