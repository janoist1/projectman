import type { Db } from './database';
import { createTaskHandoverRepository } from './task-merges';

/** The commit handed over when a task entered a review or test stage (PM-183). */
export interface ReviewPinRecord {
  projectKey: string;
  taskKey: string;
  /** The stage the task entered with the hand-over. */
  stageId: string;
  commit: string;
  branch: string;
  pinnedAt: string;
  /** Handle of whoever moved the task, or a new round's requester. */
  pinnedBy: string;
}

interface PinRow {
  project_key: string;
  task_key: string;
  stage_id: string;
  commit_id: string;
  branch: string;
  pinned_at: string;
  pinned_by: string;
}

const toRecord = (row: PinRow): ReviewPinRecord => ({
  projectKey: row.project_key,
  taskKey: row.task_key,
  stageId: row.stage_id,
  commit: row.commit_id,
  branch: row.branch,
  pinnedAt: row.pinned_at,
  pinnedBy: row.pinned_by,
});

/** One review pin per task: the next hand-over replaces it, leaving the stage removes it. */
export function createReviewPinRepository(db: Db) {
  const find = db.prepare('SELECT * FROM task_review_pins WHERE task_key = ?');
  const all = db.prepare('SELECT * FROM task_review_pins ORDER BY pinned_at');
  const put = db.prepare(
    `INSERT INTO task_review_pins (project_key, task_key, stage_id, commit_id, branch, pinned_at, pinned_by)
     VALUES (@projectKey, @taskKey, @stageId, @commit, @branch, @pinnedAt, @pinnedBy)
     ON CONFLICT (task_key) DO UPDATE SET stage_id = excluded.stage_id, commit_id = excluded.commit_id,
       branch = excluded.branch, pinned_at = excluded.pinned_at, pinned_by = excluded.pinned_by`,
  );
  const remove = db.prepare('DELETE FROM task_review_pins WHERE task_key = ?');

  return {
    get(taskKey: string): ReviewPinRecord | null {
      const row = find.get(taskKey) as PinRow | undefined;
      return row ? toRecord(row) : null;
    },
    list(): ReviewPinRecord[] {
      return (all.all() as PinRow[]).map(toRecord);
    },
    save(pin: ReviewPinRecord): void {
      put.run(pin);
      createTaskHandoverRepository(db).save({ ...pin, at: pin.pinnedAt });
    },
    clear(taskKey: string): void {
      remove.run(taskKey);
    },
  };
}
