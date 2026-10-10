import { z } from 'zod';
import { StageId } from './pipeline';
import { MemberHandle } from './member';

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
  reused: z.boolean().optional(),
});
export type MergeCheck = z.infer<typeof MergeCheck>;
export const MergeState = z.enum(['requested', 'queued', 'running', 'failed', 'blocked']);
export const MergeFailure = z.object({
  reason: z.enum(['conflict', 'check_failed']),
  at: z.string(),
  /** The commit of the default branch the merge was built onto. */
  base: z.string(),
  files: z.array(z.string()).max(50).optional(),
  command: z.string().optional(),
  runId: z.string().optional(),
  /** At most the last 40 lines. */
  outputTail: z.string().max(8000).optional(),
});
export type MergeFailure = z.infer<typeof MergeFailure>;
export const TaskMergeState = z.object({
  id: z.string(),
  repo: z.string(),
  base: z.string(),
  toStageId: StageId,
  merger: MemberHandle,
  requestedAt: z.string(),
  state: MergeState,
  step: MergeStep.optional(),
  commit: z.string().optional(),
  branch: z.string().optional(),
  startedBy: MemberHandle.optional(),
  startedAt: z.string().optional(),
  mergeCommit: z.string().optional(),
  check: MergeCheck.optional(),
  landed: z.enum(['nowhere', 'remote']),
  failure: MergeFailure.optional(),
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
  via: z.enum(['tool', 'found']),
  mergeCommit: z.string().optional(),
  commit: z.string(),
  repo: z.string(),
  base: z.string(),
  at: z.string(),
  by: MemberHandle.optional(),
  check: MergeCheck.optional(),
  pushed: z.object({ remote: z.string(), commitUrl: z.string().optional() }).optional(),
  pullRequests: z.array(z.object({ number: z.number().int(), url: z.string() })).optional(),
});
export type TaskMerged = z.infer<typeof TaskMerged>;
