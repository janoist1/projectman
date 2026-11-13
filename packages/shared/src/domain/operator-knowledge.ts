import { z } from 'zod';
import { MemberHandle } from './member';
import type { HumanAccess } from './member';

/** Shared agreement and principles are visible only to owners and administrators. */
export function canReadProjectManagerKnowledge({
  access,
}: {
  access: HumanAccess | 'ai' | undefined;
}): boolean {
  return access === 'owner' || access === 'admin';
}

export const ProjectManagerAgreementData = z.strictObject({
  summary: z.string().min(1).max(4000),
  involvement: z.enum(['every_step', 'important', 'minimal']),
  extraCritical: z.array(z.string().min(1).max(300)).max(20),
});
export type ProjectManagerAgreementData = z.infer<typeof ProjectManagerAgreementData>;

export const ProjectManagerPrincipleData = z.strictObject({
  id: z.string().min(1).max(64),
  example: z.string().min(1).max(1000),
  principle: z.string().min(1).max(1000),
  effect: z.string().min(1).max(1000),
});
export type ProjectManagerPrincipleData = z.infer<typeof ProjectManagerPrincipleData>;

export const ProjectManagerKnowledgeChange = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('agreement_replace'), agreement: ProjectManagerAgreementData }),
  z.strictObject({
    kind: z.literal('principle_put'),
    principle: ProjectManagerPrincipleData.extend({ id: z.string().min(1).max(64).nullable() }),
  }),
  z.strictObject({ kind: z.literal('principle_remove'), id: z.string().min(1).max(64) }),
]);
export type ProjectManagerKnowledgeChange = z.infer<typeof ProjectManagerKnowledgeChange>;

export const ProjectManagerKnowledgeDocument = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  agreement: z
    .strictObject({
      version: z.number().int().min(1),
      data: ProjectManagerAgreementData,
      approvedBy: MemberHandle,
      approvedAt: z.iso.datetime(),
    })
    .nullable(),
  principles: z
    .array(
      ProjectManagerPrincipleData.extend({
        approvedBy: MemberHandle,
        approvedAt: z.iso.datetime(),
      }),
    )
    .max(20)
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      'Duplicate principle ids',
    ),
  appliedProposalIds: z
    .array(z.string())
    .max(512)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate proposal ids'),
});
export type ProjectManagerKnowledgeDocument = z.infer<typeof ProjectManagerKnowledgeDocument>;

export const ProjectManagerPreferenceData = z.strictObject({
  length: z.enum(['brief', 'balanced', 'detailed']),
  technicalLevel: z.enum(['plain', 'mixed', 'technical']),
  detail: z.enum(['offer', 'include']),
  clarity: z.enum(['plain', 'precise']),
  background: z.enum(['minimal', 'contextual']),
});
export type ProjectManagerPreferenceData = z.infer<typeof ProjectManagerPreferenceData>;

export const DEFAULT_PROJECT_MANAGER_PREFERENCE: Readonly<ProjectManagerPreferenceData> = Object.freeze({
  length: 'brief',
  technicalLevel: 'plain',
  detail: 'offer',
  clarity: 'plain',
  background: 'minimal',
});

export const ProjectManagerPreferenceDocument = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  data: ProjectManagerPreferenceData,
  updatedAt: z.iso.datetime().nullable(),
});
export type ProjectManagerPreferenceDocument = z.infer<typeof ProjectManagerPreferenceDocument>;
