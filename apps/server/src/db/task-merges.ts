import type { TaskMerged, TaskMergeState } from '@projectman/shared';
import { mergeQueueOrderRefusal } from '@projectman/shared';
import { z } from 'zod';
import type { Db } from './database';
import { MergeTrainId } from './merge-trains';

const diagnostic = z.strictObject({ parentTrainId: MergeTrainId, maxCards: z.number().int().min(1).max(8) });

export interface MergeRecord extends Omit<TaskMergeState, 'state'> {
  projectKey: string;
  taskKey: string;
  fromStageId: string;
  state: TaskMergeState['state'] | 'merged' | 'cancelled';
  createdAt: string;
  /** When the merger or the Operator put the queued merge forward; cleared when the merge starts running. */
  prioritizedAt?: string;
  /** Explicit repository queue rank; old rows keep their original FIFO/priority order. */
  queueRank?: number;
  updatedAt: string;
  finishedAt?: string;
  /** Internal train membership; never exposed in the card's public merge state. */
  trainId?: string;
  diagnostic?: z.infer<typeof diagnostic>;
  pushed?: TaskMerged['pushed'];
  pullRequests?: TaskMerged['pullRequests'];
  resolution?: TaskMerged['resolution'];
}

const columns = {
  id: 'id',
  projectKey: 'project_key',
  taskKey: 'task_key',
  repo: 'repo',
  base: 'base',
  commit: 'commit',
  branch: 'branch',
  fromStageId: 'from_stage_id',
  toStageId: 'to_stage_id',
  merger: 'merger',
  requestedAt: 'requested_at',
  startedBy: 'started_by',
  startedAt: 'started_at',
  failure: 'failure_json',
  fix: 'fix_json',
  resolution: 'resolution_json',
  state: 'state',
  step: 'step',
  mergeCommit: 'merge_commit',
  check: 'check_json',
  landed: 'landed',
  block: 'block_json',
  pushed: 'pushed_json',
  pullRequests: 'pull_requests_json',
  createdAt: 'created_at',
  prioritizedAt: 'prioritized_at',
  queueRank: 'queue_rank',
  updatedAt: 'updated_at',
  finishedAt: 'finished_at',
  trainId: 'train_id',
  diagnostic: 'diagnostic_json',
} as const;
const json = new Set([
  'check',
  'block',
  'failure',
  'pushed',
  'pullRequests',
  'fix',
  'resolution',
  'diagnostic',
]);
function record(row: Record<string, unknown>): MergeRecord {
  return Object.fromEntries(
    Object.entries(columns).flatMap(([key, column]) => {
      const value = row[column];
      if (value === null) return [];
      if (key === 'trainId') return [[key, MergeTrainId.parse(value)]];
      if (key === 'diagnostic') return [[key, diagnostic.parse(JSON.parse(value as string))]];
      return [[key, json.has(key) ? JSON.parse(value as string) : value]];
    }),
  ) as unknown as MergeRecord;
}
export function mergeState(row: MergeRecord): TaskMergeState | undefined {
  if (row.state === 'merged' || row.state === 'cancelled') return undefined;
  return {
    id: row.id,
    repo: row.repo,
    base: row.base,
    commit: row.commit,
    branch: row.branch,
    toStageId: row.toStageId,
    merger: row.merger,
    requestedAt: row.requestedAt,
    startedBy: row.startedBy,
    startedAt: row.startedAt,
    failure: row.failure,
    fix: row.fix,
    state: row.state,
    step: row.step,
    landed: row.landed,
    ...(row.mergeCommit ? { mergeCommit: row.mergeCommit } : {}),
    ...(row.check ? { check: row.check } : {}),
    ...(row.block ? { block: row.block } : {}),
  };
}
export function mergedState(row: MergeRecord): TaskMerged | undefined {
  if (row.state !== 'merged' || !row.commit) return undefined;
  return {
    via: row.startedBy ? 'tool' : 'found',
    mergeCommit: row.mergeCommit,
    commit: row.commit,
    repo: row.repo,
    base: row.base,
    at: row.finishedAt!,
    by: row.startedBy,
    ...(row.check ? { check: row.check } : {}),
    ...(row.pushed ? { pushed: row.pushed } : {}),
    ...(row.pullRequests ? { pullRequests: row.pullRequests } : {}),
    ...(row.resolution ? { resolution: row.resolution } : {}),
  };
}
/** Queue order: merges put forward first (the latest decision first), then by when they were asked for. */
const QUEUE_ORDER =
  'queue_rank IS NULL, queue_rank, prioritized_at IS NULL, prioritized_at DESC, created_at, rowid';
export function createTaskMergeRepository(db: Db) {
  // A card view reads the card's open and latest merge: each statement is prepared once, not per call.
  const prepared = new Map<string, { all(...args: string[]): unknown[] }>();
  const read = (sql: string, ...args: string[]) => {
    let statement = prepared.get(sql);
    if (!statement) prepared.set(sql, (statement = db.prepare(sql)));
    return (statement.all(...args) as Record<string, unknown>[]).map(record);
  };
  const bump = (projectKey: string, repo: string) =>
    db
      .prepare(
        `INSERT INTO merge_queue_revisions (project_key, repo, revision) VALUES (?, ?, 1)
      ON CONFLICT(project_key, repo) DO UPDATE SET revision = revision + 1`,
      )
      .run(projectKey, repo);
  const queueOrder = (projectKey: string, repo: string) => ({
    revision:
      (
        db
          .prepare('SELECT revision FROM merge_queue_revisions WHERE project_key = ? AND repo = ?')
          .get(projectKey, repo) as { revision: number } | undefined
      )?.revision ?? 0,
    taskKeys: read(
      `SELECT * FROM task_merges WHERE project_key = ? AND repo = ? AND state = 'queued' ORDER BY ${QUEUE_ORDER}`,
      projectKey,
      repo,
    ).map((row) => row.taskKey),
  });
  return {
    queueOrder,
    /** The revision check and every rank write share the same SQLite transaction as enqueue/dequeue. */
    orderQueue(
      projectKey: string,
      repo: string,
      expectedRevision: number,
      taskKeys: string[],
      priority?: { taskKey: string; at: string },
    ) {
      return db.transaction(() => {
        const current = queueOrder(projectKey, repo);
        if (mergeQueueOrderRefusal(current, { expectedRevision, taskKeys })) return null;
        if (current.taskKeys.every((key, index) => key === taskKeys[index])) return current;
        const update = db.prepare(
          "UPDATE task_merges SET queue_rank = ? WHERE project_key = ? AND repo = ? AND task_key = ? AND state = 'queued'",
        );
        taskKeys.forEach((key, index) => update.run(index, projectKey, repo, key));
        if (priority)
          db.prepare(
            "UPDATE task_merges SET prioritized_at = ? WHERE project_key = ? AND repo = ? AND task_key = ? AND state = 'queued'",
          ).run(priority.at, projectKey, repo, priority.taskKey);
        bump(projectKey, repo);
        return queueOrder(projectKey, repo);
      })();
    },
    get(id: string) {
      return read('SELECT * FROM task_merges WHERE id = ?', id)[0] ?? null;
    },
    list(state: MergeRecord['state']) {
      return read(`SELECT * FROM task_merges WHERE state = ? ORDER BY ${QUEUE_ORDER}`, state);
    },
    open(projectKey: string, taskKey: string) {
      return (
        read(
          "SELECT * FROM task_merges WHERE project_key = ? AND task_key = ? AND state IN ('requested','queued','running','failed','blocked','fixing')",
          projectKey,
          taskKey,
        )[0] ?? null
      );
    },
    /** The repository's open merges that wait or failed (not the running one), in queue order. */
    waitingOf(projectKey: string, repo: string) {
      return read(
        `SELECT * FROM task_merges WHERE project_key = ? AND repo = ? AND state IN ('requested','queued','failed','blocked','fixing') ORDER BY ${QUEUE_ORDER}`,
        projectKey,
        repo,
      );
    },
    latestMerged(projectKey: string, taskKey: string) {
      return (
        read(
          "SELECT * FROM task_merges WHERE project_key = ? AND task_key = ? AND state = 'merged' ORDER BY finished_at DESC, rowid DESC LIMIT 1",
          projectKey,
          taskKey,
        )[0] ?? null
      );
    },
    /** Every card of the repository that was merged, oldest first (the commits a release can be made of). */
    mergedOf(projectKey: string, repo: string) {
      return read(
        "SELECT * FROM task_merges WHERE project_key = ? AND repo = ? AND state = 'merged' ORDER BY finished_at, rowid",
        projectKey,
        repo,
      );
    },
    save(row: MergeRecord) {
      return db.transaction(() => {
        const previous = db
          .prepare(
            'SELECT state, queue_rank AS queueRank, prioritized_at AS prioritizedAt FROM task_merges WHERE id = ?',
          )
          .get(row.id) as
          { state: MergeRecord['state']; queueRank: number | null; prioritizedAt: string | null } | undefined;
        if (row.state === 'queued' && previous?.state !== 'queued') {
          const rank = db
            .prepare(
              "SELECT MAX(queue_rank) AS rank FROM task_merges WHERE project_key = ? AND repo = ? AND state = 'queued'",
            )
            .get(row.projectKey, row.repo) as { rank: number | null };
          row = { ...row, queueRank: rank.rank === null ? undefined : rank.rank + 1 };
        } else if (row.state === 'queued' && previous?.state === 'queued') {
          // Only orderQueue changes an existing queue rank; a caller may hold a pre-reorder snapshot.
          row = { ...row, queueRank: previous.queueRank ?? undefined };
        }
        if (row.trainId !== undefined) MergeTrainId.parse(row.trainId);
        if (row.diagnostic !== undefined) diagnostic.parse(row.diagnostic);
        const entries = Object.entries(columns);
        db.prepare(
          `INSERT INTO task_merges (${entries.map(([, col]) => `"${col}"`).join(',')}) VALUES (${entries.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${entries
            .filter(([key]) => key !== 'id')
            .map(([, col]) => `"${col}" = excluded."${col}"`)
            .join(',')}`,
        ).run(
          ...entries.map(([key]) => {
            const value = row[key as keyof MergeRecord];
            return value === undefined ? null : json.has(key) ? JSON.stringify(value) : value;
          }),
        );
        if (
          (previous?.state === 'queued' || row.state === 'queued') &&
          (previous?.state !== row.state ||
            (previous?.prioritizedAt ?? undefined) !== row.prioritizedAt ||
            (previous?.queueRank ?? undefined) !== row.queueRank)
        )
          bump(row.projectKey, row.repo);
      })();
    },
  };
}

export function createTaskHandoverRepository(db: Db) {
  return {
    get(projectKey: string, taskKey: string): { commit: string; branch: string } | null {
      return (
        (db
          .prepare('SELECT "commit", branch FROM task_handovers WHERE project_key = ? AND task_key = ?')
          .get(projectKey, taskKey) as { commit: string; branch: string } | undefined) ?? null
      );
    },
    save(input: {
      projectKey: string;
      taskKey: string;
      commit: string;
      branch: string;
      stageId: string;
      at: string;
    }) {
      db.prepare(
        'INSERT INTO task_handovers VALUES (@projectKey,@taskKey,@commit,@branch,@stageId,@at) ON CONFLICT(project_key,task_key) DO UPDATE SET "commit"=excluded."commit", branch=excluded.branch, stage_id=excluded.stage_id, at=excluded.at',
      ).run(input);
    },
  };
}
