import { describe, expect, it } from 'vitest';
import {
  projectManagerKnowledgeApprovalOf,
  projectManagerKnowledgeContinuationMessageId,
  projectManagerKnowledgeContinuationOf,
  projectManagerKnowledgeOperationIncluded,
  ProposeProjectManagerKnowledgeRequest,
} from './dto';
import type { ProjectManagerKnowledgeApprovalPayload } from './dto';
import type { InboxItem } from '../domain/inbox';

const operation = { op: 'member_update' as const, handle: 'dev-1', changes: { model: 'sonnet' } };
const change = {
  kind: 'agreement_replace' as const,
  agreement: { summary: 'Agreed', involvement: 'important' as const, extraCritical: [] },
};
const payload: ProjectManagerKnowledgeApprovalPayload = {
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
  messageId: projectManagerKnowledgeContinuationMessageId(payload.id),
  approvedStep: true,
  owner: true,
};

describe('shared project manager knowledge proposal contract', () => {
  it('defaults operations, bounds input and refuses extra authority fields', () => {
    const input = { expected_revision: 0, title: 'Agreement', change };
    expect(ProposeProjectManagerKnowledgeRequest.parse(input).operations).toEqual([]);
    expect(
      ProposeProjectManagerKnowledgeRequest.safeParse({ ...input, operations: Array(10).fill(operation) })
        .success,
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
      expect(ProposeProjectManagerKnowledgeRequest.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(projectManagerKnowledgeApprovalOf(item)).toEqual(payload);
    expect(
      projectManagerKnowledgeApprovalOf({
        ...item,
        payload: { operatorKnowledge: { ...payload, approved: true } },
      }),
    ).toBeNull();
    expect(projectManagerKnowledgeApprovalOf({ ...item, kind: 'question' })).toBeNull();
  });

  it('requires resolved own-login owner approval and the matching recorded step, never a marker alone', () => {
    expect(projectManagerKnowledgeContinuationOf(item, facts)).toEqual(payload);
    for (const patch of [
      { projectKey: 'OTHER' },
      { from: 'ada' },
      { operator: 'pm' },
      { messageId: 'forged' },
      { approvedStep: false },
      { owner: false },
      { via: 'integrator' },
    ])
      expect(projectManagerKnowledgeContinuationOf(item, { ...facts, ...patch })).toBeNull();
    for (const candidate of [
      { ...item, state: 'open' as const },
      { ...item, resolution: { ...item.resolution!, by: 'ada' } },
      { ...item, resolution: { ...item.resolution!, optionId: 'reject' } },
      { ...item, resolution: { ...item.resolution!, via: 'integrator' as const } },
      { ...item, payload: { operatorKnowledge: { ...payload, applying: null } } },
      { ...item, payload: { operatorKnowledge: { ...payload, operations: [] } } },
    ])
      expect(projectManagerKnowledgeContinuationOf(candidate, facts)).toBeNull();
    expect(
      projectManagerKnowledgeOperationIncluded(payload, {
        changes: { model: 'sonnet' },
        handle: 'dev-1',
        op: 'member_update',
      }),
    ).toBe(true);
    expect(projectManagerKnowledgeOperationIncluded(payload, { ...operation, handle: 'dev-2' })).toBe(false);
    expect(
      projectManagerKnowledgeOperationIncluded(payload, {
        ...operation,
        changes: { model: 'sonnet', outboundNetwork: true },
      }),
    ).toBe(false);
  });
});
