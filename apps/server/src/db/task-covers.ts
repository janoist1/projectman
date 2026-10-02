import type { Actor, TaskCoverChoice } from '@projectman/shared';
import type { Db } from './database';

/** A person's choice of a card's cover (PM-224); a card without a row has the automatic cover. */
export interface TaskCoverRecord {
  projectKey: string;
  taskKey: string;
  choice: TaskCoverChoice;
  setAt: string;
  setBy: Actor;
}

interface CoverRow {
  project_key: string;
  task_key: string;
  mode: string;
  attachment_id: string | null;
  set_at: string;
  set_by_kind: string;
  set_by_handle: string | null;
}

const toRecord = (row: CoverRow): TaskCoverRecord => ({
  projectKey: row.project_key,
  taskKey: row.task_key,
  choice:
    row.mode === 'pinned' && row.attachment_id
      ? { mode: 'pinned', attachmentId: row.attachment_id }
      : { mode: 'hidden' },
  setAt: row.set_at,
  setBy: { kind: row.set_by_kind as Actor['kind'], handle: row.set_by_handle },
});

/** One cover choice per task: the next choice replaces it, deleting the pinned file removes it. */
export function createTaskCoverRepository(db: Db) {
  const find = db.prepare('SELECT * FROM task_covers WHERE task_key = ?');
  const put = db.prepare(
    `INSERT INTO task_covers (project_key, task_key, mode, attachment_id, set_at, set_by_kind, set_by_handle)
     VALUES (@projectKey, @taskKey, @mode, @attachmentId, @setAt, @setByKind, @setByHandle)
     ON CONFLICT (task_key) DO UPDATE SET mode = excluded.mode, attachment_id = excluded.attachment_id,
       set_at = excluded.set_at, set_by_kind = excluded.set_by_kind, set_by_handle = excluded.set_by_handle`,
  );
  const removePinned = db.prepare(
    "DELETE FROM task_covers WHERE task_key = ? AND mode = 'pinned' AND attachment_id = ?",
  );

  return {
    get(taskKey: string): TaskCoverRecord | null {
      const row = find.get(taskKey) as CoverRow | undefined;
      return row ? toRecord(row) : null;
    },
    save(record: TaskCoverRecord): void {
      put.run({
        projectKey: record.projectKey,
        taskKey: record.taskKey,
        mode: record.choice.mode,
        attachmentId: record.choice.mode === 'pinned' ? record.choice.attachmentId : null,
        setAt: record.setAt,
        setByKind: record.setBy.kind,
        setByHandle: record.setBy.handle,
      });
    },
    /** Drops the choice when it pins this attachment (the file was deleted); a hidden cover stays. */
    clearPinned(taskKey: string, attachmentId: string): void {
      removePinned.run(taskKey, attachmentId);
    },
  };
}
