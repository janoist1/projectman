import { z } from 'zod';
import type { ProjectConfig } from '../config/schema';
import { dutyMembers, isCodeReviewStage } from '../config/duties';
import { unresolvedMerger } from '../config/merger';
import { itemProgress } from './item-state';
import type { ItemState } from './item-state';
import { MemberHandle } from './member';

export const MAX_CHECKLIST_ITEMS = 40;
export const CHECKLIST_ITEM_STATES = ['open', 'done', 'not_needed'] as const satisfies readonly ItemState[];
export const CHECKLIST_CONDITIONS = [
  'reviewer_member',
  'review_stage',
  'qa_member',
  'merger_resolves',
  'client_member',
  'feedback_surface',
  'agreement_approved',
  'task_exists',
  'engine_connected',
] as const;
export const ChecklistCondition = z.enum(CHECKLIST_CONDITIONS);
export type ChecklistCondition = z.infer<typeof ChecklistCondition>;

export function checklistConditionHolds(
  condition: ChecklistCondition,
  config: ProjectConfig,
  facts: { agreementApproved: boolean; taskCount: number; engineConnected: boolean },
): boolean {
  switch (condition) {
    case 'reviewer_member':
      return dutyMembers(config, 'code_review').length > 0;
    case 'review_stage':
      return (
        config.pipeline.stages.some((stage) => isCodeReviewStage(config, stage)) &&
        config.pipeline.stages.some((stage) =>
          stage.gate?.conditions.some((c) => c.type === 'has_label' && c.label === 'code-review-ok'),
        )
      );
    case 'qa_member':
      return dutyMembers(config, 'testing_acceptance').length > 0;
    case 'merger_resolves':
      return unresolvedMerger(config) === null;
    case 'client_member':
      return config.team.members.some((m) => m.kind === 'human' && m.access === 'client');
    case 'feedback_surface':
      return (config.project.feedback?.surfaces.length ?? 0) > 0;
    case 'agreement_approved':
      return facts.agreementApproved;
    case 'task_exists':
      return facts.taskCount > 0;
    case 'engine_connected':
      return facts.engineConnected;
  }
}

export function checklistProgress(items: readonly { state: (typeof CHECKLIST_ITEM_STATES)[number] }[]) {
  return itemProgress(items);
}

export const ChecklistItem = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    title: z.string().min(1).max(120),
    hint: z.string().max(500).nullable(),
    source: z.enum(['base', 'template', 'operator']),
    templateId: z.string().nullable(),
    condition: ChecklistCondition.nullable(),
    conditionHolds: z.boolean().nullable(),
    state: z.enum(CHECKLIST_ITEM_STATES),
    reason: z.string().max(500).nullable(),
    reopened: z.enum(['condition', 'owner']).nullable(),
    updatedAt: z.iso.datetime(),
    updatedBy: z.union([MemberHandle, z.literal('system')]),
  })
  .refine((item) => item.state !== 'not_needed' || !!item.reason?.trim(), 'Reason required');
export type ChecklistItem = z.infer<typeof ChecklistItem>;
export const ProjectChecklist = z.object({
  baseTemplateId: z.string().nullable(),
  items: z.array(ChecklistItem).max(MAX_CHECKLIST_ITEMS),
  progress: z.object({
    settled: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    complete: z.boolean(),
  }),
});
export type ProjectChecklist = z.infer<typeof ProjectChecklist>;
export const ProjectChecklistView = z.object({
  checklist: ProjectChecklist.nullable(),
  canEdit: z.boolean(),
});
export type ProjectChecklistView = z.infer<typeof ProjectChecklistView>;
export const SetChecklistItemStateRequest = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open') }),
  z.object({ state: z.literal('not_needed'), reason: z.string().trim().min(1).max(500) }),
]);
export type SetChecklistItemStateRequest = z.infer<typeof SetChecklistItemStateRequest>;
