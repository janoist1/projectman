import { z } from 'zod';
import type { ProjectConfig, RepoConfig } from '../config/schema';
import { effectiveRepo, repoOf } from '../config/repos';
import { StageId } from './pipeline';
import type { Stage } from './pipeline';
import type { Task } from './task';

/** Absent: merge unless an integrating session merges (decision 40). */
export function mergesOnDone(repo: Pick<RepoConfig, 'mergeOnDone' | 'fullTestAtMerge'>): boolean {
  return repo.mergeOnDone ?? repo.fullTestAtMerge !== true;
}

export function mergeRepoOf(
  config: ProjectConfig,
  task: Pick<Task, 'repo'>,
  target: Stage,
): RepoConfig | null {
  const repo = repoOf(config, effectiveRepo(config, task));
  return target.kind === 'done' && repo && mergesOnDone(repo) ? repo : null;
}

export const MergeStep = z.enum(['queued', 'merging', 'checking', 'pushing', 'finishing']);
export const MergeBlockReason = z.enum([
  'push_rejected',
  'remote_unreachable',
  'remote_moved',
  'base_out_of_sync',
  'pull_request',
  'local_checkout',
  'check_error',
  'check_unavailable',
  'engine_unavailable',
  'gate_changed',
  'merge_error',
]);
export type MergeBlockReason = z.infer<typeof MergeBlockReason>;
export const MergeCheck = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'error']),
  runId: z.string().optional(),
  /** The approved commit's passed full test stands for the same tree. */
  reused: z.boolean().optional(),
});
export type MergeCheck = z.infer<typeof MergeCheck>;
export const TaskMergeState = z.object({
  id: z.string(),
  repo: z.string(),
  base: z.string(),
  commit: z.string(),
  branch: z.string(),
  toStageId: StageId,
  requestedBy: z.string(),
  state: z.enum(['queued', 'running', 'blocked']),
  step: MergeStep,
  startedAt: z.string(),
  mergeCommit: z.string().optional(),
  check: MergeCheck.optional(),
  landed: z.enum(['nowhere', 'remote']),
  block: z
    .object({
      reason: MergeBlockReason,
      message: z.string(),
      at: z.string(),
      detail: z.string().max(8000).optional(),
    })
    .optional(),
});
export type TaskMergeState = z.infer<typeof TaskMergeState>;
export const TaskMerged = z.object({
  mergeCommit: z.string(),
  commit: z.string(),
  repo: z.string(),
  base: z.string(),
  at: z.string(),
  by: z.string(),
  check: MergeCheck.optional(),
  pushed: z.object({ remote: z.string(), commitUrl: z.string().optional() }).optional(),
  pullRequests: z.array(z.object({ number: z.number().int(), url: z.string() })).optional(),
});
export type TaskMerged = z.infer<typeof TaskMerged>;
