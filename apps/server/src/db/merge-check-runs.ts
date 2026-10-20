import { MergeTestReport } from '@projectman/shared';
import type { MergeCheckRun, MergeCheckRunKind, MergeCheckRunStatus } from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

interface RunRow {
  id: string;
  project_key: string;
  repo: string;
  kind: MergeCheckRunKind;
  train_id: string | null;
  commit_sha: string;
  base: string | null;
  status: MergeCheckRunStatus;
  reason: string | null;
  max_workers: number;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  report_json: string | null;
}

/** What a merge check records when it is asked for. */
export type MergeCheckRunStart = Pick<
  MergeCheckRun,
  | 'id'
  | 'projectKey'
  | 'repo'
  | 'kind'
  | 'trainId'
  | 'taskKeys'
  | 'commit'
  | 'base'
  | 'maxWorkers'
  | 'requestedAt'
>;

export interface MergeCheckRunEnd {
  status: Exclude<MergeCheckRunStatus, 'running'>;
  reason: string | null;
  durationMs: number | null;
  report: MergeCheckRun['report'];
  finishedAt: string;
}

export interface MergeCheckRunQuery {
  projectKey: string;
  /** Only the runs that checked this card. */
  taskKey?: string;
  /** `not_passed`: failed, error, cancelled and still running. */
  outcome?: 'passed' | 'not_passed';
  kinds?: readonly MergeCheckRunKind[];
  /** ISO timestamps (UTC, as stored) bounding `requestedAt`: `since` inclusive, `until` exclusive. */
  since?: string;
  until?: string;
  limit: number;
  offset?: number;
}

/** A report that does not parse is unknown (null), never an error: old and foreign rows may differ. */
function readReport(text: string | null): MergeCheckRun['report'] {
  const parsed = MergeTestReport.safeParse(parseJson<unknown>(text, null));
  return parsed.success ? parsed.data : null;
}

/** The merge checks (PM-876): the hub's record of every full-test run of a merge, a train and a diagnosis. */
export function createMergeCheckRunRepository(db: Db) {
  const insert = db.prepare(
    `INSERT INTO merge_check_runs (id, project_key, repo, kind, train_id, commit_sha, base, status, max_workers, requested_at)
     VALUES (@id, @projectKey, @repo, @kind, @trainId, @commit, @base, 'running', @maxWorkers, @requestedAt)`,
  );
  const insertTask = db.prepare(
    'INSERT INTO merge_check_run_tasks (run_id, task_key, position) VALUES (?, ?, ?)',
  );
  const markStarted = db.prepare('UPDATE merge_check_runs SET started_at = ? WHERE id = ? AND started_at IS NULL');
  const markEnded = db.prepare(
    `UPDATE merge_check_runs SET status = @status, reason = @reason, duration_ms = @durationMs,
       report_json = @report, finished_at = @finishedAt WHERE id = @id`,
  );
  const interrupt = db.prepare(
    `UPDATE merge_check_runs SET status = 'cancelled', reason = 'interrupted', finished_at = ?
     WHERE status = 'running'`,
  );
  const find = db.prepare('SELECT * FROM merge_check_runs WHERE id = ?');

  const tasksOf = (ids: readonly string[]): Map<string, string[]> => {
    const byRun = new Map<string, string[]>();
    if (ids.length === 0) return byRun;
    const rows = db
      .prepare(
        `SELECT run_id, task_key FROM merge_check_run_tasks WHERE run_id IN (${ids.map(() => '?').join(',')})
         ORDER BY run_id, position`,
      )
      .all(...ids) as Array<{ run_id: string; task_key: string }>;
    for (const row of rows) byRun.set(row.run_id, [...(byRun.get(row.run_id) ?? []), row.task_key]);
    return byRun;
  };

  const toRun = (row: RunRow, tasks: Map<string, string[]>): MergeCheckRun => ({
    id: row.id,
    projectKey: row.project_key,
    repo: row.repo,
    kind: row.kind,
    trainId: row.train_id,
    taskKeys: tasks.get(row.id) ?? [],
    commit: row.commit_sha,
    base: row.base,
    status: row.status,
    reason: row.reason,
    maxWorkers: row.max_workers,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    report: readReport(row.report_json),
  });

  return {
    start(run: MergeCheckRunStart): void {
      db.transaction(() => {
        insert.run(run);
        run.taskKeys.forEach((taskKey, position) => insertTask.run(run.id, taskKey, position));
      })();
    },
    /** The run's turn in the heavy-run queue has come. */
    markStarted(id: string, at: string): void {
      markStarted.run(at, id);
    },
    finish(id: string, end: MergeCheckRunEnd): void {
      markEnded.run({
        id,
        status: end.status,
        reason: end.reason,
        durationMs: end.durationMs,
        report: end.report === null ? null : toJson(end.report),
        finishedAt: end.finishedAt,
      });
    },
    /** At the hub's start: a run still `running` lost its hub; the recovery runs a new check. */
    interruptRunning(at: string): void {
      interrupt.run(at);
    },
    get(id: string): MergeCheckRun | null {
      const row = find.get(id) as RunRow | undefined;
      return row ? toRun(row, tasksOf([id])) : null;
    },
    /** Newest first (`requested_at`, then insertion order); `hasMore` tells whether older rows match. */
    list(query: MergeCheckRunQuery): { runs: MergeCheckRun[]; hasMore: boolean } {
      const where = ['project_key = @projectKey'];
      const params: Record<string, string | number> = { projectKey: query.projectKey };
      if (query.taskKey !== undefined) {
        where.push('id IN (SELECT run_id FROM merge_check_run_tasks WHERE task_key = @taskKey)');
        params.taskKey = query.taskKey;
      }
      if (query.outcome === 'passed') where.push("status = 'passed'");
      if (query.outcome === 'not_passed') where.push("status <> 'passed'");
      if (query.kinds) {
        const names = query.kinds.map((kind, index) => {
          params[`kind${index}`] = kind;
          return `@kind${index}`;
        });
        where.push(names.length ? `kind IN (${names.join(',')})` : '0');
      }
      if (query.since !== undefined) {
        where.push('requested_at >= @since');
        params.since = query.since;
      }
      if (query.until !== undefined) {
        where.push('requested_at < @until');
        params.until = query.until;
      }
      params.limit = query.limit + 1;
      params.offset = query.offset ?? 0;
      const rows = db
        .prepare(
          `SELECT * FROM merge_check_runs WHERE ${where.join(' AND ')}
           ORDER BY requested_at DESC, rowid DESC LIMIT @limit OFFSET @offset`,
        )
        .all(params) as RunRow[];
      const page = rows.slice(0, query.limit);
      const tasks = tasksOf(page.map((row) => row.id));
      return { runs: page.map((row) => toRun(row, tasks)), hasMore: rows.length > query.limit };
    },
  };
}
