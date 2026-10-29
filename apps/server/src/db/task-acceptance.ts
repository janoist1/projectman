import type { AcceptanceItem } from '@projectman/shared';
import type { Db } from './database';

interface AcceptanceRow {
  id: string;
  position: number;
  text: string;
  state: AcceptanceItem['state'];
  evidence: string | null;
  reason: string | null;
  moved_to: string | null;
  origin_task: string | null;
  origin_item: string | null;
  marked_by: string | null;
  marked_at: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const toItem = (row: AcceptanceRow): AcceptanceItem => ({
  id: row.id,
  position: row.position,
  text: row.text,
  state: row.state,
  evidence: row.evidence,
  reason: row.reason,
  movedTo: row.moved_to,
  origin: row.origin_task && row.origin_item ? { taskKey: row.origin_task, itemId: row.origin_item } : null,
  markedBy: row.marked_by,
  markedAt: row.marked_at,
  confirmedBy: row.confirmed_by,
  confirmedAt: row.confirmed_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The acceptance items of cards (PM-1135): the rows go with their card (cascade). */
export function createTaskAcceptanceRepository(db: Db) {
  const list = db.prepare('SELECT * FROM task_acceptance_items WHERE task_id = ? ORDER BY position, id');
  const put = db.prepare(
    `INSERT INTO task_acceptance_items (id, task_id, position, text, state, evidence, reason, moved_to,
       origin_task, origin_item, marked_by, marked_at, confirmed_by, confirmed_at, created_by, created_at, updated_at)
     VALUES (@id, @taskId, @position, @text, @state, @evidence, @reason, @movedTo, @originTask, @originItem,
       @markedBy, @markedAt, @confirmedBy, @confirmedAt, @createdBy, @createdAt, @updatedAt)
     ON CONFLICT (id) DO UPDATE SET position = excluded.position, text = excluded.text, state = excluded.state,
       evidence = excluded.evidence, reason = excluded.reason, moved_to = excluded.moved_to,
       marked_by = excluded.marked_by, marked_at = excluded.marked_at, confirmed_by = excluded.confirmed_by,
       confirmed_at = excluded.confirmed_at, updated_at = excluded.updated_at`,
  );
  const drop = db.prepare('DELETE FROM task_acceptance_items WHERE id = ?');

  return {
    /** The items of the card (by its id), in order. */
    list(taskId: string): AcceptanceItem[] {
      return (list.all(taskId) as AcceptanceRow[]).map(toItem);
    },
    /** Inserts the item, or replaces the changeable fields of the stored one (the origin never changes). */
    save(taskId: string, item: AcceptanceItem): void {
      put.run({
        id: item.id,
        taskId,
        position: item.position,
        text: item.text,
        state: item.state,
        evidence: item.evidence,
        reason: item.reason,
        movedTo: item.movedTo,
        originTask: item.origin?.taskKey ?? null,
        originItem: item.origin?.itemId ?? null,
        markedBy: item.markedBy,
        markedAt: item.markedAt,
        confirmedBy: item.confirmedBy,
        confirmedAt: item.confirmedAt,
        createdBy: item.createdBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
    },
    remove(itemId: string): void {
      drop.run(itemId);
    },
  };
}
