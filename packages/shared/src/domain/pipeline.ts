import { z } from 'zod';
import { DutyId } from './duty';
import { MemberHandle } from './member';
import { LabelDefinition, LabelId } from './label';
import { BoardColumnColor } from './palette';

export { BoardColumnColor, defaultBoardColumnColor } from './palette';

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

/**
 * Gate conditions: a gate on a stage must hold before a task may ENTER that stage. Every
 * condition is about labels (see ./label.ts): facts like "code review ok", "PR merged" (a system
 * label) or "release approved" (a label only humans may set, requested in the inbox).
 */
export const GateCondition = z.discriminatedUnion('type', [
  z.object({ type: z.literal('has_label'), label: LabelId }),
  z.object({ type: z.literal('lacks_label'), label: LabelId }),
]);
export type GateCondition = z.infer<typeof GateCondition>;

export const Gate = z.object({ conditions: z.array(GateCondition).min(1) });
export type Gate = z.infer<typeof Gate>;

export const BoardColumn = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  /** Display name in the project's language (config data, not source code). */
  name: z.string().min(1),
  hint: z.string().optional(),
  color: BoardColumnColor.optional(),
});
export type BoardColumn = z.infer<typeof BoardColumn>;

export const Stage = z.object({
  id: StageId,
  /** Display name in the project's language. */
  name: z.string().min(1),
  /** Short explanation of the stage, in the project's language. */
  description: z.string().optional(),
  kind: StageKind,
  /** Members (human, AI or both) who carry this stage. */
  owners: z.array(MemberHandle).optional(),
  duty: DutyId.optional(),
  gate: Gate.optional(),
  /** Board column the stage is shown in; several consecutive stages may share a column. */
  columnId: z.string(),
});
export type Stage = z.infer<typeof Stage>;

export const Pipeline = z.object({
  columns: z.array(BoardColumn).min(1),
  /** Ordered: the first stage must be a queue, the last one done. */
  stages: z.array(Stage).min(2),
  /** The project's label vocabulary: meanings and rules; gates refer to these ids. */
  labels: z.array(LabelDefinition).default([]),
});
export type Pipeline = z.infer<typeof Pipeline>;
