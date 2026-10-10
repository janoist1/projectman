import type { TaskMerged, TaskMergeState } from '@projectman/shared';
import type { Db } from './database';

export interface MergeRecord extends Omit<TaskMergeState, 'state' | 'startedAt'> {
  projectKey: string;
  taskKey: string;
  fromStageId: string;
  state: TaskMergeState['state'] | 'merged' | 'sent_back' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  pushed?: TaskMerged['pushed'];
  pullRequests?: TaskMerged['pullRequests'];
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
  requestedBy: 'requested_by',
  state: 'state',
  step: 'step',
  mergeCommit: 'merge_commit',
  check: 'check_json',
  landed: 'landed',
  block: 'block_json',
  pushed: 'pushed_json',
  pullRequests: 'pull_requests_json',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  finishedAt: 'finished_at',
} as const;
const json = new Set(['check', 'block', 'pushed', 'pullRequests']);
function record(row: Record<string, unknown>): MergeRecord {
  return Object.fromEntries(
    Object.entries(columns).flatMap(([key, column]) => {
      const value = row[column];
      return value === null ? [] : [[key, json.has(key) ? JSON.parse(value as string) : value]];
    }),
  ) as unknown as MergeRecord;
}
export function mergeState(row: MergeRecord): TaskMergeState | undefined {
  if (row.state !== 'queued' && row.state !== 'running' && row.state !== 'blocked') return undefined;
  return {
    id: row.id,
    repo: row.repo,
    base: row.base,
    commit: row.commit,
    branch: row.branch,
    toStageId: row.toStageId,
    requestedBy: row.requestedBy,
    state: row.state,
    step: row.step,
    startedAt: row.createdAt,
    landed: row.landed,
    ...(row.mergeCommit ? { mergeCommit: row.mergeCommit } : {}),
    ...(row.check ? { check: row.check } : {}),
    ...(row.block ? { block: row.block } : {}),
  };
}
export function mergedState(row: MergeRecord): TaskMerged | undefined {
  if (row.state !== 'merged' || !row.mergeCommit) return undefined;
  return {
    mergeCommit: row.mergeCommit,
    commit: row.commit,
    repo: row.repo,
    base: row.base,
    at: row.finishedAt!,
    by: row.requestedBy,
    ...(row.check ? { check: row.check } : {}),
    ...(row.pushed ? { pushed: row.pushed } : {}),
    ...(row.pullRequests ? { pullRequests: row.pullRequests } : {}),
  };
}
export function createTaskMergeRepository(db: Db) {
  const read = (sql: string, ...args: string[]) =>
    (db.prepare(sql).all(...args) as Record<string, unknown>[]).map(record);
  return {
    get(id: string) {
      return read('SELECT * FROM task_merges WHERE id = ?', id)[0] ?? null;
    },
    list(state: MergeRecord['state']) {
      return read('SELECT * FROM task_merges WHERE state = ? ORDER BY created_at, rowid', state);
    },
    open(projectKey: string, taskKey: string) {
      return (
        read(
          "SELECT * FROM task_merges WHERE project_key = ? AND task_key = ? AND state IN ('queued','running','blocked')",
          projectKey,
          taskKey,
        )[0] ?? null
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
    save(row: MergeRecord) {
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
