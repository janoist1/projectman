import type { TaskHandOn } from '@projectman/shared';
import type { Db } from './database';

type HandOnRecord = TaskHandOn & { projectKey: string; taskKey: string };

export function createTaskHandOnRepository(db: Db) {
  const columns = `project_key AS projectKey, task_key AS taskKey, from_stage_id AS fromStageId,
    to_stage_id AS toStageId, mover, requested_by AS requestedBy, requested_at AS requestedAt,
    inbox_item_id AS inboxItemId`;
  const find = db.prepare(`SELECT ${columns} FROM task_hand_ons WHERE project_key = ? AND task_key = ?`);
  const all = db.prepare(`SELECT ${columns} FROM task_hand_ons WHERE project_key = ?`);
  const put = db.prepare(`INSERT OR REPLACE INTO task_hand_ons
    (project_key, task_key, from_stage_id, to_stage_id, mover, requested_by, requested_at, inbox_item_id)
    VALUES (@projectKey, @taskKey, @fromStageId, @toStageId, @mover, @requestedBy, @requestedAt, @inboxItemId)`);
  const remove = db.prepare('DELETE FROM task_hand_ons WHERE project_key = ? AND task_key = ?');
  return {
    get(projectKey: string, taskKey: string): HandOnRecord | null {
      return (find.get(projectKey, taskKey) as HandOnRecord | undefined) ?? null;
    },
    list(projectKey: string): HandOnRecord[] {
      return all.all(projectKey) as HandOnRecord[];
    },
    save(record: HandOnRecord): void {
      put.run(record);
    },
    clear(projectKey: string, taskKey: string): void {
      remove.run(projectKey, taskKey);
    },
  };
}
