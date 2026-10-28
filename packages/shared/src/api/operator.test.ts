import { describe, expect, it } from 'vitest';
import {
  OperatorApprovalPayload,
  OperatorMemberChanges,
  OperatorOperation,
  OperatorPlan,
  operatorCriticalOp,
  operatorApprovalOf,
  OperatorSignal,
  ProjectManagerCorner,
  RoleConfigurationRead,
  SendTeamMessageRequest,
} from './dto';

describe('Operator operation contracts', () => {
  it('accepts targeted role resets and validates the full role read response', () => {
    expect(
      OperatorOperation.parse({ op: 'config_patch', patch: { roleOverrides: { developer: null } } }),
    ).toEqual({ op: 'config_patch', patch: { roleOverrides: { developer: null } } });
    expect(OperatorOperation.safeParse({ op: 'config_patch', patch: { roleOverrides: null } }).success).toBe(
      false,
    );
    const response = {
      version: 'v1',
      role: 'developer',
      override: null,
      effective: { duties: ['implementation'], instructions: 'First line.\nSecond line.' },
    };
    expect(RoleConfigurationRead.parse(response)).toEqual(response);
    for (const extra of [{ role: 'custom_writer' }, { effective: null }, { unknown: true }])
      expect(RoleConfigurationRead.safeParse({ ...response, ...extra }).success).toBe(false);
  });
  it('accepts bounded typed messages and refuses commands, credentials and unsupported operations', () => {
    const message = { op: 'message_send', to: ['guest'], text: 'Exact text' };
    expect(OperatorOperation.parse(message)).toEqual(message);
    for (const extra of [
      { command: 'echo unsafe' },
      { token: 'credential-placeholder' },
      { sessionId: 'other-session' },
    ])
      expect(OperatorOperation.safeParse({ ...message, ...extra }).success).toBe(false);
    for (const to of [[], Array.from({ length: 11 }, (_, i) => `guest-${i}`)])
      expect(OperatorOperation.safeParse({ ...message, to }).success).toBe(false);
    expect(
      OperatorOperation.safeParse({ ...message, to: Array.from({ length: 10 }, (_, i) => `guest-${i}`) })
        .success,
    ).toBe(true);
    for (const text of ['', ' ', 'a'.repeat(20_001)])
      expect(OperatorOperation.safeParse({ ...message, text }).success).toBe(false);
    expect(OperatorOperation.safeParse({ ...message, text: 'a'.repeat(20_000) }).success).toBe(true);
    for (const op of [
      'merge',
      'release',
      'access_change',
      'decision',
      'approval_label',
      'transcript',
      'shell',
    ])
      expect(OperatorOperation.safeParse({ op }).success).toBe(false);
    expect(
      OperatorOperation.safeParse({ op: 'session_stop', sessionId: 'target', command: 'stop' }).success,
    ).toBe(false);
  });

  it('validates descriptive plans and identifies only the two critical operations', () => {
    const plan = { why: ' Explain ', impact: ' One guest ', reversible: false };
    expect(OperatorPlan.parse(plan)).toEqual({ why: 'Explain', impact: 'One guest', reversible: false });
    for (const change of [
      { why: '' },
      { impact: 'a'.repeat(501) },
      { reversible: 'yes' },
      { command: 'unsafe' },
      { credential: 'placeholder' },
    ])
      expect(OperatorPlan.safeParse({ ...plan, ...change }).success).toBe(false);
    expect(operatorCriticalOp('message_send')).toBe(true);
    expect(operatorCriticalOp('session_stop')).toBe(true);
    expect(operatorCriticalOp('member_update')).toBe(false);
    expect(operatorCriticalOp('project_pause')).toBe(false);
  });
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
      ProjectManagerCorner.parse({
        member: null,
        state: 'missing',
        sessionId: null,
        requests: [],
        readOnly: false,
        signals: [signal],
        openSignals: 1,
        queue: { open: 0, current: null },
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
