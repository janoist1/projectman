import type { ConfigChangeRow, OperatorAction, OperatorStepStatus } from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

export interface OperatorRequestRecord {
  id: string;
  projectKey: string;
  sessionId: string;
  source: 'message' | 'answer' | 'signal' | 'approval';
  messageId: string | null;
  inboxItemId: string | null;
  fromHandle: string;
  quote: string;
  openedAt: string;
  closedAt: string | null;
}

export interface OperatorStepRecord {
  id: string;
  requestId: string;
  at: string;
  action: OperatorAction;
  status: OperatorStepStatus;
  taskKey: string | null;
  member: string | null;
  changes: ConfigChangeRow[];
  configVersion: string | null;
  inboxItemId: string | null;
  /** The system signal the step acted on without a request (PM-545). */
  signalId: string | null;
  refusal: { code: string; message: string } | null;
}

interface StepRow extends Omit<OperatorStepRecord, 'changes' | 'refusal'> {
  changes: string;
  refusal: string | null;
}

const requestColumns = `id, project_key AS projectKey, session_id AS sessionId, source,
  message_id AS messageId, inbox_item_id AS inboxItemId, from_handle AS fromHandle, quote,
  opened_at AS openedAt, closed_at AS closedAt`;
const stepColumns = `id, request_id AS requestId, at, action, status, task_key AS taskKey, member, changes,
  config_version AS configVersion, inbox_item_id AS inboxItemId, signal_id AS signalId, refusal`;

const toStep = (row: StepRow): OperatorStepRecord => ({
  ...row,
  changes: parseJson<ConfigChangeRow[]>(row.changes, []),
  refusal: row.refusal ? parseJson(row.refusal, null) : null,
});

/** The owner's requests to the Operator and the steps it took for them (PM-463). */
export function createOperatorRequestRepository(db: Db) {
  const statements = {
    insertRequest: db.prepare(`INSERT INTO operator_requests
      (id, project_key, session_id, source, message_id, inbox_item_id, from_handle, quote, opened_at, closed_at)
      VALUES (@id, @projectKey, @sessionId, @source, @messageId, @inboxItemId, @fromHandle, @quote, @openedAt, NULL)`),
    openOfSession: db.prepare(
      `SELECT ${requestColumns} FROM operator_requests WHERE session_id = ? AND closed_at IS NULL
       ORDER BY opened_at DESC, rowid DESC`,
    ),
    openOfProject: db.prepare(
      `SELECT ${requestColumns} FROM operator_requests WHERE project_key = ? AND closed_at IS NULL`,
    ),
    close: db.prepare('UPDATE operator_requests SET closed_at = ? WHERE id = ? AND closed_at IS NULL'),
    get: db.prepare(`SELECT ${requestColumns} FROM operator_requests WHERE id = ?`),
    latest: db.prepare(
      `SELECT * FROM (SELECT ${requestColumns}, rowid AS n FROM operator_requests WHERE project_key = ?
       ORDER BY opened_at DESC, rowid DESC LIMIT ?) ORDER BY openedAt, n`,
    ),
    insertStep: db.prepare(`INSERT INTO operator_steps
      (id, request_id, at, action, status, task_key, member, changes, config_version, inbox_item_id, signal_id, refusal)
      VALUES (@id, @requestId, @at, @action, @status, @taskKey, @member, @changes, @configVersion, @inboxItemId, @signalId, @refusal)`),
    stepsOf: db.prepare(`SELECT ${stepColumns} FROM operator_steps WHERE request_id = ? ORDER BY at, rowid`),
    stepsOfSignal: db.prepare(
      `SELECT ${stepColumns} FROM operator_steps WHERE signal_id = ? ORDER BY at, rowid`,
    ),
  };
  return {
    insert(request: Omit<OperatorRequestRecord, 'closedAt'>): void {
      statements.insertRequest.run(request);
    },
    get(id: string): OperatorRequestRecord | null {
      return (statements.get.get(id) as OperatorRequestRecord | undefined) ?? null;
    },
    /** The session's requests that are not closed, the newest first. */
    openOfSession(sessionId: string): OperatorRequestRecord[] {
      return statements.openOfSession.all(sessionId) as OperatorRequestRecord[];
    },
    openOfProject(projectKey: string): OperatorRequestRecord[] {
      return statements.openOfProject.all(projectKey) as OperatorRequestRecord[];
    },
    /** Closes the request unless it is closed already; true when this call closed it. */
    close(id: string, at: string): boolean {
      return statements.close.run(at, id).changes > 0;
    },
    /** The latest `limit` requests of the project, the newest last. */
    latest(projectKey: string, limit: number): OperatorRequestRecord[] {
      return statements.latest.all(projectKey, limit) as OperatorRequestRecord[];
    },
    /** The latest `limit` requests of the project that these members made, the newest last (PM-475). */
    latestFrom(projectKey: string, handles: string[], limit: number): OperatorRequestRecord[] {
      if (handles.length === 0) return [];
      return db
        .prepare(
          `SELECT * FROM (SELECT ${requestColumns}, rowid AS n FROM operator_requests
           WHERE project_key = ? AND from_handle IN (${handles.map(() => '?').join(', ')})
           ORDER BY opened_at DESC, rowid DESC LIMIT ?) ORDER BY openedAt, n`,
        )
        .all(projectKey, ...handles, limit) as OperatorRequestRecord[];
    },
    insertStep(step: OperatorStepRecord): void {
      statements.insertStep.run({
        ...step,
        changes: toJson(step.changes),
        refusal: step.refusal ? toJson(step.refusal) : null,
      });
    },
    steps(requestId: string): OperatorStepRecord[] {
      return (statements.stepsOf.all(requestId) as StepRow[]).map(toStep);
    },
    /** The steps the Operator took on a signal, the oldest first. */
    stepsOfSignal(signalId: string): OperatorStepRecord[] {
      return (statements.stepsOfSignal.all(signalId) as StepRow[]).map(toStep);
    },
    /** Atomically consumes an approval; a claimed step is never replayed after a crash. */
    claimStep(id: string): boolean {
      return (
        db
          .prepare(
            "UPDATE operator_steps SET status = 'approved' WHERE id = ? AND status = 'awaiting_approval'",
          )
          .run(id).changes === 1
      );
    },
    /** Sets a step's status; `refusal` (when given) says why a step ended without doing its work. */
    updateStep(
      id: string,
      status: OperatorStepStatus,
      configVersion: string | null = null,
      refusal?: { code: string; message: string },
    ): void {
      db.prepare(
        `UPDATE operator_steps SET status = ?, config_version = COALESCE(?, config_version),
         refusal = COALESCE(?, refusal) WHERE id = ?`,
      ).run(status, configVersion, refusal ? toJson(refusal) : null, id);
    },
  };
}
