import { z } from 'zod';
import { MemberHandle } from './member';

export const StageId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export type StageId = z.infer<typeof StageId>;

/**
 * What kind of work happens in a stage. The kind drives default behaviour
 * (who gets notified, which checks apply); names are free text per project.
 */
export const StageKind = z.enum([
  'queue',
  'work',
  'review',
  'deploy',
  'test',
  'client_test',
  'merge',
  'release',
  'done',
]);
export type StageKind = z.infer<typeof StageKind>;

/** Named checks recorded on a task while it moves through the pipeline. */
export const CheckName = z.enum(['code_review', 'security_review', 'qa', 'client_test']);
export type CheckName = z.infer<typeof CheckName>;

export const CheckState = z.enum(['pending', 'passed', 'blocked', 'failed', 'retest_needed']);
export type CheckState = z.infer<typeof CheckState>;

/**
 * Gate conditions come from a fixed catalogue. Anything that customises the
 * pipeline (humans or the system agent) may only combine these.
 * A gate on a stage must be satisfied before a task may ENTER that stage.
 */
export const GateCondition = z.discriminatedUnion('type', [
  z.object({ type: z.literal('check_passed'), check: CheckName }),
  z.object({ type: z.literal('pr_merged') }),
  /** Approvers must be human members; delegating the release gate is an owner-only change. */
  z.object({ type: z.literal('human_approval'), approvers: z.array(MemberHandle).min(1) }),
]);
export type GateCondition = z.infer<typeof GateCondition>;

export const Gate = z.object({ conditions: z.array(GateCondition).min(1) });
export type Gate = z.infer<typeof Gate>;

export const BoardColumn = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  /** Display name in the project's language (config data, not source code). */
  name: z.string().min(1),
  hint: z.string().optional(),
});
export type BoardColumn = z.infer<typeof BoardColumn>;

export const Stage = z.object({
  id: StageId,
  /** Display name in the project's language. */
  name: z.string().min(1),
  kind: StageKind,
  /** Members (human, AI or both) who carry this stage. */
  owners: z.array(MemberHandle),
  gate: Gate.optional(),
  /** Board column the stage is shown in; several consecutive stages may share a column. */
  columnId: z.string(),
});
export type Stage = z.infer<typeof Stage>;

export const Pipeline = z.object({
  columns: z.array(BoardColumn).min(1),
  /** Ordered: the first stage must be a queue, the last one done. */
  stages: z.array(Stage).min(2),
});
export type Pipeline = z.infer<typeof Pipeline>;
