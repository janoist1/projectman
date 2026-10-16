import { describe, expect, it } from 'vitest';
import {
  canReadOperatorKnowledge,
  DEFAULT_OPERATOR_PREFERENCE,
  OperatorAgreementData,
  OperatorKnowledgeChange,
  OperatorKnowledgeDocument,
  OperatorPreferenceData,
  OperatorPreferenceDocument,
  OperatorPrincipleData,
} from './operator-knowledge';

it('allows only owners and administrators to read shared knowledge', () => {
  for (const access of ['owner', 'admin'] as const) expect(canReadOperatorKnowledge({ access })).toBe(true);
  for (const access of ['developer', 'viewer', 'client', 'ai', undefined] as const)
    expect(canReadOperatorKnowledge({ access })).toBe(false);
});

const agreement = { summary: 'Agreed scope', involvement: 'important', extraCritical: [] };
const principle = { id: 'principle-1', example: 'Example', principle: 'Principle', effect: 'Effect' };
const approval = { approvedBy: 'owner', approvedAt: '2026-10-14T12:00:00.000Z' };
const knowledge = {
  schemaVersion: 1,
  revision: 0,
  agreement: { version: 1, data: agreement, ...approval },
  principles: [{ ...principle, ...approval }],
  appliedProposalIds: [],
};
const preference = { schemaVersion: 1, revision: 0, data: DEFAULT_OPERATOR_PREFERENCE, updatedAt: null };

describe('operator knowledge schemas', () => {
  it('accepts only strict knowledge changes and permits a server-generated principle id', () => {
    const changes = [
      { kind: 'agreement_replace', agreement },
      { kind: 'principle_put', principle: { ...principle, id: null } },
      { kind: 'principle_remove', id: 'principle-1' },
    ];
    for (const change of changes) {
      expect(OperatorKnowledgeChange.safeParse(change).success).toBe(true);
      expect(OperatorKnowledgeChange.safeParse({ ...change, approvedBy: 'owner' }).success).toBe(false);
    }
    expect(
      OperatorKnowledgeChange.safeParse({ kind: 'principle_put', principle: { ...principle, id: '' } })
        .success,
    ).toBe(false);
    expect(
      OperatorKnowledgeChange.safeParse({
        kind: 'principle_put',
        principle: { ...principle, permissionMode: 'auto' },
      }).success,
    ).toBe(false);
  });
  it('keeps every object strict and excludes executable settings and free-text preferences', () => {
    for (const [schema, data] of [
      [OperatorAgreementData, agreement],
      [OperatorPrincipleData, principle],
      [OperatorPreferenceData, DEFAULT_OPERATOR_PREFERENCE],
      [OperatorKnowledgeDocument, knowledge],
      [OperatorPreferenceDocument, preference],
    ] as const) {
      expect(schema.safeParse(data).success).toBe(true);
      expect(schema.safeParse({ ...data, cardMover: 'owner' }).success).toBe(false);
    }
    expect(
      OperatorKnowledgeDocument.safeParse({
        ...knowledge,
        agreement: { ...knowledge.agreement, operatorWatch: true },
      }).success,
    ).toBe(false);
    expect(
      OperatorKnowledgeDocument.safeParse({
        ...knowledge,
        principles: [{ ...principle, ...approval, extra: true }],
      }).success,
    ).toBe(false);
    expect(
      OperatorPreferenceDocument.safeParse({
        ...preference,
        data: { ...DEFAULT_OPERATOR_PREFERENCE, text: 'Any text' },
      }).success,
    ).toBe(false);
  });
  it('enforces agreement string and list limits', () => {
    expect(
      OperatorAgreementData.safeParse({
        ...agreement,
        summary: 's'.repeat(4000),
        extraCritical: Array(20).fill('s'.repeat(300)),
      }).success,
    ).toBe(true);
    for (const patch of [
      { summary: '' },
      { summary: 's'.repeat(4001) },
      { extraCritical: [''] },
      { extraCritical: ['s'.repeat(301)] },
      { extraCritical: Array(21).fill('step') },
      { involvement: 'automatic' },
    ]) {
      expect(OperatorAgreementData.safeParse({ ...agreement, ...patch }).success).toBe(false);
    }
    for (const involvement of ['every_step', 'important', 'minimal'])
      expect(OperatorAgreementData.safeParse({ ...agreement, involvement }).success).toBe(true);
  });
  it.each(['id', 'example', 'principle', 'effect'] as const)('enforces %s string limits', (field) => {
    const max = field === 'id' ? 64 : 1000;
    expect(OperatorPrincipleData.safeParse({ ...principle, [field]: 's'.repeat(max) }).success).toBe(true);
    for (const value of ['', 's'.repeat(max + 1)])
      expect(OperatorPrincipleData.safeParse({ ...principle, [field]: value }).success).toBe(false);
  });
  it('enforces principle count, unique ids and marker limits', () => {
    const principles = Array.from({ length: 20 }, (_, i) => ({ ...principle, ...approval, id: `id-${i}` }));
    expect(
      OperatorKnowledgeDocument.safeParse({
        ...knowledge,
        principles,
        appliedProposalIds: Array.from({ length: 512 }, (_, i) => `${i}`),
      }).success,
    ).toBe(true);
    for (const patch of [
      { principles: [...principles, { ...principle, ...approval }] },
      { principles: [principles[0], principles[0]] },
      { appliedProposalIds: ['same', 'same'] },
      { appliedProposalIds: Array.from({ length: 513 }, (_, i) => `${i}`) },
    ]) {
      expect(OperatorKnowledgeDocument.safeParse({ ...knowledge, ...patch }).success).toBe(false);
    }
  });
  it('validates versions, revisions, approval identity and timestamps', () => {
    for (const revision of [-1, 0.5, Infinity]) {
      expect(OperatorKnowledgeDocument.safeParse({ ...knowledge, revision }).success).toBe(false);
      expect(OperatorPreferenceDocument.safeParse({ ...preference, revision }).success).toBe(false);
    }
    expect(OperatorKnowledgeDocument.safeParse({ ...knowledge, schemaVersion: 2 }).success).toBe(false);
    expect(OperatorPreferenceDocument.safeParse({ ...preference, schemaVersion: 2 }).success).toBe(false);
    for (const patch of [
      { version: 0 },
      { version: 1.5 },
      { approvedBy: '../owner' },
      { approvedAt: 'yesterday' },
    ])
      expect(
        OperatorKnowledgeDocument.safeParse({ ...knowledge, agreement: { ...knowledge.agreement, ...patch } })
          .success,
      ).toBe(false);
    for (const patch of [{ approvedBy: 'OWNER' }, { approvedAt: '2026-99-99T00:00:00Z' }])
      expect(
        OperatorKnowledgeDocument.safeParse({
          ...knowledge,
          principles: [{ ...principle, ...approval, ...patch }],
        }).success,
      ).toBe(false);
    expect(OperatorPreferenceDocument.safeParse({ ...preference, updatedAt: 'yesterday' }).success).toBe(
      false,
    );
    expect(
      OperatorPreferenceDocument.safeParse({ ...preference, updatedAt: approval.approvedAt }).success,
    ).toBe(true);
  });
  it('accepts only the enumerated preference values', () => {
    const choices = {
      length: ['brief', 'balanced', 'detailed'],
      technicalLevel: ['plain', 'mixed', 'technical'],
      detail: ['offer', 'include'],
      clarity: ['plain', 'precise'],
      background: ['minimal', 'contextual'],
    };
    for (const [field, values] of Object.entries(choices)) {
      for (const value of values)
        expect(
          OperatorPreferenceData.safeParse({ ...DEFAULT_OPERATOR_PREFERENCE, [field]: value }).success,
        ).toBe(true);
      expect(
        OperatorPreferenceData.safeParse({ ...DEFAULT_OPERATOR_PREFERENCE, [field]: 'custom' }).success,
      ).toBe(false);
      const incomplete = { ...DEFAULT_OPERATOR_PREFERENCE } as Record<string, unknown>;
      delete incomplete[field];
      expect(OperatorPreferenceData.safeParse(incomplete).success).toBe(false);
    }
  });
});
