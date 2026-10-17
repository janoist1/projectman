import { HybridDeployment } from '@projectman/shared';
import type { Db } from './database';

interface DeploymentRow {
  data_json: string;
}

/** A request the deployment already took: a repeat of it is answered from this, never applied twice. */
export interface DeploymentRequestRecord {
  requestId: string;
  releaseId: string;
  attemptId: string;
  payloadHash: string;
  resultingRevision: number;
}

interface RequestRow {
  request_id: string;
  release_id: string;
  attempt_id: string;
  payload_hash: string;
  resulting_revision: number;
}

function deployment(row: DeploymentRow): HybridDeployment {
  return HybridDeployment.parse(JSON.parse(row.data_json));
}

/**
 * The durable deployments of the hybrid releases (PM-752). The row repeats `phase`, `maintenance` and
 * `revision` of the validated document in their own columns, always in one statement, so the database's
 * unique index keeps one active deployment and the fence is readable without parsing.
 */
export function createReleaseDeploymentRepository(db: Db) {
  const params = (value: HybridDeployment) => ({
    releaseId: value.releaseId,
    attemptId: value.attemptId,
    controllerId: value.controllerId,
    phase: value.phase,
    maintenance: value.maintenance ? 1 : 0,
    revision: value.revision,
    dataJson: JSON.stringify(HybridDeployment.parse(value)),
    updatedAt: value.updatedAt,
  });
  return {
    get(releaseId: string): HybridDeployment | null {
      const row = db
        .prepare('SELECT data_json FROM release_deployments WHERE release_id = ?')
        .get(releaseId) as DeploymentRow | undefined;
      return row ? deployment(row) : null;
    },
    /** The deployment that holds the instance's slot: an unfinished phase, or the fence still up. */
    active(): HybridDeployment | null {
      const row = db
        .prepare(
          `SELECT data_json FROM release_deployments
           WHERE maintenance = 1 OR phase IN ('preparing','prepared','quiescing','switching','recovery_required')
           LIMIT 1`,
        )
        .get() as DeploymentRow | undefined;
      return row ? deployment(row) : null;
    },
    /** The fence: true while a deployment holds the maintenance bit. Read live, so it holds from the first query. */
    maintenanceHeld(): boolean {
      return (
        db.prepare('SELECT 1 FROM release_deployments WHERE maintenance = 1 LIMIT 1').get() !== undefined
      );
    },
    insert(value: HybridDeployment): void {
      db.prepare(
        `INSERT INTO release_deployments (release_id, attempt_id, controller_id, phase, maintenance, revision, data_json, updated_at)
         VALUES (@releaseId, @attemptId, @controllerId, @phase, @maintenance, @revision, @dataJson, @updatedAt)`,
      ).run(params(value));
    },
    /** Writes the next revision; false when the stored revision is not the one before it (a lost race). */
    save(value: HybridDeployment, expectedRevision: number): boolean {
      const result = db
        .prepare(
          `UPDATE release_deployments SET phase = @phase, maintenance = @maintenance, revision = @revision,
             data_json = @dataJson, updated_at = @updatedAt
           WHERE release_id = @releaseId AND attempt_id = @attemptId AND revision = @expected`,
        )
        .run({ ...params(value), expected: expectedRevision });
      return result.changes === 1;
    },
    request(requestId: string): DeploymentRequestRecord | null {
      const row = db
        .prepare(
          `SELECT request_id, release_id, attempt_id, payload_hash, resulting_revision
           FROM release_deployment_requests WHERE request_id = ?`,
        )
        .get(requestId) as RequestRow | undefined;
      return row
        ? {
            requestId: row.request_id,
            releaseId: row.release_id,
            attemptId: row.attempt_id,
            payloadHash: row.payload_hash,
            resultingRevision: row.resulting_revision,
          }
        : null;
    },
    recordRequest(record: DeploymentRequestRecord, createdAt: string): void {
      db.prepare(
        `INSERT INTO release_deployment_requests (request_id, release_id, attempt_id, payload_hash, resulting_revision, created_at)
         VALUES (@requestId, @releaseId, @attemptId, @payloadHash, @resultingRevision, @createdAt)`,
      ).run({ ...record, createdAt });
    },
  };
}
