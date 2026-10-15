import type { TaskMerged, TaskMergeState } from '@projectman/shared';
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
const QUEUE_ORDER = 'prioritized_at IS NULL, prioritized_at DESC, created_at, rowid';
export function createTaskMergeRepository(db: Db) {
  const read = (sql: string, ...args: string[]) =>
    (db.prepare(sql).all(...args) as Record<string, unknown>[]).map(record);
  return {
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
