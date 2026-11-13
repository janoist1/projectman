import { describe, expect, it } from 'vitest';
import {
  ProjectManagerMemberChanges,
  ProjectManagerOperation,
  ProjectManagerPlan,
  projectManagerCriticalOp,
  ProjectManagerSignal,
  ProjectManagerCorner,
  RoleConfigurationRead,
  SendTeamMessageRequest,
} from './dto';

describe('project manager operation contracts', () => {
  it('accepts targeted role resets and validates the full role read response', () => {
    expect(
      ProjectManagerOperation.parse({ op: 'config_patch', patch: { roleOverrides: { developer: null } } }),
    ).toEqual({ op: 'config_patch', patch: { roleOverrides: { developer: null } } });
    expect(
      ProjectManagerOperation.safeParse({ op: 'config_patch', patch: { roleOverrides: null } }).success,
    ).toBe(false);
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
    expect(ProjectManagerOperation.parse(message)).toEqual(message);
    for (const extra of [
      { command: 'echo unsafe' },
      { token: 'credential-placeholder' },
      { sessionId: 'other-session' },
    ])
      expect(ProjectManagerOperation.safeParse({ ...message, ...extra }).success).toBe(false);
    for (const to of [[], Array.from({ length: 11 }, (_, i) => `guest-${i}`)])
      expect(ProjectManagerOperation.safeParse({ ...message, to }).success).toBe(false);
    expect(
      ProjectManagerOperation.safeParse({
        ...message,
        to: Array.from({ length: 10 }, (_, i) => `guest-${i}`),
      }).success,
    ).toBe(true);
    for (const text of ['', ' ', 'a'.repeat(20_001)])
      expect(ProjectManagerOperation.safeParse({ ...message, text }).success).toBe(false);
    expect(ProjectManagerOperation.safeParse({ ...message, text: 'a'.repeat(20_000) }).success).toBe(true);
    for (const op of [
      'merge',
      'release',
      'access_change',
      'decision',
      'approval_label',
      'transcript',
      'shell',
    ])
      expect(ProjectManagerOperation.safeParse({ op }).success).toBe(false);
    expect(
      ProjectManagerOperation.safeParse({ op: 'session_stop', sessionId: 'target', command: 'stop' }).success,
    ).toBe(false);
  });

  it('validates descriptive plans and identifies only the two critical operations', () => {
    const plan = { why: ' Explain ', impact: ' One guest ', reversible: false };
    expect(ProjectManagerPlan.parse(plan)).toEqual({
      why: 'Explain',
      impact: 'One guest',
      reversible: false,
    });
    for (const change of [
      { why: '' },
      { impact: 'a'.repeat(501) },
      { reversible: 'yes' },
      { command: 'unsafe' },
      { credential: 'placeholder' },
    ])
      expect(ProjectManagerPlan.safeParse({ ...plan, ...change }).success).toBe(false);
    expect(projectManagerCriticalOp('message_send')).toBe(true);
    expect(projectManagerCriticalOp('session_stop')).toBe(true);
    expect(projectManagerCriticalOp('member_update')).toBe(false);
    expect(projectManagerCriticalOp('project_pause')).toBe(false);
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
    expect(ProjectManagerSignal.parse(signal)).toEqual(signal);
    expect(ProjectManagerSignal.safeParse({ ...signal, kind: 'workflow' }).success).toBe(false);
    expect(ProjectManagerSignal.safeParse({ ...signal, state: 'closed' }).success).toBe(false);
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
    const result = ProjectManagerMemberChanges.parse({
      capacity: 3,
      role: 'developer',
      permissionMode: 'auto',
      access: 'owner',
      roles: ['operator'],
      displayName: 'Owner',
    });
    expect(result).toEqual({ capacity: 3, role: 'developer', permissionMode: 'auto' });
    expect(ProjectManagerMemberChanges.safeParse({ capacity: 6 }).success).toBe(false);
    expect(ProjectManagerMemberChanges.safeParse({ capacity: 0 }).success).toBe(false);
  });

  it('omits caller-supplied configuration provenance from a patch', () => {
    expect(
      ProjectManagerOperation.safeParse({
        op: 'config_patch',
        patch: { baseVersion: 'v1', message: 'Spoofed' },
      }).success,
    ).toBe(false);
  });
});
