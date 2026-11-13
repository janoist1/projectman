import { BASELINE_VERSION } from './schema/baseline-0152';

/**
 * Versioned migrations after the frozen baseline. Each runs once in a transaction.
 * Never edit the baseline or a released migration: append a new migration instead.
 */
interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [];

migrations.push({
  version: 153,
  name: 'full test run command',
  // PM-1377: the command a full test run ran, so a merge reuses a pass only of the same command. Older rows stay
  // NULL and are never reused.
  sql: `ALTER TABLE full_test_runs ADD COLUMN command TEXT;`,
});
migrations.push({
  version: 154,
  name: 'task stage owner pick',
  // PM-1395: whom a step stage with a small-card rule gave the card to on entry (JSON `StageOwnerPick`); NULL:
  // the stage has no such rule. No old row needs a backfill: every card read before keeps the stage's owners.
  sql: `ALTER TABLE tasks ADD COLUMN stage_owner_pick TEXT;`,
});
migrations.push({
  version: 155,
  name: 'the review_follow_ups operator signal',
  // PM-1362: the non-blocking remarks a closed card still holds go to the project manager as one
  // `review_follow_ups` signal. operator_signals is rebuilt as in version 143 (the kind CHECK grows by
  // 'review_follow_ups'; every row and both indexes carry over unchanged).
  sql: `DROP INDEX operator_signals_open;
    DROP INDEX operator_signals_delivery;
    ALTER TABLE operator_signals RENAME TO operator_signals_old;
    CREATE TABLE operator_signals (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('outage','nobody','stalled','silent','idle','merge_waiting','merge_blocked','unreleased','ready_waiting','answer_stalled','process_cleanup_failed','refinement_stalled','loop_suspected','structural_pattern','milestone_closed','start_blocked','obligation_overdue','senior_wait','relation_check','review_follow_ups')), case_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','open','accepted','dismissed','resolved')),
      actionable INTEGER NOT NULL DEFAULT 0, task_key TEXT, subject TEXT, inbox_item_id TEXT, message_id TEXT,
      raised_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, resolved_at TEXT, delivered_at TEXT,
      follow_up_at TEXT, decision_note TEXT, delivered_to TEXT
    );
    INSERT INTO operator_signals (id, project_key, kind, case_key, state, actionable, task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at, follow_up_at, decision_note, delivered_to)
      SELECT id, project_key, kind, case_key, state, actionable, task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at, follow_up_at, decision_note, delivered_to FROM operator_signals_old ORDER BY rowid;
    DROP TABLE operator_signals_old;
    CREATE UNIQUE INDEX operator_signals_open ON operator_signals(project_key, case_key) WHERE resolved_at IS NULL;
    CREATE INDEX operator_signals_delivery ON operator_signals(project_key, kind, delivered_at);`,
});
export const LATEST_SCHEMA_VERSION = Math.max(BASELINE_VERSION, ...migrations.map((m) => m.version));
