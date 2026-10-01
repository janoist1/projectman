import { BoundaryRequest, BoundaryGrant } from '@projectman/shared';
import type { Db } from './database';

export function createBoundaryRepository(db: Db) {
  const getRequest = db.prepare('SELECT record FROM boundary_requests WHERE id = ?');
  const getGrant = db.prepare('SELECT record FROM boundary_grants WHERE request_id = ?');
  const insertRequest = db.prepare('INSERT INTO boundary_requests VALUES (?, ?, ?, ?, ?)');
  const updateRequest = db.prepare('UPDATE boundary_requests SET record = ? WHERE id = ?');
  const insertGrant = db.prepare('INSERT INTO boundary_grants VALUES (?, ?, ?)');
  const updateGrant = db.prepare('UPDATE boundary_grants SET record = ? WHERE request_id = ?');
  const dedupe = db.prepare(
    'SELECT record FROM boundary_requests WHERE project_key = ? AND session_id = ? AND deduplication_key = ?',
  );
  const list = db.prepare('SELECT record FROM boundary_requests ORDER BY rowid');
  const listActive = db.prepare(
    "SELECT id, project_key FROM boundary_requests WHERE json_extract(record, '$.state') IN ('pending_lead', 'pending_owner', 'allowed') AND NOT EXISTS (SELECT 1 FROM boundary_grants WHERE request_id = boundary_requests.id AND (json_extract(record, '$.state') = 'consumed' OR json_extract(record, '$.consumedAt') IS NOT NULL)) ORDER BY rowid",
  );
  const consume = db.prepare(
    "UPDATE boundary_grants SET record = json_set(record, '$.consumedAt', ?, '$.state', 'consumed') WHERE request_id = ? AND json_extract(record, '$.state') = 'active' AND json_extract(record, '$.consumedAt') IS NULL AND json_extract(record, '$.revokedAt') IS NULL RETURNING record",
  );
  const decodeRequest = (row: unknown): BoundaryRequest | null =>
    row ? BoundaryRequest.parse(JSON.parse((row as { record: string }).record)) : null;
  return {
    get: (id: string) => decodeRequest(getRequest.get(id)),
    duplicate: (projectKey: string, sessionId: string, key: string) =>
      decodeRequest(dedupe.get(projectKey, sessionId, key)),
    list: () => list.all().map((row) => decodeRequest(row)!),
    listActive: () =>
      (listActive.all() as Array<{ id: string; project_key: string }>).map((row) => ({
        id: row.id,
        projectKey: row.project_key,
      })),
    consume(requestId: string, at: string): BoundaryGrant | null {
      const row = consume.get(at, requestId) as { record: string } | undefined;
      return row ? BoundaryGrant.parse(JSON.parse(row.record)) : null;
    },
    insert(request: BoundaryRequest) {
      insertRequest.run(
        request.id,
        request.projectKey,
        request.sessionId,
        request.deduplicationKey,
        JSON.stringify(request),
      );
    },
    update(request: BoundaryRequest) {
      updateRequest.run(JSON.stringify(request), request.id);
    },
    grant(requestId: string): BoundaryGrant | null {
      const row = getGrant.get(requestId) as { record: string } | undefined;
      return row ? BoundaryGrant.parse(JSON.parse(row.record)) : null;
    },
    insertGrant(grant: BoundaryGrant) {
      insertGrant.run(grant.id, grant.requestId, JSON.stringify(grant));
    },
    updateGrant(grant: BoundaryGrant) {
      updateGrant.run(JSON.stringify(grant), grant.requestId);
    },
  };
}
