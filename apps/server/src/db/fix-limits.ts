import type { Db } from './database';
import { parseJson, toJson } from './json';

/** The fix round limit of a card (PM-262): where its count began, the rounds allowed on top, and the hold. */
export interface TaskFixLimitRecord {
  taskKey: string;
  projectKey: string;
  /** The count begins after this time (ISO); null: at the start of the card. */
  countedFrom: string | null;
  /** The rounds people allowed on top of the limit since the count began. */
  extraRounds: number;
  /** Set while the card is held back; null when it is not. */
  holdPhase: 'lead' | 'replan' | 'owner' | null;
  heldAt: string | null;
  /** The AI member who decides (`lead`, `replan`). */
  decider: string | null;
  /** The people who decide (`owner`). */
  deciders: string[];
  reason: 'no_ai_decider' | 'passed_on' | 'again' | null;
  /** The decision item of the hold, once there is one. */
  inboxItemId: string | null;
}

interface FixLimitRow {
  task_key: string;
  project_key: string;
  counted_from: string | null;
  extra_rounds: number;
  hold_phase: TaskFixLimitRecord['holdPhase'];
  held_at: string | null;
  decider: string | null;
  deciders: string;
  reason: TaskFixLimitRecord['reason'];
  inbox_item_id: string | null;
}

const toRecord = (row: FixLimitRow): TaskFixLimitRecord => ({
  taskKey: row.task_key,
  projectKey: row.project_key,
  countedFrom: row.counted_from,
  extraRounds: row.extra_rounds,
  holdPhase: row.hold_phase,
  heldAt: row.held_at,
  decider: row.decider,
  deciders: parseJson<string[]>(row.deciders, []),
  reason: row.reason,
  inboxItemId: row.inbox_item_id,
});

/** The fix round limit state of cards: one row per card, made when the card first needs one. */
export function createTaskFixLimitRepository(db: Db) {
  const upsert = db.prepare(
    `INSERT INTO task_fix_limits (task_key, project_key, counted_from, extra_rounds, hold_phase, held_at,
       decider, deciders, reason, inbox_item_id)
     VALUES (@taskKey, @projectKey, @countedFrom, @extraRounds, @holdPhase, @heldAt,
       @decider, @deciders, @reason, @inboxItemId)
     ON CONFLICT(task_key) DO UPDATE SET counted_from = excluded.counted_from,
       extra_rounds = excluded.extra_rounds, hold_phase = excluded.hold_phase, held_at = excluded.held_at,
       decider = excluded.decider, deciders = excluded.deciders, reason = excluded.reason,
       inbox_item_id = excluded.inbox_item_id`,
  );
  const byTask = db.prepare('SELECT * FROM task_fix_limits WHERE task_key = ?');
  const allHeld = db.prepare('SELECT * FROM task_fix_limits WHERE hold_phase IS NOT NULL ORDER BY held_at');
  const heldOfProject = db.prepare(
    'SELECT * FROM task_fix_limits WHERE project_key = ? AND hold_phase IS NOT NULL ORDER BY held_at',
  );
  const byInboxItem = db.prepare('SELECT * FROM task_fix_limits WHERE inbox_item_id = ?');

  const one = (row: unknown): TaskFixLimitRecord | null => (row ? toRecord(row as FixLimitRow) : null);

  return {
    get(taskKey: string): TaskFixLimitRecord | null {
      return one(byTask.get(taskKey));
    },
    /** The state whose decision item this is (held or not any more), or null. */
    ofInboxItem(itemId: string): TaskFixLimitRecord | null {
      return one(byInboxItem.get(itemId));
    },
    /** The cards that are held back, the longest held first. */
    listHeld(projectKey?: string): TaskFixLimitRecord[] {
      const rows = (projectKey ? heldOfProject.all(projectKey) : allHeld.all()) as FixLimitRow[];
      return rows.map(toRecord);
    },
    save(record: TaskFixLimitRecord): void {
      upsert.run({ ...record, deciders: toJson(record.deciders) });
    },
  };
}
