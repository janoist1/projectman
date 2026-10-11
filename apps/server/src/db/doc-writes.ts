import type { Db } from './database';
import { parseJson, toJson } from './json';

export type DocWriteState = 'queued' | 'running' | 'published' | 'stale' | 'failed';

/** One text replacement in one file; an empty `old_text` appends. */
export interface DocWriteEdit {
  path: string;
  old_text: string;
  new_text: string;
}

/** A write of the Operator's documents to the default branch (PM-495): queued, run in the merge slot, then ended. */
export interface DocWriteRecord {
  id: string;
  projectKey: string;
  repo: string;
  /** The repository's default branch. */
  base: string;
  /** The commit the edits were made against. */
  baseCommit: string;
  edits: DocWriteEdit[];
  /** The full commit message, trailers included. */
  message: string;
  /** The Operator's handle. */
  author: string;
  /** The owner whose request it ran under. */
  requestedBy: string;
  requestId: string;
  stepId: string;
  engineId: string;
  state: DocWriteState;
  /** The commit that was built; saved before the push. */
  commitSha: string | null;
  /** Why it failed (or the warning of a published one), as `{ code: DocWriteFailure, message }`. */
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface DocWriteRow {
  id: string;
  project_key: string;
  repo: string;
  base: string;
  base_commit: string;
  edits: string;
  message: string;
  author: string;
  requested_by: string;
  request_id: string;
  step_id: string;
  engine_id: string;
  state: DocWriteState;
  commit_sha: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (row: DocWriteRow): DocWriteRecord => ({
  id: row.id,
  projectKey: row.project_key,
  repo: row.repo,
  base: row.base,
  baseCommit: row.base_commit,
  edits: parseJson<DocWriteEdit[]>(row.edits, []),
  message: row.message,
  author: row.author,
  requestedBy: row.requested_by,
  requestId: row.request_id,
  stepId: row.step_id,
  engineId: row.engine_id,
  state: row.state,
  commitSha: row.commit_sha,
  error: row.error ? parseJson<DocWriteRecord['error']>(row.error, null) : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** What `update` may change; `updatedAt` is always set by the caller. */
export type DocWritePatch = Partial<Pick<DocWriteRecord, 'state' | 'commitSha' | 'error'>> & {
  updatedAt: string;
};

/** The writes of the Operator's documents. Open means queued or running: one per project at a time. */
export function createDocWriteRepository(db: Db) {
  const statements = {
    insert: db.prepare(`INSERT INTO doc_writes
      (id, project_key, repo, base, base_commit, edits, message, author, requested_by, request_id, step_id,
       engine_id, state, commit_sha, error, created_at, updated_at)
      VALUES (@id, @projectKey, @repo, @base, @baseCommit, @edits, @message, @author, @requestedBy, @requestId,
       @stepId, @engineId, @state, @commitSha, @error, @createdAt, @updatedAt)`),
    get: db.prepare('SELECT * FROM doc_writes WHERE id = ?'),
    openOf: db.prepare("SELECT * FROM doc_writes WHERE project_key = ? AND state IN ('queued','running')"),
    list: db.prepare('SELECT * FROM doc_writes WHERE state = ? ORDER BY created_at, rowid'),
  };
  return {
    insert(record: DocWriteRecord): void {
      statements.insert.run({
        ...record,
        edits: toJson(record.edits),
        error: record.error ? toJson(record.error) : null,
      });
    },
    get(id: string): DocWriteRecord | null {
      const row = statements.get.get(id) as DocWriteRow | undefined;
      return row ? toRecord(row) : null;
    },
    /** The project's queued or running write, if any. */
    openOf(projectKey: string): DocWriteRecord | null {
      const row = statements.openOf.get(projectKey) as DocWriteRow | undefined;
      return row ? toRecord(row) : null;
    },
    list(state: DocWriteState): DocWriteRecord[] {
      return (statements.list.all(state) as DocWriteRow[]).map(toRecord);
    },
    update(id: string, patch: DocWritePatch): void {
      const sets = ['updated_at = @updatedAt'];
      const values: Record<string, unknown> = { id, updatedAt: patch.updatedAt };
      if (patch.state !== undefined) {
        sets.push('state = @state');
        values.state = patch.state;
      }
      if (patch.commitSha !== undefined) {
        sets.push('commit_sha = @commitSha');
        values.commitSha = patch.commitSha;
      }
      if (patch.error !== undefined) {
        sets.push('error = @error');
        values.error = patch.error ? toJson(patch.error) : null;
      }
      db.prepare(`UPDATE doc_writes SET ${sets.join(', ')} WHERE id = @id`).run(values);
    },
  };
}
