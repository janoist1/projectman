import { z } from 'zod';
import { MemberHandle } from './member';

export const OperatorAgreementData = z.strictObject({
  summary: z.string().min(1).max(4000),
  involvement: z.enum(['every_step', 'important', 'minimal']),
  extraCritical: z.array(z.string().min(1).max(300)).max(20),
});
export type OperatorAgreementData = z.infer<typeof OperatorAgreementData>;

export const OperatorPrincipleData = z.strictObject({
  id: z.string().min(1).max(64),
  example: z.string().min(1).max(1000),
  principle: z.string().min(1).max(1000),
  effect: z.string().min(1).max(1000),
});
export type OperatorPrincipleData = z.infer<typeof OperatorPrincipleData>;

export const OperatorKnowledgeDocument = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  agreement: z
    .strictObject({
      version: z.number().int().min(1),
      data: OperatorAgreementData,
      approvedBy: MemberHandle,
      approvedAt: z.iso.datetime(),
    })
    .nullable(),
  principles: z
    .array(
      OperatorPrincipleData.extend({
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
export type OperatorKnowledgeDocument = z.infer<typeof OperatorKnowledgeDocument>;

export const OperatorPreferenceData = z.strictObject({
  length: z.enum(['brief', 'balanced', 'detailed']),
  technicalLevel: z.enum(['plain', 'mixed', 'technical']),
  detail: z.enum(['offer', 'include']),
  clarity: z.enum(['plain', 'precise']),
  background: z.enum(['minimal', 'contextual']),
});
export type OperatorPreferenceData = z.infer<typeof OperatorPreferenceData>;

export const DEFAULT_OPERATOR_PREFERENCE: Readonly<OperatorPreferenceData> = Object.freeze({
  length: 'brief',
  technicalLevel: 'plain',
  detail: 'offer',
  clarity: 'plain',
  background: 'minimal',
});

export const OperatorPreferenceDocument = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  data: OperatorPreferenceData,
  updatedAt: z.iso.datetime().nullable(),
});
export type OperatorPreferenceDocument = z.infer<typeof OperatorPreferenceDocument>;
