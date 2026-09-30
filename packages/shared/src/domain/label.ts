import { z } from 'zod';
import { DutyId } from './duty';
import { MemberHandle } from './member';
import { BoardColumnColor } from './palette';

/**
 * Labels are the one way to state facts about a task ("code review ok", "waiting for an
 * answer", "release approved"). A project defines what its labels mean; gates require labels to
 * be present or absent. Labels without a definition are allowed as plain tags.
 * See docs/design/labels.md.
 */
export const LabelId = z.string().trim().min(1).max(40);
export type LabelId = z.infer<typeof LabelId>;

export const LabelColor = BoardColumnColor;
export type LabelColor = z.infer<typeof LabelColor>;

/**
 * Who may add or remove a label: anyone, humans only, the system only (integrations such as
 * GitHub), or the holders of duties / listed members (optionally humans among them only).
 */
export const LabelSetBy = z.union([
  z.enum(['anyone', 'humans', 'system']),
  z
    .object({
      duties: z.array(DutyId).optional(),
      members: z.array(MemberHandle).optional(),
      humansOnly: z.boolean().optional(),
    })
    .strict()
    .refine((s) => (s.duties?.length ?? 0) + (s.members?.length ?? 0) > 0, 'duties or members required'),
]);
export type LabelSetBy = z.infer<typeof LabelSetBy>;

/** Events that remove a label automatically: the task moves back, or its pull request changes. */
export const LabelClearTrigger = z.enum(['moved_back', 'pr_updated']);
export type LabelClearTrigger = z.infer<typeof LabelClearTrigger>;

export const LabelDefinition = z.object({
  id: LabelId,
  /** Display name in the project's language. */
  name: z.string().trim().min(1).max(60),
  color: LabelColor.optional(),
  /** What the label means, in the project's language; shown to humans and given to AI members. */
  meaning: z.string().trim().max(500).optional(),
  /** Labels of one group exclude each other: adding one removes the others (a "state"). */
  group: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,39}$/)
    .optional(),
  setBy: LabelSetBy.default('anyone'),
  /** The task's assignee and pull request authors may not set it (no self-review). */
  notByAuthor: z.boolean().optional(),
  /** Adding it requires a comment with the reason, in the same action. */
  requiresComment: z.boolean().optional(),
  /** Adding it notifies the task's assignee (e.g. "QA: failed"). */
  notifyAssignee: z.boolean().optional(),
  clearedWhen: z.array(LabelClearTrigger).optional(),
  /** While on the task, the task may not move forward. */
  blocks: z.boolean().optional(),
});
export type LabelDefinition = z.infer<typeof LabelDefinition>;

/** Id of the system label the GitHub integration keeps on tasks whose pull requests are merged. */
export const PR_MERGED_LABEL = 'pr-merged';

/** Labels only humans may set: the ones that stand for approvals and decisions. */
export function isHumanOnlyLabel(label: Pick<LabelDefinition, 'setBy'>): boolean {
  return label.setBy === 'humans' || (typeof label.setBy === 'object' && label.setBy.humansOnly === true);
}

/** Why an actor may not add or remove a label. */
export const LabelRefusal = z.enum(['system_only', 'humans_only', 'not_holder', 'self_review']);
export type LabelRefusal = z.infer<typeof LabelRefusal>;

/**
 * Why labels changed without anyone picking them (`task_labels_changed.reason`): a clear
 * trigger fired (the task moved back, its pull request changed), the pull request was merged,
 * or an approver's decision put an approval label on.
 */
export const LabelChangeReason = z.enum([...LabelClearTrigger.options, 'pr_merged', 'approval']);
export type LabelChangeReason = z.infer<typeof LabelChangeReason>;
