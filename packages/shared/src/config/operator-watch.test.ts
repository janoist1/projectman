import { describe, expect, it } from 'vitest';
import {
  OPERATOR_SIGNAL_STEP_GAP_MINUTES,
  operatorSignalBudget,
  operatorSignalStepRefusal,
} from './operator-watch';
import type { OperatorSignalStepTargets } from './operator-watch';

const NOW = '2026-10-12T10:00:00.000Z';
const minutesAgo = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

const idleAllowed: OperatorSignalStepTargets = { startTask: 'AR-1', members: [], taskKey: null };
const mergeAllowed: OperatorSignalStepTargets = { startTask: null, members: ['claude'], taskKey: 'AR-2' };

describe('operatorSignalBudget', () => {
  it('gives no step at report, one at unblock and three at drive', () => {
    expect(operatorSignalBudget('report', [], NOW)).toEqual({ left: 0, nextAt: null });
    expect(operatorSignalBudget('unblock', [], NOW)).toEqual({ left: 1, nextAt: null });
    expect(operatorSignalBudget('drive', [], NOW)).toEqual({ left: 3, nextAt: null });
  });

  it('counts the steps taken and waits the gap from the latest one', () => {
    const last = minutesAgo(10);
    expect(operatorSignalBudget('drive', [minutesAgo(50), last], NOW)).toEqual({
      left: 1,
      nextAt: new Date(Date.parse(last) + OPERATOR_SIGNAL_STEP_GAP_MINUTES * 60_000).toISOString(),
    });
    expect(operatorSignalBudget('drive', [minutesAgo(OPERATOR_SIGNAL_STEP_GAP_MINUTES)], NOW)).toEqual({
      left: 2,
      nextAt: null,
    });
    expect(operatorSignalBudget('unblock', [minutesAgo(5)], NOW)).toEqual({ left: 0, nextAt: null });
  });
});

describe('operatorSignalStepRefusal', () => {
  const base = {
    level: 'unblock',
    kind: 'idle',
    tool: 'start_task',
    target: { member: null, taskKey: 'AR-1' },
    allowed: idleAllowed,
    stepsAt: [],
    now: NOW,
  } as const;

  it('lets the step through on the right card at a level that allows the kind', () => {
    expect(operatorSignalStepRefusal(base)).toBeNull();
    expect(
      operatorSignalStepRefusal({
        ...base,
        kind: 'merge_blocked',
        tool: 'start_member',
        target: { member: 'claude', taskKey: 'AR-2' },
        allowed: mergeAllowed,
      }),
    ).toBeNull();
  });

  it('refuses everything at report', () => {
    expect(operatorSignalStepRefusal({ ...base, level: 'report' })).toEqual({
      code: 'operator_no_request',
      reason: 'level',
    });
  });

  it('keeps the board kinds that only drive covers away from unblock', () => {
    const unreleased = { ...base, kind: 'unreleased', tool: 'start_member' } as const;
    const allowed = { startTask: null, members: ['devops'], taskKey: null };
    const target = { member: 'devops', taskKey: null };
    expect(operatorSignalStepRefusal({ ...unreleased, target, allowed })).toEqual({
      code: 'operator_no_request',
      reason: 'kind',
    });
    expect(operatorSignalStepRefusal({ ...unreleased, level: 'drive', target, allowed })).toBeNull();
  });

  it('refuses a tool the signal gives no target for, and a wrong card or member', () => {
    expect(
      operatorSignalStepRefusal({ ...base, tool: 'start_member', target: { member: 'x', taskKey: null } }),
    ).toEqual({
      code: 'operator_no_request',
      reason: 'tool',
    });
    expect(operatorSignalStepRefusal({ ...base, allowed: mergeAllowed })).toEqual({
      code: 'operator_no_request',
      reason: 'tool',
    });
    expect(operatorSignalStepRefusal({ ...base, target: { member: null, taskKey: 'AR-9' } })).toEqual({
      code: 'operator_no_request',
      reason: 'target',
    });
    const merge = { ...base, kind: 'merge_waiting', tool: 'start_member', allowed: mergeAllowed } as const;
    for (const target of [
      { member: 'dev-1', taskKey: 'AR-2' },
      { member: 'claude', taskKey: 'AR-9' },
      { member: 'claude', taskKey: null },
    ])
      expect(operatorSignalStepRefusal({ ...merge, target })).toEqual({
        code: 'operator_no_request',
        reason: 'target',
      });
  });

  it('spends the budget: one step at unblock, three at least half an hour apart at drive', () => {
    expect(operatorSignalStepRefusal({ ...base, stepsAt: [minutesAgo(90)] })).toEqual({
      code: 'operator_signal_budget',
      reason: 'used',
      retryAt: null,
    });
    const drive = { ...base, level: 'drive' } as const;
    expect(operatorSignalStepRefusal({ ...drive, stepsAt: [minutesAgo(31)] })).toBeNull();
    const recent = minutesAgo(10);
    expect(operatorSignalStepRefusal({ ...drive, stepsAt: [recent] })).toEqual({
      code: 'operator_signal_budget',
      reason: 'too_soon',
      retryAt: new Date(Date.parse(recent) + OPERATOR_SIGNAL_STEP_GAP_MINUTES * 60_000).toISOString(),
    });
    expect(
      operatorSignalStepRefusal({ ...drive, stepsAt: [minutesAgo(100), minutesAgo(70), minutesAgo(40)] }),
    ).toEqual({ code: 'operator_signal_budget', reason: 'used', retryAt: null });
  });
});
