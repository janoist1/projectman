import type { Db } from './database';

export type SeniorWaitDecision = 'wait' | 'any';
export type SeniorWaitEndReason = 'senior' | 'assigned' | 'moved' | 'closed' | 'level_changed' | 'no_senior';

/** The wait of a card recommended for the Senior (PM-348), with the question asked about it. */
export interface SeniorWaitRecord {
  id: string;
  projectKey: string;
  taskKey: string;
  /** When the card began to wait for a Senior (ISO time). */
  since: string;
  /** The owners' decision item, once the question was asked. */
  inboxItemId: string | null;
  /** When the question was asked (also set when nobody could be asked). */
  askedAt: string | null;
  decision: SeniorWaitDecision | null;
  decidedBy: string | null;
  decidedAt: string | null;
  endedAt: string | null;
  endReason: SeniorWaitEndReason | null;
}

interface SeniorWaitRow {
  id: string;
  project_key: string;
  task_key: string;
  since: string;
  inbox_item_id: string | null;
  asked_at: string | null;
  decision: SeniorWaitDecision | null;
  decided_by: string | null;
  decided_at: string | null;
  ended_at: string | null;
  end_reason: SeniorWaitEndReason | null;
}

const toRecord = (row: SeniorWaitRow): SeniorWaitRecord => ({
  id: row.id,
  projectKey: row.project_key,
  taskKey: row.task_key,
  since: row.since,
  inboxItemId: row.inbox_item_id,
  askedAt: row.asked_at,
  decision: row.decision,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  endedAt: row.ended_at,
  endReason: row.end_reason,
});

/** The Senior waits of cards: at most one open per card, the ended ones kept as history. */
export function createSeniorWaitRepository(db: Db) {
  const statements = {
    insert: db.prepare(
      'INSERT INTO senior_waits (id, project_key, task_key, since) VALUES (@id, @projectKey, @taskKey, @since)',
    ),
    byId: db.prepare('SELECT * FROM senior_waits WHERE id = ?'),
    openOfTask: db.prepare(
      'SELECT * FROM senior_waits WHERE project_key = ? AND task_key = ? AND ended_at IS NULL',
    ),
    allOpen: db.prepare('SELECT * FROM senior_waits WHERE ended_at IS NULL ORDER BY since, rowid'),
    openOfProject: db.prepare(
      'SELECT * FROM senior_waits WHERE project_key = ? AND ended_at IS NULL ORDER BY since, rowid',
    ),
    byInboxItem: db.prepare('SELECT * FROM senior_waits WHERE inbox_item_id = ?'),
    asked: db.prepare(
      'UPDATE senior_waits SET asked_at = ?, inbox_item_id = ? WHERE id = ? AND ended_at IS NULL',
    ),
    decide: db.prepare(
      'UPDATE senior_waits SET decision = ?, decided_by = ?, decided_at = ? WHERE id = ? AND ended_at IS NULL',
    ),
    end: db.prepare('UPDATE senior_waits SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL'),
  };
  const one = (row: unknown): SeniorWaitRecord | null => (row ? toRecord(row as SeniorWaitRow) : null);

  return {
    /** The wait open on the card, or null. */
    open(projectKey: string, taskKey: string): SeniorWaitRecord | null {
      return one(statements.openOfTask.get(projectKey, taskKey));
    },
    get(id: string): SeniorWaitRecord | null {
      return one(statements.byId.get(id));
    },
    /** The wait whose question this is (open or ended), or null. */
    ofInboxItem(itemId: string): SeniorWaitRecord | null {
      return one(statements.byInboxItem.get(itemId));
    },
    /** Every open wait, the oldest first; of one project when `projectKey` is given. */
    listOpen(projectKey?: string): SeniorWaitRecord[] {
      const rows = (
        projectKey ? statements.openOfProject.all(projectKey) : statements.allOpen.all()
      ) as SeniorWaitRow[];
      return rows.map(toRecord);
    },
    create(wait: Pick<SeniorWaitRecord, 'id' | 'projectKey' | 'taskKey' | 'since'>): void {
      statements.insert.run(wait);
    },
    /** The question went to the owners (`inboxItemId` null: there was nobody to ask). */
    markAsked(id: string, at: string, inboxItemId: string | null): void {
      statements.asked.run(at, inboxItemId, id);
    },
    decide(id: string, decision: SeniorWaitDecision, by: string, at: string): void {
      statements.decide.run(decision, by, at, id);
    },
    close(id: string, at: string, reason: SeniorWaitEndReason): void {
      statements.end.run(at, reason, id);
    },
  };
}
