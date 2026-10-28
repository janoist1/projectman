import type { Obligation, ObligationKind, ObligationPauseReason, ObligationState } from '@projectman/shared';
import type { Db } from './database';

interface ObligationRow {
  id: string;
  project_key: string;
  task_key: string;
  kind: ObligationKind;
  responsible: string;
  subject: string;
  opened_at: string;
  due_at: string;
  paused_since: string | null;
  pause_reason: ObligationPauseReason | null;
  woken_at: string | null;
  handed_over_at: string | null;
  inbox_item_id: string | null;
  state: ObligationState;
  closed_at: string | null;
}

const toRecord = (row: ObligationRow): Obligation => ({
  id: row.id,
  projectKey: row.project_key,
  taskKey: row.task_key,
  kind: row.kind,
  responsible: row.responsible,
  subject: row.subject,
  openedAt: row.opened_at,
  dueAt: row.due_at,
  pausedSince: row.paused_since,
  pauseReason: row.pause_reason,
  wokenAt: row.woken_at,
  handedOverAt: row.handed_over_at,
  inboxItemId: row.inbox_item_id,
  state: row.state,
  closedAt: row.closed_at,
});

/** The fields of an obligation a step changes; the rest of the row is fixed when it opens. */
interface ObligationPatch {
  dueAt?: string;
  pausedSince?: string | null;
  pauseReason?: ObligationPauseReason | null;
  wokenAt?: string;
  handedOverAt?: string;
  inboxItemId?: string;
}

/**
 * The obligations (PM-806): open steps with a responsible and a deadline. The tuple (card, kind, responsible,
 * subject) is unique for ever, so a step that was once closed does not open again.
 */
export function createObligationRepository(db: Db) {
  const statements = {
    insert: db.prepare(
      `INSERT OR IGNORE INTO obligations (id, project_key, task_key, kind, responsible, subject, opened_at, due_at,
         state, updated_at)
       VALUES (@id, @projectKey, @taskKey, @kind, @responsible, @subject, @openedAt, @dueAt, 'open', @openedAt)`,
    ),
    byId: db.prepare('SELECT * FROM obligations WHERE id = ?'),
    byTuple: db.prepare(
      `SELECT * FROM obligations
       WHERE project_key = ? AND task_key = ? AND kind = ? AND responsible = ? AND subject = ?`,
    ),
    byInboxItem: db.prepare('SELECT * FROM obligations WHERE inbox_item_id = ?'),
    live: db.prepare(
      `SELECT * FROM obligations WHERE project_key = ? AND state IN ('open','handed_over') ORDER BY opened_at, rowid`,
    ),
    liveOfTask: db.prepare(
      `SELECT * FROM obligations WHERE project_key = ? AND task_key = ? AND state IN ('open','handed_over')
       ORDER BY opened_at, rowid`,
    ),
    patch: db.prepare(
      `UPDATE obligations SET
         due_at = COALESCE(@dueAt, due_at),
         paused_since = CASE WHEN @setPause THEN @pausedSince ELSE paused_since END,
         pause_reason = CASE WHEN @setPause THEN @pauseReason ELSE pause_reason END,
         woken_at = COALESCE(@wokenAt, woken_at),
         handed_over_at = COALESCE(@handedOverAt, handed_over_at),
         inbox_item_id = COALESCE(@inboxItemId, inbox_item_id),
         state = CASE WHEN @handedOverAt IS NOT NULL THEN 'handed_over' ELSE state END,
         updated_at = @at
       WHERE id = @id AND state IN ('open','handed_over')`,
    ),
    close: db.prepare(
      `UPDATE obligations SET state = @state, closed_at = @at, updated_at = @at
       WHERE id = @id AND state IN ('open','handed_over')`,
    ),
  };
  const one = (row: unknown): Obligation | null => (row ? toRecord(row as ObligationRow) : null);

  return {
    get(id: string): Obligation | null {
      return one(statements.byId.get(id));
    },
    /** The row of this exact step, closed or not. */
    find(
      projectKey: string,
      taskKey: string,
      kind: ObligationKind,
      responsible: string,
      subject: string,
    ): Obligation | null {
      return one(statements.byTuple.get(projectKey, taskKey, kind, responsible, subject));
    },
    /** The row whose integrator todo this is, or null. */
    ofInboxItem(itemId: string): Obligation | null {
      return one(statements.byInboxItem.get(itemId));
    },
    /** The open and handed-over rows of a project, or of one card of it; the oldest first. */
    listLive(projectKey: string, taskKey?: string): Obligation[] {
      const rows = (
        taskKey ? statements.liveOfTask.all(projectKey, taskKey) : statements.live.all(projectKey)
      ) as ObligationRow[];
      return rows.map(toRecord);
    },
    /** Inserts an open row; false when the tuple exists already (it opened before and may be closed). */
    insert(
      row: Pick<
        Obligation,
        'id' | 'projectKey' | 'taskKey' | 'kind' | 'responsible' | 'subject' | 'openedAt' | 'dueAt'
      >,
    ): boolean {
      return statements.insert.run(row).changes > 0;
    },
    update(id: string, patch: ObligationPatch, at: string): void {
      statements.patch.run({
        id,
        at,
        dueAt: patch.dueAt ?? null,
        setPause: 'pausedSince' in patch ? 1 : 0,
        pausedSince: patch.pausedSince ?? null,
        pauseReason: patch.pauseReason ?? null,
        wokenAt: patch.wokenAt ?? null,
        handedOverAt: patch.handedOverAt ?? null,
        inboxItemId: patch.inboxItemId ?? null,
      });
    },
    close(id: string, state: 'fulfilled' | 'cancelled', at: string): void {
      statements.close.run({ id, state, at });
    },
  };
}
