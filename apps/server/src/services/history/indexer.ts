import { historySourceMeta, historySourceText, isHistoryIndexable } from '@projectman/shared';
import type { HistorySourceType } from '@projectman/shared';
import { HISTORY_INDEX_VERSION } from '../../db';
import type { HistoryDirtyRow } from '../../db';
import { loadHistorySource, normalizeAt } from './sources';
import type { HistorySourceRepos } from './sources';

/** The source types read from tables, in the order the backfill walks them. */
const TABLE_SOURCES = ['task', 'note', 'question', 'message'] as const;
type TableSource = (typeof TABLE_SOURCES)[number];

const DIRTY_BATCH = 200;

export const BACKFILL_PAGE = 500;

/**
 * Keeps the index equal to the project: it reads each changed source as it is now and writes or removes its
 * projection. It decides nothing about access. Synchronous, so no two runs ever overlap.
 */
export function createHistoryIndexer(deps: {
  repos: HistorySourceRepos;
  pageSize?: number;
  onError?: (row: HistoryDirtyRow, error: unknown) => void;
}) {
  const { repos } = deps;
  const history = repos.history;
  const pageSize = deps.pageSize ?? BACKFILL_PAGE;

  /** Brings the index copy of one source in line with the source: written when it is indexable, else removed. */
  function indexEntity(projectKey: string, type: HistorySourceType, entityId: string): void {
    if (type === 'document') return;
    const loaded = loadHistorySource(repos, projectKey, type, entityId);
    if (!loaded || !isHistoryIndexable(loaded.source)) {
      history.deleteDocument(projectKey, type, entityId);
      return;
    }
    const text = historySourceText(loaded.source);
    const meta = historySourceMeta(loaded.source, loaded.storedAt);
    history.upsertDocument({
      projectKey,
      sourceType: type,
      entityId,
      taskKey: meta.taskKey,
      author: meta.author,
      at: normalizeAt(meta.at),
      title: text.title,
      body: text.body,
    });
  }

  /** Applies the recorded source changes (of one project, or all) and acknowledges what it applied. */
  function drain(projectKey?: string): number {
    let applied = 0;
    for (;;) {
      const rows = history.dirty(DIRTY_BATCH, projectKey);
      if (rows.length === 0) return applied;
      let done = 0;
      history.transaction(() => {
        for (const row of rows) {
          try {
            indexEntity(row.projectKey, row.sourceType, row.entityId);
            history.ackDirty(row);
            done++;
          } catch (error) {
            deps.onError?.(row, error);
          }
        }
      });
      applied += done;
      // A batch of entries that all failed would come back unchanged: leave them for the next sweep.
      if (done === 0) return applied;
    }
  }

  /** The project's backfill: does it still have sources to read? */
  function needsBackfill(projectKey: string): boolean {
    const state = history.indexState(projectKey);
    return !state || !state.complete || state.version < HISTORY_INDEX_VERSION;
  }

  /**
   * Reads one page of the project's sources into the index and moves its checkpoint, then applies the changes
   * recorded meanwhile. Idempotent and resumable: a page read twice writes the same projection. Returns whether
   * the backfill of the project is complete.
   */
  function backfillStep(projectKey: string): boolean {
    if (!needsBackfill(projectKey)) return true;
    const stored = history.indexState(projectKey);
    const fresh = !stored || stored.version < HISTORY_INDEX_VERSION;
    let type: TableSource = (!fresh && (stored.sourceType as TableSource | null)) || 'task';
    let lastId = fresh ? '' : (stored.lastId ?? '');
    let complete = false;
    history.transaction(() => {
      const ids = history.entityIdsAfter(projectKey, type, lastId, pageSize);
      for (const id of ids) indexEntity(projectKey, type, id);
      if (ids.length === pageSize) {
        lastId = ids[ids.length - 1]!;
      } else {
        const next = TABLE_SOURCES[TABLE_SOURCES.indexOf(type) + 1];
        if (next) {
          type = next;
          lastId = '';
        } else complete = true;
      }
      history.putIndexState({
        projectKey,
        version: HISTORY_INDEX_VERSION,
        complete,
        sourceType: complete ? null : type,
        lastId: complete ? null : lastId,
      });
    });
    drain(projectKey);
    return complete;
  }

  /** Marks a project whose rows were never in the index as having none to read (a project made after the start). */
  function markEmptyProjectComplete(projectKey: string): void {
    history.putIndexState({
      projectKey,
      version: HISTORY_INDEX_VERSION,
      complete: true,
      sourceType: null,
      lastId: null,
    });
  }

  return { indexEntity, drain, needsBackfill, backfillStep, markEmptyProjectComplete };
}

export type HistoryIndexer = ReturnType<typeof createHistoryIndexer>;
