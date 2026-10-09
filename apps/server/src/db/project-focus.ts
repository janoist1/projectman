import type { Actor, ProjectFocusItem } from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

interface FocusRow {
  task_key: string;
  added_at: string;
  added_by: string;
}

const SYSTEM: Actor = { kind: 'system', handle: null };

const toItem = (row: FocusRow): ProjectFocusItem => ({
  key: row.task_key,
  addedAt: row.added_at,
  addedBy: parseJson<Actor>(row.added_by, SYSTEM),
});

/** The project's focus list (PM-427): one ordered list per project; a write replaces the whole list. */
export function createProjectFocusRepository(db: Db) {
  const list = db.prepare(
    'SELECT task_key, added_at, added_by FROM project_focus_items WHERE project_key = ? ORDER BY position',
  );
  const clear = db.prepare('DELETE FROM project_focus_items WHERE project_key = ?');
  const insert = db.prepare(
    `INSERT INTO project_focus_items (project_key, position, task_key, added_at, added_by)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const replace = db.transaction((projectKey: string, items: readonly ProjectFocusItem[]) => {
    clear.run(projectKey);
    items.forEach((item, index) =>
      insert.run(projectKey, index + 1, item.key, item.addedAt, toJson(item.addedBy)),
    );
  });
  return {
    /** The items by place, first first. */
    list(projectKey: string): ProjectFocusItem[] {
      return (list.all(projectKey) as FocusRow[]).map(toItem);
    },
    /** Stores `items` as the whole list, in this order (the places are 1, 2, ...). */
    replace(projectKey: string, items: readonly ProjectFocusItem[]): void {
      replace(projectKey, items);
    },
  };
}
