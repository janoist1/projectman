import type { FullTestCancelReason, FullTestErrorReason, FullTestStatus } from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

/** One run of the server's full test on a card's pinned commit (PM-217). */
export interface FullTestRunRecord {
  id: string;
  projectKey: string;
  taskKey: string;
  repo: string;
  branch: string;
  commit: string;
  status: FullTestStatus;
  /** `error`: why it could not run; `cancelled`: why it was dropped. */
  reason: FullTestErrorReason | FullTestCancelReason | null;
  exitCode: number | null;
  failedFiles: string[];
  durationMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface RunRow {
  id: string;
  project_key: string;
  task_key: string;
  repo: string;
  branch: string;
  commit_sha: string;
  status: FullTestStatus;
  reason: FullTestRunRecord['reason'];
  exit_code: number | null;
  failed_files: string | null;
  duration_ms: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const toRecord = (row: RunRow): FullTestRunRecord => ({
  id: row.id,
  projectKey: row.project_key,
  taskKey: row.task_key,
  repo: row.repo,
  branch: row.branch,
  commit: row.commit_sha,
  status: row.status,
  reason: row.reason,
  exitCode: row.exit_code,
  failedFiles: parseJson<string[]>(row.failed_files, []),
  durationMs: row.duration_ms,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

/** The runs of the full test: a row is made when a run is queued and updated as it goes. */
export function createFullTestRunRepository(db: Db) {
  const insert = db.prepare(
    `INSERT INTO full_test_runs (id, project_key, task_key, repo, branch, commit_sha, status, created_at)
     VALUES (@id, @projectKey, @taskKey, @repo, @branch, @commit, 'queued', @createdAt)`,
  );
  const find = db.prepare('SELECT * FROM full_test_runs WHERE id = ?');
  const forTaskCommit = db.prepare(
    'SELECT * FROM full_test_runs WHERE task_key = ? AND commit_sha = ? ORDER BY created_at DESC, rowid DESC',
  );
  const forTask = db.prepare(
    'SELECT * FROM full_test_runs WHERE task_key = ? ORDER BY created_at DESC, rowid DESC',
  );
  const byStatus = db.prepare('SELECT * FROM full_test_runs WHERE status = ? ORDER BY created_at, rowid');
  const markRunning = db.prepare("UPDATE full_test_runs SET status = 'running', started_at = ? WHERE id = ?");
  const markEnded = db.prepare(
    `UPDATE full_test_runs SET status = @status, reason = @reason, exit_code = @exitCode, failed_files = @failedFiles,
       duration_ms = @durationMs, finished_at = @finishedAt WHERE id = @id`,
  );

  return {
    queue(run: {
      id: string;
      projectKey: string;
      taskKey: string;
      repo: string;
      branch: string;
      commit: string;
      createdAt: string;
    }): void {
      insert.run(run);
    },
    get(id: string): FullTestRunRecord | null {
      const row = find.get(id) as RunRow | undefined;
      return row ? toRecord(row) : null;
    },
    /** The runs of one commit of a card, newest first. */
    forCommit(taskKey: string, commit: string): FullTestRunRecord[] {
      return (forTaskCommit.all(taskKey, commit) as RunRow[]).map(toRecord);
    },
    /** The runs made for a review pin (its commit, since it was taken), newest first. */
    forPin(pin: { taskKey: string; commit: string; pinnedAt: string }): FullTestRunRecord[] {
      return (forTaskCommit.all(pin.taskKey, pin.commit) as RunRow[])
        .map(toRecord)
        .filter((run) => run.createdAt >= pin.pinnedAt);
    },
    /** The runs of a card, newest first. */
    forTask(taskKey: string): FullTestRunRecord[] {
      return (forTask.all(taskKey) as RunRow[]).map(toRecord);
    },
    /** The runs in one status, oldest first (the queue). */
    list(status: FullTestStatus): FullTestRunRecord[] {
      return (byStatus.all(status) as RunRow[]).map(toRecord);
    },
    start(id: string, startedAt: string): void {
      markRunning.run(startedAt, id);
    },
    /** Ends a run: `passed`, `failed`, `error` or `cancelled`. */
    finish(
      id: string,
      end: {
        status: Exclude<FullTestStatus, 'queued' | 'running'>;
        reason?: FullTestRunRecord['reason'];
        exitCode?: number | null;
        failedFiles?: string[];
        durationMs?: number | null;
        finishedAt: string;
      },
    ): void {
      markEnded.run({
        id,
        status: end.status,
        reason: end.reason ?? null,
        exitCode: end.exitCode ?? null,
        failedFiles: end.failedFiles ? toJson(end.failedFiles) : null,
        durationMs: end.durationMs ?? null,
        finishedAt: end.finishedAt,
      });
    },
  };
}
