import type { SuperAuditOutcome, SuperOperationAudit } from '@projectman/shared';
import type { Db } from './database';

interface AuditRow {
  seq: number;
  id: string;
  project_key: string;
  task_key: string | null;
  key_id: string;
  prefix: string;
  request_id: string;
  handoff_id: string | null;
  operation: string;
  outcome: SuperAuditOutcome;
  error_code: string | null;
  settles_id: string | null;
  created_at: string;
}

/**
 * A stored audit entry: what the API shows, plus the key id the entry was made with (never shown) and the
 * `started` entry this result closes, when it is one.
 */
export interface StoredSuperAudit extends SuperOperationAudit {
  keyId: string;
  settlesId: string | null;
}

const toEntry = (r: AuditRow): StoredSuperAudit => ({
  id: r.id,
  projectKey: r.project_key,
  taskKey: r.task_key,
  keyId: r.key_id,
  prefix: r.prefix,
  operatorMode: 'super',
  requestId: r.request_id,
  handoffId: r.handoff_id,
  operation: r.operation,
  outcome: r.outcome,
  errorCode: r.error_code,
  settlesId: r.settles_id,
  createdAt: r.created_at,
});

/**
 * The audit of the Operator's super mode (PM-757), append-only: there is no update or delete. Entries are
 * ordered by the internal `seq`, never by time, so the order survives equal timestamps.
 */
export function createSuperAuditRepository(db: Db) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO super_operation_audit
         (id, project_key, task_key, key_id, prefix, request_id, handoff_id, operation, outcome, error_code, settles_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    unsettled: db.prepare(
      `SELECT * FROM super_operation_audit s
       WHERE s.project_key = ? AND s.outcome = 'started'
         AND NOT EXISTS (SELECT 1 FROM super_operation_audit r WHERE r.settles_id = s.id)
       ORDER BY s.seq`,
    ),
    seqOf: db.prepare('SELECT seq FROM super_operation_audit WHERE project_key = ? AND id = ?'),
    page: db.prepare(
      `SELECT * FROM super_operation_audit
       WHERE project_key = ? AND (? IS NULL OR prefix = ?) AND (? IS NULL OR seq < ?)
       ORDER BY seq DESC LIMIT ?`,
    ),
    ofRequest: db.prepare(
      'SELECT * FROM super_operation_audit WHERE project_key = ? AND request_id = ? ORDER BY seq',
    ),
  };
  return {
    insert(e: StoredSuperAudit): void {
      statements.insert.run(
        e.id,
        e.projectKey,
        e.taskKey,
        e.keyId,
        e.prefix,
        e.requestId,
        e.handoffId,
        e.operation,
        e.outcome,
        e.errorCode,
        e.settlesId,
        e.createdAt,
      );
    },
    /** The `started` entries of a project that have no result yet (an operation in flight or lost). */
    unsettled(projectKey: string): StoredSuperAudit[] {
      return (statements.unsettled.all(projectKey) as AuditRow[]).map(toEntry);
    },
    /** Whether `id` is an entry of the project (the cursor of `list`). */
    has(projectKey: string, id: string): boolean {
      return !!statements.seqOf.get(projectKey, id);
    },
    /**
     * Newest first, at most `limit`; `before` is an entry id of the project (the page after it), `prefix`
     * keeps one token's entries. `nextBefore` is the last id when older entries remain.
     */
    list(
      projectKey: string,
      opts: { prefix?: string; before?: string; limit: number },
    ): { entries: StoredSuperAudit[]; nextBefore: string | null } {
      const before = opts.before
        ? ((statements.seqOf.get(projectKey, opts.before) as { seq: number } | undefined)?.seq ?? null)
        : null;
      const prefix = opts.prefix ?? null;
      const rows = statements.page.all(
        projectKey,
        prefix,
        prefix,
        before,
        before,
        opts.limit + 1,
      ) as AuditRow[];
      const entries = rows.slice(0, opts.limit).map(toEntry);
      return { entries, nextBefore: rows.length > opts.limit ? entries[entries.length - 1]!.id : null };
    },
    /** Every entry of one request, oldest first (a `started` and its result). */
    ofRequest(projectKey: string, requestId: string): StoredSuperAudit[] {
      return (statements.ofRequest.all(projectKey, requestId) as AuditRow[]).map(toEntry);
    },
  };
}
