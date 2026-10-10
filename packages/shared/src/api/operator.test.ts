import { describe, expect, it } from 'vitest';
import { OperatorApprovalPayload, OperatorMemberChanges, OperatorOperation, operatorApprovalOf } from './dto';

describe('Operator operation contracts', () => {
  it('accepts AI settings and capacity while excluding human identity and privileges', () => {
    const result = OperatorMemberChanges.parse({
      capacity: 3,
      role: 'developer',
      permissionMode: 'auto',
      access: 'owner',
      roles: ['operator'],
      displayName: 'Owner',
    });
    expect(result).toEqual({ capacity: 3, role: 'developer', permissionMode: 'auto' });
    expect(OperatorMemberChanges.safeParse({ capacity: 6 }).success).toBe(false);
    expect(OperatorMemberChanges.safeParse({ capacity: 0 }).success).toBe(false);
  });

  it('omits caller-supplied configuration provenance from a patch', () => {
    expect(
      OperatorOperation.safeParse({ op: 'config_patch', patch: { baseVersion: 'v1', message: 'Spoofed' } })
        .success,
    ).toBe(false);
  });

  it('reads only validated Operator approval payloads of approval items', () => {
    const payload = OperatorApprovalPayload.parse({
      requestId: 'opr_1',
      stepId: 'ops_1',
      quote: 'Change it',
      action: 'project_pause',
      operation: { op: 'project_pause' },
      changes: [],
      consequence: 'project_pause',
      baseVersion: null,
      session: null,
      stale: null,
    });
    expect(operatorApprovalOf({ kind: 'approval', payload: { operator: payload } })).toEqual(payload);
    expect(operatorApprovalOf({ kind: 'question', payload: { operator: payload } })).toBeNull();
    expect(
      operatorApprovalOf({ kind: 'approval', payload: { operator: { requestId: 'opr_1' } } }),
    ).toBeNull();
    expect(operatorApprovalOf({ kind: 'approval', payload: {} })).toBeNull();
  });
});
