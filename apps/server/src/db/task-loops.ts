import type { Db } from './database';
import { parseJson, toJson } from './json';

/** A loop found on a card (PM-261): AI members writing to each other without progress. */
export interface TaskLoopRecord {
  id: string;
  projectKey: string;
  taskKey: string;
  /** The first counted message (ISO time). */
  startedAt: string;
  /** When the loop was found. */
  raisedAt: string;
  /** The last counted message. */
  lastMessageAt: string;
  members: string[];
  /** Counted messages so far. */
  count: number;
  /** The member told first; null when nobody was. */
  notified: string | null;
  /** The count when that member was told: the loop is said to go on after as many messages again. */
  notifiedCount: number;
  phase: 'notified' | 'owner' | 'let_run';
  ownerReason: 'no_watcher' | 'continued' | null;
  /** The people a decision about it goes to. */
  deciders: string[];
  /** The inbox decision item of the loop, once there is one. */
  inboxItemId: string | null;
  /** The head of the card's branch when the loop was found; a different one later is progress. */
  headCommit: string | null;
  endedAt: string | null;
  endReason: string | null;
  letRunBy: string | null;
}

interface LoopRow {
  id: string;
  project_key: string;
  task_key: string;
  started_at: string;
  raised_at: string;
  last_message_at: string;
  members: string;
  count: number;
  notified: string | null;
  notified_count: number;
  phase: TaskLoopRecord['phase'];
  owner_reason: TaskLoopRecord['ownerReason'];
  deciders: string;
  inbox_item_id: string | null;
  head_commit: string | null;
  ended_at: string | null;
  end_reason: string | null;
  let_run_by: string | null;
}

const toRecord = (row: LoopRow): TaskLoopRecord => ({
  id: row.id,
  projectKey: row.project_key,
  taskKey: row.task_key,
  startedAt: row.started_at,
  raisedAt: row.raised_at,
  lastMessageAt: row.last_message_at,
  members: parseJson<string[]>(row.members, []),
  count: row.count,
  notified: row.notified,
  notifiedCount: row.notified_count,
  phase: row.phase,
  ownerReason: row.owner_reason,
  deciders: parseJson<string[]>(row.deciders, []),
  inboxItemId: row.inbox_item_id,
  headCommit: row.head_commit,
  endedAt: row.ended_at,
  endReason: row.end_reason,
  letRunBy: row.let_run_by,
});

/** The loops of cards: at most one open per card, the ended ones kept as history. */
export function createTaskLoopRepository(db: Db) {
  const insert = db.prepare(
    `INSERT INTO task_loops (id, project_key, task_key, started_at, raised_at, last_message_at, members, count,
       notified, notified_count, phase, owner_reason, deciders, inbox_item_id, head_commit)
     VALUES (@id, @projectKey, @taskKey, @startedAt, @raisedAt, @lastMessageAt, @members, @count,
       @notified, @notifiedCount, @phase, @ownerReason, @deciders, @inboxItemId, @headCommit)`,
  );
  const update = db.prepare(
    `UPDATE task_loops SET last_message_at = @lastMessageAt, members = @members, count = @count,
       phase = @phase, owner_reason = @ownerReason, deciders = @deciders, inbox_item_id = @inboxItemId,
       let_run_by = @letRunBy
     WHERE id = @id AND ended_at IS NULL`,
  );
  const end = db.prepare(
    'UPDATE task_loops SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL',
  );
  const byId = db.prepare('SELECT * FROM task_loops WHERE id = ?');
  const openOfTask = db.prepare('SELECT * FROM task_loops WHERE task_key = ? AND ended_at IS NULL');
  const lastEnded = db.prepare(
    'SELECT ended_at FROM task_loops WHERE task_key = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1',
  );
  const allOpen = db.prepare('SELECT * FROM task_loops WHERE ended_at IS NULL ORDER BY raised_at');
  const openOfProject = db.prepare(
    'SELECT * FROM task_loops WHERE project_key = ? AND ended_at IS NULL ORDER BY raised_at',
  );
  const byInboxItem = db.prepare('SELECT * FROM task_loops WHERE inbox_item_id = ?');

  const one = (row: unknown): TaskLoopRecord | null => (row ? toRecord(row as LoopRow) : null);

  return {
    /** The loop open on the card, or null. */
    open(taskKey: string): TaskLoopRecord | null {
      return one(openOfTask.get(taskKey));
    },
    get(id: string): TaskLoopRecord | null {
      return one(byId.get(id));
    },
    /** The loop whose decision item this is (open or ended), or null. */
    ofInboxItem(itemId: string): TaskLoopRecord | null {
      return one(byInboxItem.get(itemId));
    },
    /** Every open loop of every project, the oldest first. */
    listOpen(projectKey?: string): TaskLoopRecord[] {
      const rows = (projectKey ? openOfProject.all(projectKey) : allOpen.all()) as LoopRow[];
      return rows.map(toRecord);
    },
    /** When the card's latest loop ended (ISO time), or null when none has. */
    lastEndedAt(taskKey: string): string | null {
      return (lastEnded.get(taskKey) as { ended_at: string } | undefined)?.ended_at ?? null;
    },
    create(loop: Omit<TaskLoopRecord, 'endedAt' | 'endReason' | 'letRunBy'>): void {
      insert.run({ ...loop, members: toJson(loop.members), deciders: toJson(loop.deciders) });
    },
    save(loop: TaskLoopRecord): void {
      update.run({ ...loop, members: toJson(loop.members), deciders: toJson(loop.deciders) });
    },
    close(id: string, at: string, reason: string): void {
      end.run(at, reason, id);
    },
  };
}
