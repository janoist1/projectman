import type { ComputeJobRunStatus, ComputeJobRunner } from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

/** One run of a repository's compute job (PM-1148). */
export interface ComputeJobRunRecord {
  id: string;
  projectKey: string;
  repo: string;
  job: string;
  commit: string;
  runner: ComputeJobRunner;
  status: ComputeJobRunStatus;
  /** `error` and `cancelled`: why. */
  reason: string | null;
  requestedBy: string;
  taskKey: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  queuedMs: number | null;
  durationMs: number | null;
  billableMs: number | null;
  externalUrl: string | null;
  outputTail: string | null;
  outputs: { path: string; sha256: string; bytes: number }[];
  artifact: { name: string; expiresAt: string | null } | null;
}

interface RunRow {
  id: string;
  project_key: string;
  repo: string;
  job_id: string;
  commit_sha: string;
  runner: ComputeJobRunner;
  status: ComputeJobRunStatus;
  reason: string | null;
  requested_by: string;
  task_key: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  queued_ms: number | null;
  duration_ms: number | null;
  billable_ms: number | null;
  external_url: string | null;
  output_tail: string | null;
  outputs_json: string | null;
  artifact_name: string | null;
  artifact_expires_at: string | null;
}

const toRecord = (row: RunRow): ComputeJobRunRecord => ({
  id: row.id,
  projectKey: row.project_key,
  repo: row.repo,
  job: row.job_id,
  commit: row.commit_sha,
  runner: row.runner,
  status: row.status,
  reason: row.reason,
  requestedBy: row.requested_by,
  taskKey: row.task_key,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  queuedMs: row.queued_ms,
  durationMs: row.duration_ms,
  billableMs: row.billable_ms,
  externalUrl: row.external_url,
  outputTail: row.output_tail,
  outputs: parseJson<ComputeJobRunRecord['outputs']>(row.outputs_json, []),
  artifact: row.artifact_name ? { name: row.artifact_name, expiresAt: row.artifact_expires_at } : null,
});

export interface ComputeJobRunEnd {
  status: Exclude<ComputeJobRunStatus, 'queued' | 'running'>;
  reason?: string | null;
  durationMs?: number | null;
  queuedMs?: number | null;
  billableMs?: number | null;
  externalUrl?: string | null;
  outputTail?: string | null;
  outputs?: ComputeJobRunRecord['outputs'];
  artifact?: ComputeJobRunRecord['artifact'];
  finishedAt: string;
}

/** The runs of the compute jobs: a row is made when a run is queued and updated as it goes. */
export function createComputeJobRunRepository(db: Db) {
  const insert = db.prepare(
    `INSERT INTO compute_job_runs (id, project_key, repo, job_id, commit_sha, runner, status, requested_by, task_key, created_at)
     VALUES (@id, @projectKey, @repo, @job, @commit, @runner, 'queued', @requestedBy, @taskKey, @createdAt)`,
  );
  const find = db.prepare('SELECT * FROM compute_job_runs WHERE id = ?');
  const latest = db.prepare(
    `SELECT * FROM compute_job_runs WHERE project_key = ? AND repo = ? AND job_id = ? AND commit_sha = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  const listAll = db.prepare(
    `SELECT * FROM compute_job_runs WHERE project_key = @projectKey
       AND (@repo IS NULL OR repo = @repo) AND (@job IS NULL OR job_id = @job)
     ORDER BY created_at DESC, rowid DESC LIMIT @limit`,
  );
  const active = db.prepare(
    "SELECT COUNT(*) AS n FROM compute_job_runs WHERE status IN ('queued','running')",
  );
  const unfinished = db.prepare(
    "SELECT * FROM compute_job_runs WHERE status IN ('queued','running') ORDER BY created_at, rowid",
  );
  const markRunning = db.prepare(
    "UPDATE compute_job_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
  );
  const markEnded = db.prepare(
    `UPDATE compute_job_runs SET status = @status, reason = @reason, duration_ms = @durationMs, queued_ms = @queuedMs,
       billable_ms = @billableMs, external_url = @externalUrl, output_tail = @outputTail, outputs_json = @outputs,
       artifact_name = @artifactName, artifact_expires_at = @artifactExpiresAt, finished_at = @finishedAt
     WHERE id = @id AND status IN ('queued','running')`,
  );

  return {
    insert(run: {
      id: string;
      projectKey: string;
      repo: string;
      job: string;
      commit: string;
      runner: ComputeJobRunner;
      requestedBy: string;
      taskKey: string | null;
      createdAt: string;
    }): void {
      insert.run(run);
    },
    get(id: string): ComputeJobRunRecord | null {
      const row = find.get(id) as RunRow | undefined;
      return row ? toRecord(row) : null;
    },
    /** The newest run of one (project, repo, job, commit). */
    latestFor(key: {
      projectKey: string;
      repo: string;
      job: string;
      commit: string;
    }): ComputeJobRunRecord | null {
      const row = latest.get(key.projectKey, key.repo, key.job, key.commit) as RunRow | undefined;
      return row ? toRecord(row) : null;
    },
    /** The runs of a project, newest first. */
    list(projectKey: string, filter: { repo?: string; job?: string; limit: number }): ComputeJobRunRecord[] {
      return (
        listAll.all({
          projectKey,
          repo: filter.repo ?? null,
          job: filter.job ?? null,
          limit: filter.limit,
        }) as RunRow[]
      ).map(toRecord);
    },
    /** The queued and running runs of the whole installation. */
    countActive(): number {
      return (active.get() as { n: number }).n;
    },
    /** The queued and running runs of the whole installation, oldest first. */
    unfinished(): ComputeJobRunRecord[] {
      return (unfinished.all() as RunRow[]).map(toRecord);
    },
    start(id: string, startedAt: string): void {
      markRunning.run(startedAt, id);
    },
    /** Ends a queued or running run; an ended run is left as it is. */
    finish(id: string, end: ComputeJobRunEnd): void {
      markEnded.run({
        id,
        status: end.status,
        reason: end.reason ?? null,
        durationMs: end.durationMs ?? null,
        queuedMs: end.queuedMs ?? null,
        billableMs: end.billableMs ?? null,
        externalUrl: end.externalUrl ?? null,
        outputTail: end.outputTail ?? null,
        outputs: end.outputs && end.outputs.length > 0 ? toJson(end.outputs) : null,
        artifactName: end.artifact?.name ?? null,
        artifactExpiresAt: end.artifact?.expiresAt ?? null,
        finishedAt: end.finishedAt,
      });
    },
  };
}
