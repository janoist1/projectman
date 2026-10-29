import type { TaskHandOn } from '@projectman/shared';
import type { Db } from './database';

type HandOnRecord = TaskHandOn & { projectKey: string; taskKey: string };

export function createTaskHandOnRepository(db: Db) {
  const columns = `project_key AS projectKey, task_key AS taskKey, from_stage_id AS fromStageId,
    to_stage_id AS toStageId, mover, requested_by AS requestedBy, requested_at AS requestedAt,
    inbox_item_id AS inboxItemId`;
  const find = db.prepare(`SELECT ${columns} FROM task_hand_ons WHERE project_key = ? AND task_key = ?`);
  const many = db.prepare(
    `SELECT ${columns} FROM task_hand_ons WHERE task_key IN (SELECT value FROM json_each(?))`,
  );
  const all = db.prepare(`SELECT ${columns} FROM task_hand_ons WHERE project_key = ?`);
  const put = db.prepare(`INSERT OR REPLACE INTO task_hand_ons
    (project_key, task_key, from_stage_id, to_stage_id, mover, requested_by, requested_at, inbox_item_id)
    VALUES (@projectKey, @taskKey, @fromStageId, @toStageId, @mover, @requestedBy, @requestedAt, @inboxItemId)`);
  const remove = db.prepare('DELETE FROM task_hand_ons WHERE project_key = ? AND task_key = ?');
  return {
    get(projectKey: string, taskKey: string): HandOnRecord | null {
      return (find.get(projectKey, taskKey) as HandOnRecord | undefined) ?? null;
    },
    /** The hand-ons of many tasks in one read: task key → record, for the tasks that have one. */
    ofTasks(taskKeys: readonly string[]): Map<string, HandOnRecord> {
      const records = new Map<string, HandOnRecord>();
      if (taskKeys.length === 0) return records;
      for (const record of many.all(JSON.stringify(taskKeys)) as HandOnRecord[])
        records.set(record.taskKey, record);
      return records;
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
