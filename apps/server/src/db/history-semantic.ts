import { createHash } from 'node:crypto';
import type { HistorySourceType } from '@projectman/shared';
import type { Statement } from 'better-sqlite3';
import type { Db } from './database';

/** The text of a source as a full read shows it: the heading and the body. Chunks and lines are counted on it. */
export function historyFullText(title: string, body: string): string {
  return [title, body].filter((part) => part !== '').join('\n\n');
}

/**
 * Identifies the text a vector was made from. A document also changes with its commit, so the commit is part of
 * it: a vector of another text or commit is never a hit.
 */
export function historyContentHash(title: string, body: string, commitSha: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify([title, body, commitSha ?? null]))
    .digest('hex');
}

/** The source row the embedder reads. */
interface HistorySemanticDocument {
  sourceId: string;
  projectKey: string;
  sourceType: HistorySourceType;
  title: string;
  body: string;
  commitSha: string | null;
}

interface HistorySemanticDirtyRow {
  sourceId: string;
  revision: number;
  attempts: number;
}

interface HistorySemanticSourceState {
  sourceId: string;
  indexKey: string;
  contentHash: string;
  nextChar: number;
  complete: boolean;
  chunks: number;
}

interface HistorySemanticBackfillState {
  projectKey: string;
  indexKey: string;
  lastSourceId: string;
  complete: boolean;
}

interface HistorySemanticChunkWrite {
  sourceId: string;
  indexKey: string;
  contentHash: string;
  chunkNo: number;
  startChar: number;
  endChar: number;
  fromLine: number;
  toLine: number;
  embedding: Float32Array;
  /** Where the next chunk starts, or the end of the text when this was the last. */
  nextChar: number;
  complete: boolean;
}

/** One best chunk per source (a row of the scan). */
interface HistorySemanticScanRow {
  sourceId: string;
  indexKey: string;
  contentHash: string;
  chunkNo: number;
  startChar: number;
  endChar: number;
  fromLine: number;
  toLine: number;
  distance: number;
  at: string;
}

interface HistorySemanticScanQuery {
  projectKey: string;
  indexKey: string;
  vector: Float32Array;
  /** Cosine distance limit: nothing farther is a candidate. */
  maxDistance: number;
  sourceTypes: readonly HistorySourceType[];
  taskKey?: string;
  since?: string;
  until?: string;
  sourceIds?: readonly string[];
  after?: { distance: number; at: string; sourceId: string };
  limit: number;
}

interface DocumentRow {
  source_id: string;
  project_key: string;
  source_type: string;
  title: string;
  body: string;
  commit_sha: string | null;
}

interface SourceRow {
  source_id: string;
  index_key: string;
  content_hash: string;
  next_char: number;
  complete: number;
  chunks: number;
}

interface ScanRow {
  source_id: string;
  index_key: string;
  content_hash: string;
  chunk_no: number;
  start_char: number;
  end_char: number;
  from_line: number;
  to_line: number;
  distance: number;
  at: string;
}

const toBlob = (vector: Float32Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

/**
 * The derived vector index of the history (PM-767): its sources, chunks, queue and backfill checkpoint. Plain
 * tables over a database handle; the similarity SQL functions exist only on a connection where the embedding
 * worker loaded sqlite-vec, so only `scan` needs one. Nothing else writes these tables.
 */
export function createHistorySemanticRepository(db: Db) {
  const statements = {
    projectKeys: db.prepare('SELECT key FROM projects ORDER BY key'),
    dueDirty: db.prepare(
      `SELECT source_id, revision, attempts FROM history_semantic_dirty
       WHERE next_attempt_at IS NULL OR next_attempt_at <= ? ORDER BY rowid LIMIT ?`,
    ),
    dirtyCount: db.prepare('SELECT COUNT(*) AS n FROM history_semantic_dirty'),
    nextAttempt: db.prepare(
      'SELECT MIN(next_attempt_at) AS at FROM history_semantic_dirty WHERE next_attempt_at IS NOT NULL',
    ),
    ackDirty: db.prepare('DELETE FROM history_semantic_dirty WHERE source_id = ? AND revision = ?'),
    enqueueDirty: db.prepare(
      `INSERT INTO history_semantic_dirty (source_id, attempts, next_attempt_at) VALUES (?, 1, ?)
       ON CONFLICT (source_id) DO NOTHING`,
    ),
    deferDirty: db.prepare(
      `UPDATE history_semantic_dirty SET attempts = attempts + 1, next_attempt_at = ?
       WHERE source_id = ? AND revision = ?`,
    ),
    document: db.prepare(
      `SELECT source_id, project_key, source_type, title, body, commit_sha FROM history_documents
       WHERE source_id = ?`,
    ),
    source: db.prepare(
      `SELECT s.source_id, s.index_key, s.content_hash, s.next_char, s.complete,
              (SELECT COUNT(*) FROM history_semantic_chunks c WHERE c.source_id = s.source_id) AS chunks
       FROM history_semantic_sources s WHERE s.source_id = ?`,
    ),
    deleteSource: db.prepare('DELETE FROM history_semantic_sources WHERE source_id = ?'),
    insertSource: db.prepare(
      `INSERT INTO history_semantic_sources (source_id, project_key, index_key, content_hash)
       VALUES (?, ?, ?, ?)`,
    ),
    insertChunk: db.prepare(
      `INSERT INTO history_semantic_chunks
         (source_id, chunk_no, start_char, end_char, from_line, to_line, embedding)
       VALUES (@sourceId, @chunkNo, @startChar, @endChar, @fromLine, @toLine, @embedding)`,
    ),
    advanceSource: db.prepare(
      'UPDATE history_semantic_sources SET next_char = ?, complete = ? WHERE source_id = ?',
    ),
    backfillState: db.prepare('SELECT * FROM history_semantic_state WHERE project_key = ?'),
    putBackfillState: db.prepare(
      `INSERT INTO history_semantic_state (project_key, index_key, last_source_id, complete)
       VALUES (@projectKey, @indexKey, @lastSourceId, @complete)
       ON CONFLICT (project_key) DO UPDATE SET index_key = excluded.index_key,
         last_source_id = excluded.last_source_id, complete = excluded.complete`,
    ),
    sourceIdsAfter: db.prepare(
      `SELECT source_id FROM history_documents WHERE project_key = ? AND source_id > ? ORDER BY source_id LIMIT ?`,
    ),
    dropOtherGenerations: db.prepare(
      'DELETE FROM history_semantic_sources WHERE project_key = ? AND index_key <> ?',
    ),
    pending: db.prepare(
      `SELECT COUNT(*) AS n FROM history_semantic_state s WHERE s.complete = 0 AND s.index_key = ?`,
    ),
    projectComplete: db.prepare(
      'SELECT complete FROM history_semantic_state WHERE project_key = ? AND index_key = ?',
    ),
    counts: db.prepare(
      `SELECT (SELECT COUNT(*) FROM history_semantic_sources WHERE index_key = ? AND complete = 1) AS sources,
              (SELECT COUNT(*) FROM history_semantic_chunks) AS chunks,
              (SELECT COUNT(*) FROM history_semantic_dirty) AS dirty`,
    ),
  };
  const scans = new Map<string, Statement<unknown[]>>();

  const scanOf = (query: HistorySemanticScanQuery) => {
    const types = [...query.sourceTypes].sort();
    const shape = [
      types.join(','),
      query.taskKey ? 't' : '',
      query.since ? 's' : '',
      query.until ? 'u' : '',
      query.sourceIds ? 'i' : '',
      query.after ? 'a' : '',
    ].join('|');
    let statement = scans.get(shape);
    if (!statement) {
      const filters = [
        's.project_key = ?',
        's.index_key = ?',
        's.complete = 1',
        `d.source_type IN (${types.map(() => '?').join(', ')})`,
        ...(query.taskKey ? ['d.task_key = ?'] : []),
        ...(query.since ? ['d.at >= ?'] : []),
        ...(query.until ? ['d.at <= ?'] : []),
        ...(query.sourceIds ? ['s.source_id IN (SELECT value FROM json_each(?))'] : []),
      ];
      const after = query.after
        ? 'AND (distance > ? OR (distance = ? AND (at < ? OR (at = ? AND source_id > ?))))'
        : '';
      statement = db.prepare(
        `SELECT source_id, index_key, content_hash, chunk_no, start_char, end_char, from_line, to_line,
                distance, at
         FROM (
           SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x.source_id ORDER BY x.distance, x.chunk_no) AS rn
           FROM (
             SELECT s.source_id AS source_id, s.index_key AS index_key, s.content_hash AS content_hash,
                    c.chunk_no AS chunk_no, c.start_char AS start_char, c.end_char AS end_char,
                    c.from_line AS from_line, c.to_line AS to_line, d.at AS at,
                    vec_distance_cosine(c.embedding, ?) AS distance
             FROM history_semantic_sources s
             JOIN history_documents d ON d.source_id = s.source_id
             JOIN history_semantic_chunks c ON c.source_id = s.source_id
             WHERE ${filters.join(' AND ')}
           ) x
           WHERE x.distance <= ?
         )
         WHERE rn = 1 ${after}
         ORDER BY distance, at DESC, source_id
         LIMIT ?`,
      );
      scans.set(shape, statement);
    }
    const params: unknown[] = [toBlob(query.vector), query.projectKey, query.indexKey, ...types];
    if (query.taskKey) params.push(query.taskKey);
    if (query.since) params.push(query.since);
    if (query.until) params.push(query.until);
    if (query.sourceIds) params.push(JSON.stringify(query.sourceIds));
    params.push(query.maxDistance);
    if (query.after) {
      const { distance, at, sourceId } = query.after;
      params.push(distance, distance, at, at, sourceId);
    }
    params.push(query.limit);
    return { statement, params };
  };

  const toDocument = (r: DocumentRow): HistorySemanticDocument => ({
    sourceId: r.source_id,
    projectKey: r.project_key,
    sourceType: r.source_type as HistorySourceType,
    title: r.title,
    body: r.body,
    commitSha: r.commit_sha,
  });

  const readSource = (sourceId: string): HistorySemanticSourceState | null => {
    const r = statements.source.get(sourceId) as SourceRow | undefined;
    return r
      ? {
          sourceId: r.source_id,
          indexKey: r.index_key,
          contentHash: r.content_hash,
          nextChar: r.next_char,
          complete: r.complete === 1,
          chunks: r.chunks,
        }
      : null;
  };

  return {
    projectKeys(): string[] {
      return (statements.projectKeys.all() as { key: string }[]).map((row) => row.key);
    },

    /** The queued sources whose time has come, oldest first. */
    dueDirty(now: string, limit: number): HistorySemanticDirtyRow[] {
      return (
        statements.dueDirty.all(now, limit) as { source_id: string; revision: number; attempts: number }[]
      ).map((r) => ({ sourceId: r.source_id, revision: r.revision, attempts: r.attempts }));
    },

    dirtyCount(): number {
      return (statements.dirtyCount.get() as { n: number }).n;
    },

    /** When the earliest deferred source is due again; null when none is deferred. */
    nextAttemptAt(): string | null {
      return (statements.nextAttempt.get() as { at: string | null }).at;
    },

    /** Acknowledges what was processed: a source that changed again meanwhile keeps its entry. */
    ackDirty(sourceId: string, revision: number): void {
      statements.ackDirty.run(sourceId, revision);
    },

    /** A source that failed stays queued and is tried again at `nextAttemptAt`. */
    deferDirty(sourceId: string, revision: number, nextAttemptAt: string): void {
      statements.deferDirty.run(nextAttemptAt, sourceId, revision);
    },

    /** Queues a source the backfill could not index, to be tried again at `nextAttemptAt`. */
    enqueueDirty(sourceId: string, nextAttemptAt: string): void {
      statements.enqueueDirty.run(sourceId, nextAttemptAt);
    },

    documentOf(sourceId: string): HistorySemanticDocument | null {
      const row = statements.document.get(sourceId) as DocumentRow | undefined;
      return row ? toDocument(row) : null;
    },

    sourceState(sourceId: string): HistorySemanticSourceState | null {
      return readSource(sourceId);
    },

    /** Forgets what is known of a source and starts it from its first chunk (the chunks go with it). */
    startSource(input: {
      sourceId: string;
      projectKey: string;
      indexKey: string;
      contentHash: string;
    }): void {
      db.transaction(() => {
        statements.deleteSource.run(input.sourceId);
        statements.insertSource.run(input.sourceId, input.projectKey, input.indexKey, input.contentHash);
      }).immediate();
    },

    removeSource(sourceId: string): void {
      statements.deleteSource.run(sourceId);
    },

    /**
     * Stores one chunk, under the write lock and only if the source still has the text the vector was made from:
     * a text that changed, or a source that is gone, is `stale` and nothing is written.
     */
    saveChunk(chunk: HistorySemanticChunkWrite): 'saved' | 'stale' {
      return db
        .transaction((): 'saved' | 'stale' => {
          const document = statements.document.get(chunk.sourceId) as DocumentRow | undefined;
          if (!document) return 'stale';
          if (historyContentHash(document.title, document.body, document.commit_sha) !== chunk.contentHash)
            return 'stale';
          const source = readSource(chunk.sourceId);
          if (
            !source ||
            source.indexKey !== chunk.indexKey ||
            source.contentHash !== chunk.contentHash ||
            source.chunks !== chunk.chunkNo
          )
            return 'stale';
          statements.insertChunk.run({
            sourceId: chunk.sourceId,
            chunkNo: chunk.chunkNo,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
            fromLine: chunk.fromLine,
            toLine: chunk.toLine,
            embedding: toBlob(chunk.embedding),
          });
          statements.advanceSource.run(chunk.nextChar, chunk.complete ? 1 : 0, chunk.sourceId);
          return 'saved';
        })
        .immediate();
    },

    backfillState(projectKey: string): HistorySemanticBackfillState | null {
      const r = statements.backfillState.get(projectKey) as
        { project_key: string; index_key: string; last_source_id: string; complete: number } | undefined;
      return r
        ? {
            projectKey: r.project_key,
            indexKey: r.index_key,
            lastSourceId: r.last_source_id,
            complete: r.complete === 1,
          }
        : null;
    },

    putBackfillState(state: HistorySemanticBackfillState): void {
      statements.putBackfillState.run({ ...state, complete: state.complete ? 1 : 0 });
    },

    /** The source ids of a project after `afterId`, in id order: a backfill page. */
    sourceIdsAfter(projectKey: string, afterId: string, limit: number): string[] {
      return (statements.sourceIdsAfter.all(projectKey, afterId, limit) as { source_id: string }[]).map(
        (row) => row.source_id,
      );
    },

    /** Removes the vectors of an older model generation of a project once the new one is complete. */
    dropOtherGenerations(projectKey: string, indexKey: string): number {
      return statements.dropOtherGenerations.run(projectKey, indexKey).changes;
    },

    /** True when every project's backfill of this generation is complete. */
    backfillComplete(indexKey: string): boolean {
      return (statements.pending.get(indexKey) as { n: number }).n === 0;
    },

    projectBackfillComplete(projectKey: string, indexKey: string): boolean {
      const r = statements.projectComplete.get(projectKey, indexKey) as { complete: number } | undefined;
      return r?.complete === 1;
    },

    counts(indexKey: string): { sources: number; chunks: number; dirty: number } {
      return statements.counts.get(indexKey) as { sources: number; chunks: number; dirty: number };
    },

    /** The nearest chunk of each source, nearest first; needs sqlite-vec loaded on this connection. */
    scan(query: HistorySemanticScanQuery): HistorySemanticScanRow[] {
      const { statement, params } = scanOf(query);
      return (statement.all(...params) as ScanRow[]).map((r) => ({
        sourceId: r.source_id,
        indexKey: r.index_key,
        contentHash: r.content_hash,
        chunkNo: r.chunk_no,
        startChar: r.start_char,
        endChar: r.end_char,
        fromLine: r.from_line,
        toLine: r.to_line,
        distance: r.distance,
        at: r.at,
      }));
    },
  };
}
