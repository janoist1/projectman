import { describe, expect, it } from 'vitest';
import {
  OperatorApprovalPayload,
  OperatorMemberChanges,
  OperatorOperation,
  operatorApprovalOf,
  OperatorSignal,
  OperatorChannel,
  SendTeamMessageRequest,
} from './dto';

describe('Operator operation contracts', () => {
  it('validates system signal kinds, states and owner decision message references', () => {
    const signal = {
      id: 'ops_1',
      kind: 'silent',
      state: 'open',
      actionable: true,
      taskKey: 'PM-476',
      subject: 'ses_1',
      inboxItemId: null,
      messageId: 'msg_1',
      raisedAt: '2026-10-11T10:00:00Z',
      decidedBy: null,
      decidedAt: null,
      resolvedAt: null,
    };
    expect(OperatorSignal.parse(signal)).toEqual(signal);
    expect(OperatorSignal.safeParse({ ...signal, kind: 'workflow' }).success).toBe(false);
    expect(OperatorSignal.safeParse({ ...signal, state: 'closed' }).success).toBe(false);
    expect(
      OperatorChannel.parse({
        member: null,
        state: 'missing',
        sessionId: null,
        requests: [],
        signals: [signal],
        openSignals: 1,
      }).signals,
    ).toHaveLength(1);
    expect(
      SendTeamMessageRequest.parse({ to: ['operator'], text: 'Yes', operatorSignal: signal.id })
        .operatorSignal,
    ).toBe(signal.id);
  });
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
