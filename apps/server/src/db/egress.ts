import { EgressAllowance, EgressOperation } from '@projectman/shared';
import type { EgressDestination } from '@projectman/shared';
import type { Db } from './database';

interface OperationRow {
  id: string;
  project_key: string;
  member: string;
  session_id: string;
  task_key: string | null;
  host: string;
  port: number;
  created_at: string;
  expires_at: string;
}

interface AllowanceRow {
  id: string;
  project_key: string;
  member: string;
  host: string;
  port: number;
  request_id: string;
  operation_id: string;
  granted_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

const toOperation = (row: OperationRow): EgressOperation =>
  EgressOperation.parse({
    id: row.id,
    projectKey: row.project_key,
    member: row.member,
    sessionId: row.session_id,
    taskKey: row.task_key,
    host: row.host,
    port: row.port,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });

const toAllowance = (row: AllowanceRow): EgressAllowance =>
  EgressAllowance.parse({
    id: row.id,
    projectKey: row.project_key,
    member: row.member,
    host: row.host,
    port: row.port,
    requestId: row.request_id,
    operationId: row.operation_id,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  });

/** Egress operations and allowances of the VM boundary (PM-140, migration 14). */
export function createEgressRepository(db: Db) {
  const getOperation = db.prepare('SELECT * FROM egress_operations WHERE id = ?');
  const insertOperation = db.prepare(
    'INSERT INTO egress_operations VALUES (@id, @project_key, @member, @session_id, @task_key, @host, @port, @created_at, @expires_at)',
  );
  const sessionOperation = db.prepare(
    'SELECT * FROM egress_operations WHERE session_id = ? AND host = ? AND port = ? AND expires_at > ? ORDER BY rowid DESC LIMIT 1',
  );
  const countSession = db.prepare('SELECT COUNT(*) AS n FROM egress_operations WHERE session_id = ?');
  const memberOperations = db.prepare(
    'SELECT * FROM egress_operations WHERE project_key = ? AND member = ? AND host = ? AND port = ? AND expires_at > ? ORDER BY rowid DESC',
  );
  const recentSession = db.prepare(
    'SELECT * FROM egress_operations WHERE session_id = ? AND expires_at > ? ORDER BY rowid DESC LIMIT ?',
  );
  const insertAllowance = db.prepare(
    'INSERT INTO egress_allowances VALUES (@id, @project_key, @member, @host, @port, @request_id, @operation_id, @granted_at, @expires_at, NULL, NULL)',
  );
  const activeAllowance = db.prepare(
    'SELECT * FROM egress_allowances WHERE project_key = ? AND member = ? AND host = ? AND port = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY rowid DESC LIMIT 1',
  );
  const getAllowance = db.prepare('SELECT * FROM egress_allowances WHERE id = ?');
  const allowanceForRequest = db.prepare('SELECT * FROM egress_allowances WHERE request_id = ?');
  const listAllowances = db.prepare(
    'SELECT * FROM egress_allowances WHERE project_key = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY rowid DESC',
  );
  const revokeAllowance = db.prepare(
    'UPDATE egress_allowances SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL RETURNING *',
  );

  return {
    operation(id: string): EgressOperation | null {
      const row = getOperation.get(id) as OperationRow | undefined;
      return row ? toOperation(row) : null;
    },
    /** The session's newest unexpired operation for the destination. */
    sessionOperation(sessionId: string, destination: EgressDestination, now: string): EgressOperation | null {
      const row = sessionOperation.get(sessionId, destination.host, destination.port, now) as
        | OperationRow
        | undefined;
      return row ? toOperation(row) : null;
    },
    countForSession(sessionId: string): number {
      return (countSession.get(sessionId) as { n: number }).n;
    },
    /** Unexpired operations of the member in the project for the destination, newest first. */
    memberOperations(
      projectKey: string,
      member: string,
      destination: EgressDestination,
      now: string,
    ): EgressOperation[] {
      return (
        memberOperations.all(projectKey, member, destination.host, destination.port, now) as OperationRow[]
      ).map(toOperation);
    },
    recentForSession(sessionId: string, now: string, limit: number): EgressOperation[] {
      return (recentSession.all(sessionId, now, limit) as OperationRow[]).map(toOperation);
    },
    insertOperation(operation: EgressOperation): void {
      insertOperation.run({
        id: operation.id,
        project_key: operation.projectKey,
        member: operation.member,
        session_id: operation.sessionId,
        task_key: operation.taskKey,
        host: operation.host,
        port: operation.port,
        created_at: operation.createdAt,
        expires_at: operation.expiresAt,
      });
    },
    activeAllowance(
      projectKey: string,
      member: string,
      destination: EgressDestination,
      now: string,
    ): EgressAllowance | null {
      const row = activeAllowance.get(projectKey, member, destination.host, destination.port, now) as
        | AllowanceRow
        | undefined;
      return row ? toAllowance(row) : null;
    },
    allowance(id: string): EgressAllowance | null {
      const row = getAllowance.get(id) as AllowanceRow | undefined;
      return row ? toAllowance(row) : null;
    },
    allowanceForRequest(requestId: string): EgressAllowance | null {
      const row = allowanceForRequest.get(requestId) as AllowanceRow | undefined;
      return row ? toAllowance(row) : null;
    },
    listAllowances(projectKey: string, now: string): EgressAllowance[] {
      return (listAllowances.all(projectKey, now) as AllowanceRow[]).map(toAllowance);
    },
    insertAllowance(allowance: EgressAllowance): void {
      insertAllowance.run({
        id: allowance.id,
        project_key: allowance.projectKey,
        member: allowance.member,
        host: allowance.host,
        port: allowance.port,
        request_id: allowance.requestId,
        operation_id: allowance.operationId,
        granted_at: allowance.grantedAt,
        expires_at: allowance.expiresAt,
      });
    },
    revokeAllowance(id: string, at: string, by: string): EgressAllowance | null {
      const row = revokeAllowance.get(at, by, id) as AllowanceRow | undefined;
      return row ? toAllowance(row) : null;
    },
  };
}
