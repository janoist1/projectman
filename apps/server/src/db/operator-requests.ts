import type {
  ConfigChangeRow,
  OperatorAction,
  OperatorStepStatus,
  OperatorOperation,
} from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

export interface OperatorRequestRecord {
  id: string;
  projectKey: string;
  sessionId: string;
  source: 'message' | 'answer' | 'signal' | 'approval' | 'queue';
  messageId: string | null;
  inboxItemId: string | null;
  /** The member queue item a `queue` request is for (PM-885); null for the other sources. */
  queueItemId: string | null;
  fromHandle: string;
  quote: string;
  openedAt: string;
  closedAt: string | null;
}

export interface OperatorStepRecord {
  agreementVersion?: number | null;
  approvalMode?: 'click' | 'waived' | null;
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
  /** The super operation an `operation` step started (PM-888). */
  operationId?: string | null;
  /** The system feedback a `system_feedback` step recorded (PM-479). */
  systemFeedback?: { id: string; title: string; occurrence: number } | null;
  refusal: { code: string; message: string } | null;
}

interface StepRow extends Omit<OperatorStepRecord, 'changes' | 'refusal' | 'systemFeedback'> {
  changes: string;
  refusal: string | null;
  systemFeedback: string | null;
}

const requestColumns = `id, project_key AS projectKey, session_id AS sessionId, source,
  message_id AS messageId, inbox_item_id AS inboxItemId, queue_item_id AS queueItemId,
  from_handle AS fromHandle, quote, opened_at AS openedAt, closed_at AS closedAt`;
const stepColumns = `id, request_id AS requestId, at, action, status, task_key AS taskKey, member, changes,
  config_version AS configVersion, inbox_item_id AS inboxItemId, signal_id AS signalId, refusal,
  agreement_version AS agreementVersion, approval_mode AS approvalMode, operation_id AS operationId,
  system_feedback AS systemFeedback`;

export interface OperatorExecutionIntent {
  id: string;
  projectKey: string;
  requestId: string;
  operation: OperatorOperation;
  changes: ConfigChangeRow[];
  agreementVersion: number | null;
  approvalMode: 'click' | 'waived';
  status: 'prepared' | 'committed' | 'failed';
  createdAt: string;
  updatedAt: string;
  configVersion: string | null;
  refusal: { code: string; message: string } | null;
}
const intentColumns = `id, project_key AS projectKey, request_id AS requestId, operation, changes,
  agreement_version AS agreementVersion, approval_mode AS approvalMode, status, created_at AS createdAt,
  updated_at AS updatedAt, config_version AS configVersion, refusal`;

const toStep = (row: StepRow): OperatorStepRecord => ({
  ...row,
  changes: parseJson<ConfigChangeRow[]>(row.changes, []),
  refusal: row.refusal ? parseJson(row.refusal, null) : null,
  systemFeedback: row.systemFeedback ? parseJson(row.systemFeedback, null) : null,
});

/** The owner's requests to the Operator and the steps it took for them (PM-463). */
export function createOperatorRequestRepository(db: Db) {
  const statements = {
    insertRequest: db.prepare(`INSERT INTO operator_requests
      (id, project_key, session_id, source, message_id, inbox_item_id, queue_item_id, from_handle, quote, opened_at, closed_at)
      VALUES (@id, @projectKey, @sessionId, @source, @messageId, @inboxItemId, @queueItemId, @fromHandle, @quote, @openedAt, NULL)`),
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
      (id, request_id, at, action, status, task_key, member, changes, config_version, inbox_item_id, signal_id, refusal, agreement_version, approval_mode, operation_id, system_feedback)
      VALUES (@id, @requestId, @at, @action, @status, @taskKey, @member, @changes, @configVersion, @inboxItemId, @signalId, @refusal, @agreementVersion, @approvalMode, @operationId, @systemFeedback)`),
    stepsOf: db.prepare(`SELECT ${stepColumns} FROM operator_steps WHERE request_id = ? ORDER BY at, rowid`),
    stepsOfSignal: db.prepare(
      `SELECT ${stepColumns} FROM operator_steps WHERE signal_id = ? ORDER BY at, rowid`,
    ),
  };
  return {
    prepareExecution(intent: OperatorExecutionIntent): void {
      db.prepare(
        `INSERT INTO operator_execution_intents
        (id, project_key, request_id, operation, changes, agreement_version, approval_mode, status,
         created_at, updated_at, config_version, refusal)
        VALUES (@id, @projectKey, @requestId, @operation, @changes, @agreementVersion, @approvalMode,
          @status, @createdAt, @updatedAt, @configVersion, @refusal)`,
      ).run({
        ...intent,
        operation: toJson(intent.operation),
        changes: toJson(intent.changes),
        refusal: null,
      });
      db.prepare(
        'UPDATE operator_steps SET agreement_version = ?, approval_mode = ?, changes = ? WHERE id = ?',
      ).run(intent.agreementVersion, intent.approvalMode, toJson(intent.changes), intent.id);
    },
    executions(projectKey: string): OperatorExecutionIntent[] {
      return (
        db
          .prepare(`SELECT ${intentColumns} FROM operator_execution_intents WHERE project_key = ?`)
          .all(projectKey) as Array<
          Omit<OperatorExecutionIntent, 'operation' | 'changes' | 'refusal'> & {
            operation: string;
            changes: string;
            refusal: string | null;
          }
        >
      ).map((row) => ({
        ...row,
        operation: JSON.parse(row.operation) as OperatorOperation,
        changes: parseJson<ConfigChangeRow[]>(row.changes, []),
        refusal: row.refusal ? parseJson(row.refusal, null) : null,
      }));
    },
    finishExecution(
      id: string,
      status: 'committed' | 'failed',
      at: string,
      version: string | null,
      refusal: OperatorExecutionIntent['refusal'] = null,
    ): boolean {
      const result = db
        .prepare(
          `UPDATE operator_execution_intents SET status = ?, updated_at = ?, config_version = ?, refusal = ? WHERE id = ? AND status = 'prepared'`,
        )
        .run(status, at, version, refusal ? toJson(refusal) : null, id);
      if (!result.changes) return false;
      db.prepare(
        `UPDATE operator_steps SET status = CASE WHEN ? = 'committed' THEN
          CASE WHEN inbox_item_id IS NULL THEN 'done' ELSE 'approved' END ELSE 'refused' END,
          config_version = ?, refusal = ? WHERE id = ?`,
      ).run(status, version, refusal ? toJson(refusal) : null, id);
      return true;
    },
    insert(
      request: Omit<OperatorRequestRecord, 'closedAt' | 'queueItemId'> & { queueItemId?: string | null },
    ): void {
      statements.insertRequest.run({ ...request, queueItemId: request.queueItemId ?? null });
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
    latestFrom(
      projectKey: string,
      handles: string[],
      limit: number,
      recipient?: string,
    ): OperatorRequestRecord[] {
      if (handles.length === 0) return [];
      return db
        .prepare(
          `SELECT * FROM (SELECT ${requestColumns}, rowid AS n FROM operator_requests
           WHERE project_key = ? AND from_handle IN (${handles.map(() => '?').join(', ')})
           ${recipient === undefined ? '' : 'AND session_id IN (SELECT id FROM sessions WHERE member = ?)'}
           ORDER BY opened_at DESC, rowid DESC LIMIT ?) ORDER BY openedAt, n`,
        )
        .all(
          projectKey,
          ...handles,
          ...(recipient === undefined ? [] : [recipient]),
          limit,
        ) as OperatorRequestRecord[];
    },
    insertStep(step: OperatorStepRecord): void {
      statements.insertStep.run({
        ...step,
        agreementVersion: step.agreementVersion ?? null,
        approvalMode: step.approvalMode ?? null,
        operationId: step.operationId ?? null,
        systemFeedback: step.systemFeedback ? toJson(step.systemFeedback) : null,
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
