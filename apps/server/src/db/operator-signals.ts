import type { OperatorSignal, OperatorSignalKind } from '@projectman/shared';
import type { Db } from './database';

export interface OperatorSignalRecord extends OperatorSignal {
  projectKey: string;
  decisionNote: string | null;
  caseKey: string;
  deliveredAt: string | null;
  /** When the signal is shown to the Operator again after an own step on it (PM-545); null: not scheduled. */
  followUpAt: string | null;
}
const columns = `id, project_key AS projectKey, case_key AS caseKey, kind, state, actionable,
  task_key AS taskKey, subject, inbox_item_id AS inboxItemId, message_id AS messageId,
  raised_at AS raisedAt, decided_by AS decidedBy, decided_at AS decidedAt, resolved_at AS resolvedAt,
  delivered_at AS deliveredAt, follow_up_at AS followUpAt, decision_note AS decisionNote`;
type Row = Omit<OperatorSignalRecord, 'actionable'> & { actionable: number };
const record = (row: Row): OperatorSignalRecord => ({ ...row, actionable: !!row.actionable });

export function createOperatorSignalRepository(db: Db) {
  const openByCase = db.prepare(`SELECT ${columns} FROM operator_signals
    WHERE project_key = ? AND case_key = ? AND resolved_at IS NULL`);
  return {
    latestDismissed(projectKey: string, kind: OperatorSignalKind): OperatorSignalRecord | null {
      const row = db
        .prepare(
          `SELECT ${columns} FROM operator_signals
        WHERE project_key = ? AND kind = ? AND state = 'dismissed'
        ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
        )
        .get(projectKey, kind) as Row | undefined;
      return row ? record(row) : null;
    },
    openByCase(projectKey: string, caseKey: string): OperatorSignalRecord | null {
      const row = openByCase.get(projectKey, caseKey) as Row | undefined;
      return row ? record(row) : null;
    },
    get(id: string): OperatorSignalRecord | null {
      const row = db.prepare(`SELECT ${columns} FROM operator_signals WHERE id = ?`).get(id) as
        Row | undefined;
      return row ? record(row) : null;
    },
    list(projectKey: string): OperatorSignalRecord[] {
      return (
        db
          .prepare(`SELECT ${columns} FROM operator_signals WHERE project_key = ? ORDER BY raised_at, rowid`)
          .all(projectKey) as Row[]
      ).map(record);
    },
    insert(signal: OperatorSignalRecord): void {
      db.prepare(
        `INSERT INTO operator_signals (id, project_key, case_key, kind, state, actionable,
        task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at, follow_up_at, decision_note)
        VALUES (@id, @projectKey, @caseKey, @kind, @state, @actionable, @taskKey, @subject,
        @inboxItemId, @messageId, @raisedAt, @decidedBy, @decidedAt, @resolvedAt, @deliveredAt, @followUpAt, @decisionNote)`,
      ).run({ ...signal, actionable: Number(signal.actionable) });
    },
    save(signal: OperatorSignalRecord): void {
      db.prepare(
        `UPDATE operator_signals SET state = @state, actionable = @actionable,
        message_id = @messageId, decided_by = @decidedBy, decided_at = @decidedAt, decision_note = @decisionNote,
        resolved_at = @resolvedAt, delivered_at = @deliveredAt, follow_up_at = @followUpAt WHERE id = @id`,
      ).run({ ...signal, actionable: Number(signal.actionable) });
    },
    /** Schedules the signal to be shown again at `at`, unless it is closed. */
    followUp(id: string, at: string): void {
      db.prepare('UPDATE operator_signals SET follow_up_at = ? WHERE id = ? AND resolved_at IS NULL').run(
        at,
        id,
      );
    },
    /** Shows signals to the Operator again: back to pending, unpresented, the follow-up used up. */
    redelivered(ids: string[], at: string): void {
      const statement = db.prepare(
        `UPDATE operator_signals SET state = 'pending', message_id = NULL, actionable = 0, delivered_at = ?,
         follow_up_at = NULL WHERE id = ? AND resolved_at IS NULL AND state IN ('pending', 'open')`,
      );
      for (const id of ids) statement.run(at, id);
    },
    delivered(ids: string[], at: string): void {
      const statement = db.prepare(
        "UPDATE operator_signals SET delivered_at = ? WHERE id = ? AND state = 'pending' AND delivered_at IS NULL",
      );
      for (const id of ids) statement.run(at, id);
    },
  };
}
