import type {
  FullTestCancelReason,
  FullTestErrorReason,
  FullTestStatus,
  MergeCheckRunner,
} from '@projectman/shared';
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
  /** Where the run was asked to go (PM-909), fixed when it is queued; rows from before are engine runs. */
  runner: MergeCheckRunner;
  /** The GitHub Actions run page of a `github_actions` run, once it has one. */
  externalUrl: string | null;
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
  runner: MergeCheckRunner;
  external_url: string | null;
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
  runner: row.runner,
  externalUrl: row.external_url,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

/** The runs of the full test: a row is made when a run is queued and updated as it goes. */
export function createFullTestRunRepository(db: Db) {
  const insert = db.prepare(
    `INSERT INTO full_test_runs (id, project_key, task_key, repo, branch, commit_sha, status, runner, created_at)
     VALUES (@id, @projectKey, @taskKey, @repo, @branch, @commit, 'queued', @runner, @createdAt)`,
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
       duration_ms = @durationMs, external_url = @externalUrl, finished_at = @finishedAt WHERE id = @id`,
  );

  return {
    queue(run: {
      id: string;
      projectKey: string;
      taskKey: string;
      repo: string;
      branch: string;
      commit: string;
      /** Missing: the engine. */
      runner?: MergeCheckRunner;
      createdAt: string;
    }): void {
      insert.run({ ...run, runner: run.runner ?? 'engine' });
    },
    get(id: string): FullTestRunRecord | null {
      const row = find.get(id) as RunRow | undefined;
      return row ? toRecord(row) : null;
    },
    /** The runs of one commit of a card, newest first. */
    forCommit(taskKey: string, commit: string): FullTestRunRecord[] {
      return (forTaskCommit.all(taskKey, commit) as RunRow[]).map(toRecord);
    },
    /**
     * The runs of the pin's commit since it was taken, newest first, followed by the latest
     * earlier verdict (passed, failed or error) only when that verdict passed. With a `filter` only the
     * runs of that runner count, the earlier verdict chosen among them (PM-909): an engine pass of the same
     * commit is no GitHub Actions result.
     */
    forPin(
      pin: { taskKey: string; commit: string; pinnedAt: string },
      filter?: { runner: MergeCheckRunner },
    ): FullTestRunRecord[] {
      const runs = (forTaskCommit.all(pin.taskKey, pin.commit) as RunRow[])
        .map(toRecord)
        .filter((run) => !filter || run.runner === filter.runner);
      const current = runs.filter((run) => run.createdAt >= pin.pinnedAt);
      const previous = runs.find(
        (run) =>
          run.createdAt < pin.pinnedAt &&
          (run.status === 'passed' || run.status === 'failed' || run.status === 'error'),
      );
      return previous?.status === 'passed' ? [...current, previous] : current;
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
        externalUrl?: string | null;
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
        externalUrl: end.externalUrl ?? null,
        finishedAt: end.finishedAt,
      });
    },
  };
}
