import type {
  AgentProvider,
  HandoffFallbackReason,
  HandoffReason,
  HandoffStep,
  HandoffSummary,
} from '@projectman/shared';
import type { Db } from './database';

/** The handoff of a card's assignee (PM-342): open while `outcome` is null, kept as history after. */
export interface TaskHandoffRow {
  id: string;
  projectKey: string;
  taskKey: string;
  from: string;
  /** The receiver; null: the card went to nobody. */
  to: string | null;
  fromProvider: AgentProvider;
  toProvider: AgentProvider | null;
  /** The old member's session on the card when the handoff began; null: none. */
  fromSessionId: string | null;
  reason: HandoffReason;
  step: HandoffStep;
  startedAt: string;
  /** Null while it is paused or closing. */
  deadlineAt: string | null;
  /** Null while open. */
  outcome: 'note' | 'fallback' | 'cancelled' | null;
  fallbackReason: HandoffFallbackReason | null;
  note: string | null;
  branch: string | null;
  lastCommit: string | null;
  uncommitted: boolean | null;
  summary: HandoffSummary | null;
  /** The note was recorded or the fallback decided; the old session may still be closing. */
  closingAt: string | null;
  endedAt: string | null;
  takenOverAt: string | null;
  takenOverSessionId: string | null;
}

interface HandoffDbRow {
  id: string;
  project_key: string;
  task_key: string;
  from_member: string;
  to_member: string | null;
  from_provider: AgentProvider;
  to_provider: AgentProvider | null;
  from_session_id: string | null;
  reason: HandoffReason;
  step: HandoffStep;
  started_at: string;
  deadline_at: string | null;
  outcome: TaskHandoffRow['outcome'];
  fallback_reason: HandoffFallbackReason | null;
  note: string | null;
  branch: string | null;
  last_commit: string | null;
  uncommitted: number | null;
  summary_source: HandoffSummary['source'] | null;
  summary_text: string | null;
  summary_at: string | null;
  closing_at: string | null;
  ended_at: string | null;
  taken_over_at: string | null;
  taken_over_session_id: string | null;
}

const toRow = (row: HandoffDbRow): TaskHandoffRow => ({
  id: row.id,
  projectKey: row.project_key,
  taskKey: row.task_key,
  from: row.from_member,
  to: row.to_member,
  fromProvider: row.from_provider,
  toProvider: row.to_provider,
  fromSessionId: row.from_session_id,
  reason: row.reason,
  step: row.step,
  startedAt: row.started_at,
  deadlineAt: row.deadline_at,
  outcome: row.outcome,
  fallbackReason: row.fallback_reason,
  note: row.note,
  branch: row.branch,
  lastCommit: row.last_commit,
  uncommitted: row.uncommitted === null ? null : row.uncommitted !== 0,
  summary:
    row.summary_source && row.summary_text !== null
      ? { source: row.summary_source, text: row.summary_text, at: row.summary_at }
      : null,
  closingAt: row.closing_at,
  endedAt: row.ended_at,
  takenOverAt: row.taken_over_at,
  takenOverSessionId: row.taken_over_session_id,
});

const toParams = (row: TaskHandoffRow) => ({
  id: row.id,
  projectKey: row.projectKey,
  taskKey: row.taskKey,
  from: row.from,
  to: row.to,
  fromProvider: row.fromProvider,
  toProvider: row.toProvider,
  fromSessionId: row.fromSessionId,
  reason: row.reason,
  step: row.step,
  startedAt: row.startedAt,
  deadlineAt: row.deadlineAt,
  outcome: row.outcome,
  fallbackReason: row.fallbackReason,
  note: row.note,
  branch: row.branch,
  lastCommit: row.lastCommit,
  uncommitted: row.uncommitted === null ? null : row.uncommitted ? 1 : 0,
  summarySource: row.summary?.source ?? null,
  summaryText: row.summary?.text ?? null,
  summaryAt: row.summary?.at ?? null,
  closingAt: row.closingAt,
  endedAt: row.endedAt,
  takenOverAt: row.takenOverAt,
  takenOverSessionId: row.takenOverSessionId,
});

/** The handoffs of cards: at most one open per card (a unique index), the closed ones kept as history. */
export function createTaskHandoffRepository(db: Db) {
  const insert = db.prepare(
    `INSERT INTO task_handoffs (id, project_key, task_key, from_member, to_member, from_provider, to_provider,
       from_session_id, reason, step, started_at, deadline_at, outcome, fallback_reason, note, branch, last_commit,
       uncommitted, summary_source, summary_text, summary_at, closing_at, ended_at, taken_over_at,
       taken_over_session_id)
     VALUES (@id, @projectKey, @taskKey, @from, @to, @fromProvider, @toProvider,
       @fromSessionId, @reason, @step, @startedAt, @deadlineAt, @outcome, @fallbackReason, @note, @branch, @lastCommit,
       @uncommitted, @summarySource, @summaryText, @summaryAt, @closingAt, @endedAt, @takenOverAt,
       @takenOverSessionId)`,
  );
  const update = db.prepare(
    `UPDATE task_handoffs SET to_member = @to, to_provider = @toProvider, step = @step, deadline_at = @deadlineAt,
       outcome = @outcome, fallback_reason = @fallbackReason, note = @note, branch = @branch,
       last_commit = @lastCommit, uncommitted = @uncommitted, summary_source = @summarySource,
       summary_text = @summaryText, summary_at = @summaryAt, closing_at = @closingAt, ended_at = @endedAt,
       taken_over_at = @takenOverAt, taken_over_session_id = @takenOverSessionId
     WHERE id = @id`,
  );
  const byId = db.prepare('SELECT * FROM task_handoffs WHERE id = ?');
  const openOfTask = db.prepare('SELECT * FROM task_handoffs WHERE task_key = ? AND outcome IS NULL');
  const allOpen = db.prepare('SELECT * FROM task_handoffs WHERE outcome IS NULL ORDER BY started_at');
  const openOfProject = db.prepare(
    'SELECT * FROM task_handoffs WHERE project_key = ? AND outcome IS NULL ORDER BY started_at',
  );
  const latestClosedOfTask = db.prepare(
    `SELECT * FROM task_handoffs WHERE task_key = ? AND outcome IN ('note', 'fallback')
     ORDER BY ended_at DESC, started_at DESC LIMIT 1`,
  );
  const latestNoteOfTask = db.prepare(
    `SELECT * FROM task_handoffs WHERE task_key = ? AND outcome = 'note'
     ORDER BY ended_at DESC, started_at DESC LIMIT 1`,
  );
  const untakenFor = db.prepare(
    `SELECT * FROM task_handoffs WHERE task_key = ? AND to_member = ? AND outcome IN ('note', 'fallback')
       AND taken_over_at IS NULL
     ORDER BY ended_at DESC, started_at DESC LIMIT 1`,
  );

  const one = (row: unknown): TaskHandoffRow | null => (row ? toRow(row as HandoffDbRow) : null);

  return {
    get(id: string): TaskHandoffRow | null {
      return one(byId.get(id));
    },
    /** The handoff open on the card, or null. */
    open(taskKey: string): TaskHandoffRow | null {
      return one(openOfTask.get(taskKey));
    },
    /** Every open handoff, the oldest first; of one project when given. */
    listOpen(projectKey?: string): TaskHandoffRow[] {
      const rows = (projectKey ? openOfProject.all(projectKey) : allOpen.all()) as HandoffDbRow[];
      return rows.map(toRow);
    },
    /** The latest handoff of the card that ended with a note or the fallback. */
    latestClosed(taskKey: string): TaskHandoffRow | null {
      return one(latestClosedOfTask.get(taskKey));
    },
    /** The latest handoff note on the card. */
    latestNote(taskKey: string): TaskHandoffRow | null {
      return one(latestNoteOfTask.get(taskKey));
    },
    /** The latest closed handoff to `member` that no session of theirs has taken over yet. */
    untakenFor(taskKey: string, member: string): TaskHandoffRow | null {
      return one(untakenFor.get(taskKey, member));
    },
    create(row: TaskHandoffRow): void {
      insert.run(toParams(row));
    },
    save(row: TaskHandoffRow): void {
      update.run(toParams(row));
    },
  };
}
