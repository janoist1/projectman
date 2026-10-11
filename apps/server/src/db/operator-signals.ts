import type { OperatorSignal } from '@projectman/shared';
import type { Db } from './database';

export interface OperatorSignalRecord extends OperatorSignal {
  projectKey: string;
  caseKey: string;
  deliveredAt: string | null;
}
const columns = `id, project_key AS projectKey, case_key AS caseKey, kind, state, actionable,
  task_key AS taskKey, subject, inbox_item_id AS inboxItemId, message_id AS messageId,
  raised_at AS raisedAt, decided_by AS decidedBy, decided_at AS decidedAt, resolved_at AS resolvedAt, delivered_at AS deliveredAt`;
type Row = Omit<OperatorSignalRecord, 'actionable'> & { actionable: number };
const record = (row: Row): OperatorSignalRecord => ({ ...row, actionable: !!row.actionable });

export function createOperatorSignalRepository(db: Db) {
  const openByCase = db.prepare(`SELECT ${columns} FROM operator_signals
    WHERE project_key = ? AND case_key = ? AND resolved_at IS NULL`);
  return {
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
        task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at)
        VALUES (@id, @projectKey, @caseKey, @kind, @state, @actionable, @taskKey, @subject,
        @inboxItemId, @messageId, @raisedAt, @decidedBy, @decidedAt, @resolvedAt, @deliveredAt)`,
      ).run({ ...signal, actionable: Number(signal.actionable) });
    },
    save(signal: OperatorSignalRecord): void {
      db.prepare(
        `UPDATE operator_signals SET state = @state, actionable = @actionable,
        message_id = @messageId, decided_by = @decidedBy, decided_at = @decidedAt,
        resolved_at = @resolvedAt, delivered_at = @deliveredAt WHERE id = @id`,
      ).run({ ...signal, actionable: Number(signal.actionable) });
    },
    delivered(ids: string[], at: string): void {
      const statement = db.prepare(
        "UPDATE operator_signals SET delivered_at = ? WHERE id = ? AND state = 'pending' AND delivered_at IS NULL",
      );
      for (const id of ids) statement.run(at, id);
    },
  };
}
