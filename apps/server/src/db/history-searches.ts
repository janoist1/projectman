import type { HistorySemanticStatus } from '@projectman/shared';
import type { Db } from './database';

/** One measured search (PM-787): who asked what, with which filters, and how it ended. Never a hit's text. */
interface HistorySearchRecord {
  id: string;
  at: string;
  member: string;
  projectKey: string;
  via: 'integrator' | null;
  /** The trimmed query as it was asked. */
  query: string;
  /** The validated, normalized filters as JSON. */
  filters: string;
  /** The visible hits actually returned (0..limit); null when the search failed. */
  resultCount: number | null;
  hasMore: boolean | null;
  outcome: 'ok' | 'error';
  errorCode: string | null;
  /** How the semantic part ended (PM-767); a record of a search that never asked it is `not_run`. */
  semanticStatus: HistorySemanticStatus;
  /** How long the semantic part took; null when it did not run. */
  semanticDurationMs: number | null;
}

/** The period and the member the statistics are read for; both ends are inclusive UTC ISO times. */
interface HistorySearchPeriod {
  projectKey: string;
  since: string;
  until: string;
  member?: string;
}

interface HistorySearchCursorKey {
  at: string;
  id: string;
}

interface SearchRow {
  id: string;
  at: string;
  member: string;
  project_key: string;
  via: string | null;
  query: string;
  filters: string;
  result_count: number | null;
  has_more: number | null;
  outcome: string;
  error_code: string | null;
  semantic_status: string;
  semantic_duration_ms: number | null;
}

const toRecord = (r: SearchRow): HistorySearchRecord => ({
  id: r.id,
  at: r.at,
  member: r.member,
  projectKey: r.project_key,
  via: r.via === 'integrator' ? 'integrator' : null,
  query: r.query,
  filters: r.filters,
  resultCount: r.result_count,
  hasMore: r.has_more === null ? null : r.has_more === 1,
  outcome: r.outcome === 'error' ? 'error' : 'ok',
  errorCode: r.error_code,
  semanticStatus: r.semantic_status as HistorySemanticStatus,
  semanticDurationMs: r.semantic_duration_ms,
});

/**
 * The private search log (PM-787). It is its own table, never the index: the text of a request is kept here and
 * nowhere else, and only the history service writes and reads it.
 */
export function createHistorySearchRepository(db: Db) {
  const statements = {
    insert: db.prepare(
      `INSERT INTO history_searches
         (id, at, member, project_key, via, query, filters, result_count, has_more, outcome, error_code,
          semantic_status, semantic_duration_ms)
       VALUES (@id, @at, @member, @projectKey, @via, @query, @filters, @resultCount, @hasMore, @outcome, @errorCode,
          @semanticStatus, @semanticDurationMs)`,
    ),
    purge: db.prepare('DELETE FROM history_searches WHERE at < ?'),
    failed: db.prepare(
      `SELECT COUNT(*) AS n FROM history_searches
       WHERE project_key = @projectKey AND at >= @since AND at <= @until AND outcome = 'error'
         AND (@member IS NULL OR member = @member)`,
    ),
    byMember: db.prepare(
      `SELECT member, COUNT(*) AS searches, SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS zero
       FROM history_searches
       WHERE project_key = @projectKey AND at >= @since AND at <= @until AND outcome = 'ok'
         AND (@member IS NULL OR member = @member)
       GROUP BY member ORDER BY searches DESC, member`,
    ),
    zeroResults: db.prepare(
      `SELECT * FROM history_searches
       WHERE project_key = @projectKey AND at >= @since AND at <= @until AND outcome = 'ok' AND result_count = 0
         AND (@member IS NULL OR member = @member)
         AND (@cursorAt IS NULL OR at < @cursorAt OR (at = @cursorAt AND id < @cursorId))
       ORDER BY at DESC, id DESC LIMIT @limit`,
    ),
  };

  const period = (p: HistorySearchPeriod) => ({
    projectKey: p.projectKey,
    since: p.since,
    until: p.until,
    member: p.member ?? null,
  });

  return {
    insert(record: HistorySearchRecord): void {
      statements.insert.run({
        ...record,
        hasMore: record.hasMore === null ? null : record.hasMore ? 1 : 0,
      });
    },

    /** Deletes every search older than `at` (exclusive: one made exactly at `at` stays); returns how many. */
    purgeBefore(at: string): number {
      return statements.purge.run(at).changes;
    },

    failedCount(p: HistorySearchPeriod): number {
      return (statements.failed.get(period(p)) as { n: number }).n;
    },

    /** The successful searches of each member, and those of them that found nothing. */
    byMember(p: HistorySearchPeriod): { member: string; searches: number; zeroResultSearches: number }[] {
      return (statements.byMember.all(period(p)) as { member: string; searches: number; zero: number }[]).map(
        (row) => ({ member: row.member, searches: row.searches, zeroResultSearches: row.zero }),
      );
    },

    /** The searches without a hit, the newest first, after the cursor when there is one. */
    zeroResults(p: HistorySearchPeriod, cursor: HistorySearchCursorKey | null, limit: number) {
      return (
        statements.zeroResults.all({
          ...period(p),
          cursorAt: cursor?.at ?? null,
          cursorId: cursor?.id ?? null,
          limit,
        }) as SearchRow[]
      ).map(toRecord);
    },
  };
}
