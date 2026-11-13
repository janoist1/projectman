-- PM-1384: the retired release and Operator approval inbox items become plain `alert` items (an alert whose payload
  -- has no known `alert` name shows as an unknown alert with its title; nothing can decide it any more), and the
  -- signals of the kinds that nothing raises since PM-1152 and PM-1226 (idle, merge_waiting, ready_waiting,
  -- refinement_stalled, nobody) are deleted. operator_signals is rebuilt as in version 155 with the narrower
  -- kind CHECK; every other row and both indexes carry over unchanged.
UPDATE inbox_items SET state = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE state IN ('open', 'screening')
    AND (kind = 'release' OR (kind = 'approval' AND json_type(payload, '$.operator') IS NOT NULL));
-- The retired Operator's own pending items (asked by it, or from one of its sessions) were refused to every
  -- delegated decider by a special case that is deleted with this version; closing them keeps that protection.
UPDATE inbox_items SET state = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE state IN ('open', 'screening')
    AND (source = 'operator'
      OR session_id IN (SELECT id FROM sessions WHERE member = 'operator'));
UPDATE inbox_items SET kind = 'alert', payload = json_remove(payload, '$.release', '$.operator')
  WHERE kind = 'release' OR (kind = 'approval' AND json_type(payload, '$.operator') IS NOT NULL);
DELETE FROM operator_signals WHERE kind IN ('idle', 'merge_waiting', 'ready_waiting', 'refinement_stalled', 'nobody');
DROP INDEX operator_signals_open;
    DROP INDEX operator_signals_delivery;
    ALTER TABLE operator_signals RENAME TO operator_signals_old;
    CREATE TABLE operator_signals (
      id TEXT PRIMARY KEY, project_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('outage','stalled','silent','merge_blocked','unreleased','answer_stalled','process_cleanup_failed','loop_suspected','structural_pattern','milestone_closed','start_blocked','obligation_overdue','senior_wait','relation_check','review_follow_ups')), case_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','open','accepted','dismissed','resolved')),
      actionable INTEGER NOT NULL DEFAULT 0, task_key TEXT, subject TEXT, inbox_item_id TEXT, message_id TEXT,
      raised_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, resolved_at TEXT, delivered_at TEXT,
      follow_up_at TEXT, decision_note TEXT, delivered_to TEXT
    );
    INSERT INTO operator_signals (id, project_key, kind, case_key, state, actionable, task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at, follow_up_at, decision_note, delivered_to)
      SELECT id, project_key, kind, case_key, state, actionable, task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at, delivered_at, follow_up_at, decision_note, delivered_to FROM operator_signals_old ORDER BY rowid;
    DROP TABLE operator_signals_old;
    CREATE UNIQUE INDEX operator_signals_open ON operator_signals(project_key, case_key) WHERE resolved_at IS NULL;
    CREATE INDEX operator_signals_delivery ON operator_signals(project_key, kind, delivered_at);
