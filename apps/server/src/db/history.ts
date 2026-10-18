import { createHash } from 'node:crypto';
import type { HistoryDocPath, HistoryDocumentStatus, HistorySourceType } from '@projectman/shared';
import type { Statement } from 'better-sqlite3';
import type { Db } from './database';

/** The version of the projection the index holds; a higher one makes every project backfill again. */
export const HISTORY_INDEX_VERSION = 1;

/** The stable, opaque identifier of a source: the same entity always has the same one. */
export function historySourceId(projectKey: string, sourceType: HistorySourceType, entityId: string): string {
  return `hsrc_${createHash('sha256').update(`${projectKey}\u0000${sourceType}\u0000${entityId}`).digest('hex')}`;
}

/** The entity identifier of a document: the repository and the path, as JSON. */
export function historyDocumentEntityId(repo: string, path: HistoryDocPath): string {
  return JSON.stringify([repo, path]);
}

/** What the index keeps of one source: its searchable text and the metadata of its hit. */
export interface HistoryDocumentWrite {
  projectKey: string;
  sourceType: HistorySourceType;
  entityId: string;
  taskKey: string | null;
  author: string | null;
  at: string;
  title: string;
  body: string;
  repo?: string;
  path?: HistoryDocPath;
  commitSha?: string;
}

export interface HistoryDocumentRow {
  sourceId: string;
  projectKey: string;
  sourceType: HistorySourceType;
  entityId: string;
  taskKey: string | null;
  author: string | null;
  at: string;
  title: string;
  body: string;
  repo: string | null;
  path: HistoryDocPath | null;
  commitSha: string | null;
}

export interface HistoryDirtyRow {
  projectKey: string;
  sourceType: HistorySourceType;
  entityId: string;
  revision: number;
}

export interface HistoryIndexStateRow {
  projectKey: string;
  version: number;
  complete: boolean;
  sourceType: HistorySourceType | null;
  lastId: string | null;
}

export interface HistoryDocStateRow {
  projectKey: string;
  repo: string;
  path: HistoryDocPath;
  commitSha: string | null;
  checkedAt: string | null;
  indexedAt: string | null;
  status: HistoryDocumentStatus;
}

/** The filters of a candidate scan (project, types, card and time only: never access). */
export interface HistoryCandidateQuery {
  match: string;
  projectKey: string;
  sourceTypes: readonly HistorySourceType[];
  taskKey?: string;
  since?: string;
  until?: string;
}

interface DocumentRow {
  source_id: string;
  project_key: string;
  source_type: string;
  entity_id: string;
  task_key: string | null;
  author: string | null;
  at: string;
  title: string;
  body: string;
  repo: string | null;
  path: string | null;
  commit_sha: string | null;
}

interface DirtyRow {
  project_key: string;
  source_type: string;
  entity_id: string;
  revision: number;
}

interface StateRow {
  project_key: string;
  version: number;
  complete: number;
  source_type: string | null;
  last_id: string | null;
}

interface DocStateRow {
  project_key: string;
  repo: string;
  path: string;
  commit_sha: string | null;
  checked_at: string | null;
  indexed_at: string | null;
  status: string;
}

const toDocument = (r: DocumentRow): HistoryDocumentRow => ({
  sourceId: r.source_id,
  projectKey: r.project_key,
  sourceType: r.source_type as HistorySourceType,
  entityId: r.entity_id,
  taskKey: r.task_key,
  author: r.author,
  at: r.at,
  title: r.title,
  body: r.body,
  repo: r.repo,
  path: r.path as HistoryDocPath | null,
  commitSha: r.commit_sha,
});

const toState = (r: StateRow): HistoryIndexStateRow => ({
  projectKey: r.project_key,
  version: r.version,
  complete: r.complete === 1,
  sourceType: r.source_type as HistorySourceType | null,
  lastId: r.last_id,
});

const toDocState = (r: DocStateRow): HistoryDocStateRow => ({
  projectKey: r.project_key,
  repo: r.repo,
  path: r.path as HistoryDocPath,
  commitSha: r.commit_sha,
  checkedAt: r.checked_at,
  indexedAt: r.indexed_at,
  status: r.status as HistoryDocumentStatus,
});

/** The tables whose entity ids the backfill walks, per source type. */
const BACKFILL_TABLES: Readonly<
  Record<Exclude<HistorySourceType, 'document'>, { table: string; filter: string }>
> = {
  task: { table: 'tasks', filter: '1' },
  note: { table: 'timeline_events', filter: "type = 'task_note'" },
  question: { table: 'inbox_items', filter: '1' },
  message: { table: 'team_messages', filter: '1' },
};

/**
 * The durable history index (PM-786): the searchable projection of the project history, its dirty queue, the
 * backfill checkpoints and the state of the document copies. The text and the access rules are the service's;
 * this file only stores and scans. Nothing else writes these tables.
 */
export function createHistoryRepository(db: Db) {
  const statements = {
    upsert: db.prepare(
      `INSERT INTO history_documents
         (source_id, project_key, source_type, entity_id, task_key, author, at, title, body, repo, path, commit_sha)
       VALUES (@sourceId, @projectKey, @sourceType, @entityId, @taskKey, @author, @at, @title, @body, @repo, @path, @commitSha)
       ON CONFLICT (source_id) DO UPDATE SET
         task_key = excluded.task_key, author = excluded.author, at = excluded.at, title = excluded.title,
         body = excluded.body, repo = excluded.repo, path = excluded.path, commit_sha = excluded.commit_sha
       WHERE task_key IS NOT excluded.task_key OR author IS NOT excluded.author OR at IS NOT excluded.at
         OR title IS NOT excluded.title OR body IS NOT excluded.body OR repo IS NOT excluded.repo
         OR path IS NOT excluded.path OR commit_sha IS NOT excluded.commit_sha`,
    ),
    deleteOne: db.prepare('DELETE FROM history_documents WHERE source_id = ?'),
    byEntity: db.prepare(
      `SELECT * FROM history_documents WHERE project_key = ? AND source_type = ? AND entity_id = ?`,
    ),
    bySourceId: db.prepare('SELECT * FROM history_documents WHERE source_id = ? AND project_key = ?'),
    documentsOfRepo: db.prepare(
      `SELECT * FROM history_documents WHERE project_key = ? AND source_type = 'document' AND repo = ?`,
    ),
    deleteDocumentsOfRepo: db.prepare(
      `DELETE FROM history_documents WHERE project_key = ? AND source_type = 'document' AND repo = ?`,
    ),
    countDocuments: db.prepare('SELECT COUNT(*) AS n FROM history_documents WHERE project_key = ?'),
    dirty: db.prepare('SELECT * FROM history_dirty ORDER BY rowid LIMIT ?'),
    dirtyOfProject: db.prepare('SELECT * FROM history_dirty WHERE project_key = ? ORDER BY rowid LIMIT ?'),
    ackDirty: db.prepare(
      `DELETE FROM history_dirty WHERE project_key = ? AND source_type = ? AND entity_id = ? AND revision = ?`,
    ),
    dirtyCount: db.prepare('SELECT COUNT(*) AS n FROM history_dirty'),
    markDirty: db.prepare(
      `INSERT INTO history_dirty (project_key, source_type, entity_id) VALUES (?, ?, ?)
       ON CONFLICT (project_key, source_type, entity_id) DO UPDATE SET revision = revision + 1`,
    ),
    state: db.prepare('SELECT * FROM history_index_state WHERE project_key = ?'),
    states: db.prepare('SELECT * FROM history_index_state ORDER BY project_key'),
    putState: db.prepare(
      `INSERT INTO history_index_state (project_key, version, complete, source_type, last_id)
       VALUES (@projectKey, @version, @complete, @sourceType, @lastId)
       ON CONFLICT (project_key) DO UPDATE SET version = excluded.version, complete = excluded.complete,
         source_type = excluded.source_type, last_id = excluded.last_id`,
    ),
    projectKeys: db.prepare('SELECT key FROM projects ORDER BY key'),
    taskKeyOfId: db.prepare('SELECT key FROM tasks WHERE id = ?'),
    inboxUpdatedAt: db.prepare('SELECT updated_at FROM inbox_items WHERE id = ?'),
    docStates: db.prepare('SELECT * FROM history_doc_state WHERE project_key = ? ORDER BY repo, path'),
    docState: db.prepare('SELECT * FROM history_doc_state WHERE project_key = ? AND repo = ? AND path = ?'),
    putDocState: db.prepare(
      `INSERT INTO history_doc_state (project_key, repo, path, commit_sha, checked_at, indexed_at, status)
       VALUES (@projectKey, @repo, @path, @commitSha, @checkedAt, @indexedAt, @status)
       ON CONFLICT (project_key, repo, path) DO UPDATE SET commit_sha = excluded.commit_sha,
         checked_at = excluded.checked_at, indexed_at = excluded.indexed_at, status = excluded.status`,
    ),
    deleteDocStatesOfRepo: db.prepare('DELETE FROM history_doc_state WHERE project_key = ? AND repo = ?'),
  };
  const idPages = new Map<string, Statement<unknown[]>>();
  const scans = new Map<string, Statement<unknown[]>>();

  const idPage = (type: Exclude<HistorySourceType, 'document'>) => {
    let statement = idPages.get(type);
    if (!statement) {
      const { table, filter } = BACKFILL_TABLES[type];
      statement = db.prepare(
        `SELECT id FROM ${table} WHERE project_key = ? AND id > ? AND ${filter} ORDER BY id LIMIT ?`,
      );
      idPages.set(type, statement);
    }
    return statement;
  };

  const scanOf = (query: HistoryCandidateQuery) => {
    const types = [...query.sourceTypes].sort();
    const shape = `${types.join(',')}|${query.taskKey ? 't' : ''}${query.since ? 's' : ''}${query.until ? 'u' : ''}`;
    let statement = scans.get(shape);
    if (!statement) {
      const filters = [
        'history_fts MATCH ?',
        'd.project_key = ?',
        `d.source_type IN (${types.map(() => '?').join(', ')})`,
        ...(query.taskKey ? ['d.task_key = ?'] : []),
        ...(query.since ? ['d.at >= ?'] : []),
        ...(query.until ? ['d.at <= ?'] : []),
      ];
      // The planner is told to drive the join from the full-text match: the filters narrow, they never lead.
      statement = db.prepare(
        `SELECT d.* FROM history_fts CROSS JOIN history_documents d ON d.id = history_fts.rowid
         WHERE ${filters.join(' AND ')}
         ORDER BY bm25(history_fts, 5.0, 1.0), d.at DESC, d.source_id`,
      );
      scans.set(shape, statement);
    }
    const params: unknown[] = [query.match, query.projectKey, ...types];
    if (query.taskKey) params.push(query.taskKey);
    if (query.since) params.push(query.since);
    if (query.until) params.push(query.until);
    return { statement, params };
  };

  return {
    /** Runs `fn` in one transaction (nested calls join the outer one). */
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    projectKeys(): string[] {
      return (statements.projectKeys.all() as { key: string }[]).map((row) => row.key);
    },

    /** Inserts or changes the projection of a source; an identical one is left alone (the index text does not churn). */
    upsertDocument(write: HistoryDocumentWrite): string {
      const sourceId = historySourceId(write.projectKey, write.sourceType, write.entityId);
      statements.upsert.run({
        sourceId,
        projectKey: write.projectKey,
        sourceType: write.sourceType,
        entityId: write.entityId,
        taskKey: write.taskKey,
        author: write.author,
        at: write.at,
        title: write.title,
        body: write.body,
        repo: write.repo ?? null,
        path: write.path ?? null,
        commitSha: write.commitSha ?? null,
      });
      return sourceId;
    },

    deleteDocument(projectKey: string, sourceType: HistorySourceType, entityId: string): void {
      statements.deleteOne.run(historySourceId(projectKey, sourceType, entityId));
    },

    documentOfEntity(
      projectKey: string,
      sourceType: HistorySourceType,
      entityId: string,
    ): HistoryDocumentRow | null {
      const row = statements.byEntity.get(projectKey, sourceType, entityId) as DocumentRow | undefined;
      return row ? toDocument(row) : null;
    },

    documentBySourceId(projectKey: string, sourceId: string): HistoryDocumentRow | null {
      const row = statements.bySourceId.get(sourceId, projectKey) as DocumentRow | undefined;
      return row ? toDocument(row) : null;
    },

    documentsOfRepo(projectKey: string, repo: string): HistoryDocumentRow[] {
      return (statements.documentsOfRepo.all(projectKey, repo) as DocumentRow[]).map(toDocument);
    },

    deleteRepositoryDocuments(projectKey: string, repo: string): void {
      statements.deleteDocumentsOfRepo.run(projectKey, repo);
      statements.deleteDocStatesOfRepo.run(projectKey, repo);
    },

    documentCount(projectKey: string): number {
      return (statements.countDocuments.get(projectKey) as { n: number }).n;
    },

    /**
     * The candidates of a search in rank order, lazily: a bound MATCH expression, the project, the types, the
     * card and the time. The caller reads on until it has what it needs, and decides access itself.
     */
    scan(query: HistoryCandidateQuery): IterableIterator<HistoryDocumentRow> {
      const { statement, params } = scanOf(query);
      const rows = statement.iterate(...params) as IterableIterator<DocumentRow>;
      return (function* () {
        try {
          for (const row of rows) yield toDocument(row);
        } finally {
          rows.return?.();
        }
      })();
    },

    dirty(limit: number, projectKey?: string): HistoryDirtyRow[] {
      const rows = (
        projectKey === undefined
          ? statements.dirty.all(limit)
          : statements.dirtyOfProject.all(projectKey, limit)
      ) as DirtyRow[];
      return rows.map((r) => ({
        projectKey: r.project_key,
        sourceType: r.source_type as HistorySourceType,
        entityId: r.entity_id,
        revision: r.revision,
      }));
    },

    /** Acknowledges what was processed: a source that changed again meanwhile keeps its entry. */
    ackDirty(row: HistoryDirtyRow): void {
      statements.ackDirty.run(row.projectKey, row.sourceType, row.entityId, row.revision);
    },

    dirtyCount(): number {
      return (statements.dirtyCount.get() as { n: number }).n;
    },

    markDirty(projectKey: string, sourceType: HistorySourceType, entityId: string): void {
      statements.markDirty.run(projectKey, sourceType, entityId);
    },

    indexState(projectKey: string): HistoryIndexStateRow | null {
      const row = statements.state.get(projectKey) as StateRow | undefined;
      return row ? toState(row) : null;
    },

    indexStates(): HistoryIndexStateRow[] {
      return (statements.states.all() as StateRow[]).map(toState);
    },

    putIndexState(state: HistoryIndexStateRow): void {
      statements.putState.run({ ...state, complete: state.complete ? 1 : 0 });
    },

    /** The ids of one source type of a project after `afterId`, in id order: a backfill page. */
    entityIdsAfter(
      projectKey: string,
      sourceType: Exclude<HistorySourceType, 'document'>,
      afterId: string,
      limit: number,
    ): string[] {
      return (idPage(sourceType).all(projectKey, afterId, limit) as { id: string }[]).map((row) => row.id);
    },

    taskKeyOfId(id: string): string | null {
      const row = statements.taskKeyOfId.get(id) as { key: string } | undefined;
      return row?.key ?? null;
    },

    /** The inbox row's own `updated_at`, which a question without a resolution time keeps as its time. */
    inboxUpdatedAt(id: string): string | null {
      const row = statements.inboxUpdatedAt.get(id) as { updated_at: string } | undefined;
      return row?.updated_at ?? null;
    },

    docStates(projectKey: string): HistoryDocStateRow[] {
      return (statements.docStates.all(projectKey) as DocStateRow[]).map(toDocState);
    },

    docState(projectKey: string, repo: string, path: HistoryDocPath): HistoryDocStateRow | null {
      const row = statements.docState.get(projectKey, repo, path) as DocStateRow | undefined;
      return row ? toDocState(row) : null;
    },

    putDocState(state: HistoryDocStateRow): void {
      statements.putDocState.run(state);
    },
  };
}

export type HistoryRepository = ReturnType<typeof createHistoryRepository>;
