import { describe, expect, it } from 'vitest';
import {
  operatorKnowledgeApprovalOf,
  operatorKnowledgeContinuationMessageId,
  operatorKnowledgeContinuationOf,
  operatorKnowledgeOperationIncluded,
  ProposeOperatorKnowledgeRequest,
} from './dto';
import type { OperatorKnowledgeApprovalPayload } from './dto';
import type { InboxItem } from '../domain/inbox';

const operation = { op: 'member_update' as const, handle: 'dev-1', changes: { model: 'sonnet' } };
const change = {
  kind: 'agreement_replace' as const,
  agreement: { summary: 'Agreed', involvement: 'important' as const, extraCritical: [] },
};
const payload: OperatorKnowledgeApprovalPayload = {
  id: 'okp_one',
  requestId: 'opr_one',
  stepId: 'ops_one',
  baseRevision: 0,
  change,
  operations: [operation],
  changes: [],
  baseConfigVersion: 'version',
  proposedBy: 'operator',
  stale: null,
  applying: { by: 'owner', at: '2026-10-15T00:00:00.000Z' },
};
const item: InboxItem = {
  id: 'inb_one',
  projectKey: 'AR',
  kind: 'approval' as const,
  source: 'operator',
  assignees: ['owner'],
  sessionId: null,
  taskKey: null,
  title: 'Agreement',
  body: null,
  options: [],
  createdAt: '2026-10-15T00:00:00.000Z',
  state: 'resolved' as const,
  payload: { operatorKnowledge: payload },
  resolution: { by: 'owner', optionId: 'approve', at: '2026-10-15T00:00:00.000Z', note: null },
};
const facts = {
  projectKey: 'AR',
  from: 'owner',
  operator: 'operator',
  messageId: operatorKnowledgeContinuationMessageId(payload.id),
  approvedStep: true,
  owner: true,
};

describe('shared Operator knowledge proposal contract', () => {
  it('defaults operations, bounds input and refuses extra authority fields', () => {
    const input = { expected_revision: 0, title: 'Agreement', change };
    expect(ProposeOperatorKnowledgeRequest.parse(input).operations).toEqual([]);
    expect(
      ProposeOperatorKnowledgeRequest.safeParse({ ...input, operations: Array(10).fill(operation) }).success,
    ).toBe(true);
    for (const patch of [
      { expected_revision: -1 },
      { expected_revision: 0.5 },
      { title: '' },
      { title: 's'.repeat(121) },
      { operations: Array(11).fill(operation) },
      { approvedBy: 'owner' },
      { handle: 'owner' },
      { change: { kind: 'principle_remove', id: 'olp_one' }, operations: [operation] },
    ])
      expect(ProposeOperatorKnowledgeRequest.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(operatorKnowledgeApprovalOf(item)).toEqual(payload);
    expect(
      operatorKnowledgeApprovalOf({
        ...item,
        payload: { operatorKnowledge: { ...payload, approved: true } },
      }),
    ).toBeNull();
    expect(operatorKnowledgeApprovalOf({ ...item, kind: 'question' })).toBeNull();
  });

  it('requires resolved own-login owner approval and the matching recorded step, never a marker alone', () => {
    expect(operatorKnowledgeContinuationOf(item, facts)).toEqual(payload);
    for (const patch of [
      { projectKey: 'OTHER' },
      { from: 'ada' },
      { operator: 'pm' },
      { messageId: 'forged' },
      { approvedStep: false },
      { owner: false },
      { via: 'integrator' },
    ])
      expect(operatorKnowledgeContinuationOf(item, { ...facts, ...patch })).toBeNull();
    for (const candidate of [
      { ...item, state: 'open' as const },
      { ...item, resolution: { ...item.resolution!, by: 'ada' } },
      { ...item, resolution: { ...item.resolution!, optionId: 'reject' } },
      { ...item, resolution: { ...item.resolution!, via: 'integrator' as const } },
      { ...item, payload: { operatorKnowledge: { ...payload, applying: null } } },
      { ...item, payload: { operatorKnowledge: { ...payload, operations: [] } } },
    ])
      expect(operatorKnowledgeContinuationOf(candidate, facts)).toBeNull();
    expect(
      operatorKnowledgeOperationIncluded(payload, {
        changes: { model: 'sonnet' },
        handle: 'dev-1',
        op: 'member_update',
      }),
    ).toBe(true);
    expect(operatorKnowledgeOperationIncluded(payload, { ...operation, handle: 'dev-2' })).toBe(false);
    expect(
      operatorKnowledgeOperationIncluded(payload, {
        ...operation,
        changes: { model: 'sonnet', outboundNetwork: true },
      }),
    ).toBe(false);
  });
});
