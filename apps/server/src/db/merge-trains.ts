import {
  EngineId,
  isCommitId,
  isMergeId,
  isPlainBranchName,
  MemberHandle,
  MergeCheck,
  MergeStep,
  ProjectConfig,
  RepoConfig,
  ReviewTestConfig,
  TaskKey,
} from '@projectman/shared';
import { z } from 'zod';
import type { Db } from './database';

const mergeId = z.string().refine(isMergeId, 'Invalid merge id');
export const MergeTrainId = mergeId.refine((id) => id.startsWith('mrg_'), 'Invalid train id');
const commit = z.string().refine(isCommitId, 'Invalid commit id');
const branch = z.string().refine(isPlainBranchName, 'Invalid branch name');
const timestamp = z.iso.datetime({ offset: true });
const member = z.strictObject({
  mergeId,
  taskKey: TaskKey,
  commit,
  branch,
  startedBy: MemberHandle,
  startedAt: timestamp,
  prioritizedAt: timestamp.optional(),
});

/** Ordered source and attribution snapshot, including the queue priority before reservation. */
export type MergeTrainMember = z.infer<typeof member>;

const manifest = z.strictObject({
  id: MergeTrainId,
  projectKey: ProjectConfig.shape.project.shape.key,
  repo: RepoConfig.shape.name,
  base: branch,
  engineId: EngineId,
  reviewTest: ReviewTestConfig,
  members: z
    .array(member)
    .min(2)
    .max(8)
    .superRefine((members, ctx) => {
      for (const field of ['mergeId', 'taskKey'] as const) {
        if (new Set(members.map((item) => item[field])).size !== members.length)
          ctx.addIssue({ code: 'custom', message: `Duplicate member ${field}` });
      }
    }),
  state: z.enum(['running', 'merged', 'failed', 'blocked', 'cancelled']),
  step: MergeStep,
  landed: z.enum(['nowhere', 'remote', 'local']),
  localFrom: commit.optional(),
  onto: commit.optional(),
  candidate: commit.optional(),
  check: MergeCheck.optional(),
  parentTrainId: MergeTrainId.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  finishedAt: timestamp.optional(),
});

/** Durable server-side manifest; it does not change the card's public merge state. */
export type MergeTrainRecord = z.infer<typeof manifest>;

interface TrainRow {
  id: string;
  project_key: string;
  repo: string;
  state: string;
  record_json: string;
}

function decode(row: TrainRow): MergeTrainRecord {
  const record = manifest.parse(JSON.parse(row.record_json));
  if (
    record.id !== row.id ||
    record.projectKey !== row.project_key ||
    record.repo !== row.repo ||
    record.state !== row.state
  )
    throw new Error('Merge train SQL fields do not match its manifest');
  return record;
}

export function createMergeTrainRepository(db: Db) {
  const get = db.prepare('SELECT * FROM merge_trains WHERE id = ?');
  const running = db.prepare("SELECT * FROM merge_trains WHERE state = 'running' ORDER BY rowid");
  const save = db.prepare(`INSERT INTO merge_trains (id, project_key, repo, state, record_json)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
    project_key = excluded.project_key, repo = excluded.repo, state = excluded.state,
    record_json = excluded.record_json`);
  return {
    get(id: string): MergeTrainRecord | null {
      const row = get.get(id) as TrainRow | undefined;
      return row ? decode(row) : null;
    },
    listRunning(): MergeTrainRecord[] {
      return (running.all() as TrainRow[]).map(decode);
    },
    save(record: MergeTrainRecord): void {
      const parsed = manifest.parse(record);
      // The validation and the write share the caller's unit of work, or their own transaction.
      db.transaction(() => {
        const row = get.get(parsed.id) as TrainRow | undefined;
        if (!row) {
          if (parsed.state !== 'running' || parsed.step !== 'merging' || parsed.landed !== 'nowhere')
            throw new Error('A new merge train must start running, merging and landed nowhere');
        } else {
          const previous = decode(row);
          if (
            previous.members.length !== parsed.members.length ||
            previous.members.some(
              (item, i) =>
                item.mergeId !== parsed.members[i]!.mergeId || item.taskKey !== parsed.members[i]!.taskKey,
            )
          )
            throw new Error('Merge train member order is immutable');
        }
        save.run(parsed.id, parsed.projectKey, parsed.repo, parsed.state, JSON.stringify(parsed));
      })();
    },
  };
}
