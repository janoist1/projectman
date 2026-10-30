import { Actor, SuperCommand } from '@projectman/shared';
import type { SuperHandoff, SuperOperation, SuperState } from '@projectman/shared';
import type { Db } from './database';

/**
 * A stored handoff: what the API shows, plus the request id of its idempotency, the hash of its command and
 * the CAS `revision` of its state machine (never shown).
 */
export interface StoredSuperHandoff extends SuperHandoff {
  requestId: string;
  commandHash: string;
  revision: number;
}

/** A stored operation: the public record plus the token it belongs to, the pinned version and the expiry. */
export interface StoredSuperOperation extends SuperOperation {
  keyId: string;
  commandHash: string;
  expectedConfigVersion: string | null;
  /** When the owner's open question lapses; null while there is none. */
  expiresAt: string | null;
  revision: number;
}

interface HandoffRow {
  id: string;
  project_key: string;
  task_key: string | null;
  request_id: string;
  requested_by: string;
  reason: string;
  command: string;
  command_hash: string;
  expected_config_version: string | null;
  state: SuperState;
  operation_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface OperationRow {
  id: string;
  project_key: string;
  task_key: string | null;
  key_id: string;
  request_id: string;
  handoff_id: string | null;
  command: string;
  command_hash: string;
  expected_config_version: string | null;
  state: SuperState;
  owner_question_id: string | null;
  expires_at: string | null;
  error_code: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

const toHandoff = (r: HandoffRow): StoredSuperHandoff => ({
  id: r.id,
  projectKey: r.project_key,
  taskKey: r.task_key,
  requestId: r.request_id,
  requestedBy: Actor.parse(JSON.parse(r.requested_by)),
  reason: r.reason,
  command: SuperCommand.parse(JSON.parse(r.command)),
  commandHash: r.command_hash,
  expectedConfigVersion: r.expected_config_version,
  state: r.state,
  operationId: r.operation_id,
  revision: r.revision,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toOperation = (r: OperationRow): StoredSuperOperation => ({
  id: r.id,
  projectKey: r.project_key,
  taskKey: r.task_key,
  keyId: r.key_id,
  requestId: r.request_id,
  handoffId: r.handoff_id,
  command: SuperCommand.parse(JSON.parse(r.command)),
  commandHash: r.command_hash,
  expectedConfigVersion: r.expected_config_version,
  state: r.state,
  ownerQuestionId: r.owner_question_id,
  expiresAt: r.expires_at,
  errorCode: r.error_code,
  revision: r.revision,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface SuperHandoffPatch {
  state: SuperState;
  operationId?: string | null;
  updatedAt: string;
}

interface SuperOperationPatch {
  state: SuperState;
  taskKey?: string;
  ownerQuestionId?: string | null;
  expiresAt?: string | null;
  errorCode?: string | null;
  updatedAt: string;
}

const OPEN = `('pending', 'waiting_owner', 'running')`;

/**
 * The super-mode operations (PM-762) and the handoff rows the retired base Operator recorded.
 * Every state change is a compare-and-set on `revision`: of two writers racing from the same state exactly one
 * wins, the other sees `false` and re-reads. Nothing here decides what a state means.
 */
export function createSuperHandoffRepository(db: Db) {
  const st = {
    handoff: db.prepare('SELECT * FROM super_handoffs WHERE project_key = ? AND id = ?'),
    casHandoff: db.prepare(
      `UPDATE super_handoffs
         SET state = ?, operation_id = CASE WHEN ? THEN ? ELSE operation_id END, updated_at = ?, revision = revision + 1
       WHERE project_key = ? AND id = ? AND revision = ?`,
    ),
    insertOperation: db.prepare(
      `INSERT INTO super_operations
         (id, project_key, task_key, key_id, request_id, handoff_id, command, command_hash,
          expected_config_version, state, owner_question_id, expires_at, error_code, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    operation: db.prepare('SELECT * FROM super_operations WHERE project_key = ? AND id = ?'),
    operationByRequest: db.prepare(
      'SELECT * FROM super_operations WHERE project_key = ? AND key_id = ? AND request_id = ?',
    ),
    operationsOfProject: db.prepare(
      'SELECT * FROM super_operations WHERE project_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ),
    operationsOfTask: db.prepare(
      'SELECT * FROM super_operations WHERE project_key = ? AND task_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ),
    operationOfQuestion: db.prepare('SELECT * FROM super_operations WHERE owner_question_id = ?'),
    operationsOpen: db.prepare(
      `SELECT * FROM super_operations WHERE state IN ${OPEN} ORDER BY created_at, rowid`,
    ),
    casOperation: db.prepare(
      `UPDATE super_operations
         SET state = ?,
             task_key = CASE WHEN ? AND task_key IS NULL THEN ? ELSE task_key END,
             owner_question_id = CASE WHEN ? THEN ? ELSE owner_question_id END,
             expires_at = CASE WHEN ? THEN ? ELSE expires_at END,
             error_code = CASE WHEN ? THEN ? ELSE error_code END,
             updated_at = ?, revision = revision + 1
       WHERE project_key = ? AND id = ? AND revision = ?`,
    ),
  };
  const flag = (value: unknown) => (value === undefined ? 0 : 1);
  return {
    /** An old handoff row (no new ones are recorded); its operation still keeps it in step. */
    handoff(projectKey: string, id: string): StoredSuperHandoff | null {
      const row = st.handoff.get(projectKey, id) as HandoffRow | undefined;
      return row ? toHandoff(row) : null;
    },
    /** Moves the handoff when it is still at `revision`; false: someone else moved it first. */
    casHandoff(projectKey: string, id: string, revision: number, patch: SuperHandoffPatch): boolean {
      return (
        st.casHandoff.run(
          patch.state,
          flag(patch.operationId),
          patch.operationId ?? null,
          patch.updatedAt,
          projectKey,
          id,
          revision,
        ).changes === 1
      );
    },
    insertOperation(o: StoredSuperOperation): void {
      st.insertOperation.run(
        o.id,
        o.projectKey,
        o.taskKey,
        o.keyId,
        o.requestId,
        o.handoffId,
        JSON.stringify(o.command),
        o.commandHash,
        o.expectedConfigVersion,
        o.state,
        o.ownerQuestionId,
        o.expiresAt,
        o.errorCode,
        o.revision,
        o.createdAt,
        o.updatedAt,
      );
    },
    operation(projectKey: string, id: string): StoredSuperOperation | null {
      const row = st.operation.get(projectKey, id) as OperationRow | undefined;
      return row ? toOperation(row) : null;
    },
    operationByRequest(projectKey: string, keyId: string, requestId: string): StoredSuperOperation | null {
      const row = st.operationByRequest.get(projectKey, keyId, requestId) as OperationRow | undefined;
      return row ? toOperation(row) : null;
    },
    /** The project's operations, newest first, optionally of one card. */
    listOperations(projectKey: string, opts: { taskKey?: string; limit: number }): StoredSuperOperation[] {
      const rows = (
        opts.taskKey
          ? st.operationsOfTask.all(projectKey, opts.taskKey, opts.limit)
          : st.operationsOfProject.all(projectKey, opts.limit)
      ) as OperationRow[];
      return rows.map(toOperation);
    },
    operationOfQuestion(questionId: string): StoredSuperOperation | null {
      const row = st.operationOfQuestion.get(questionId) as OperationRow | undefined;
      return row ? toOperation(row) : null;
    },
    openOperations(): StoredSuperOperation[] {
      return (st.operationsOpen.all() as OperationRow[]).map(toOperation);
    },
    casOperation(projectKey: string, id: string, revision: number, patch: SuperOperationPatch): boolean {
      return (
        st.casOperation.run(
          patch.state,
          flag(patch.taskKey),
          patch.taskKey ?? null,
          flag(patch.ownerQuestionId),
          patch.ownerQuestionId ?? null,
          flag(patch.expiresAt),
          patch.expiresAt ?? null,
          flag(patch.errorCode),
          patch.errorCode ?? null,
          patch.updatedAt,
          projectKey,
          id,
          revision,
        ).changes === 1
      );
    },
  };
}
