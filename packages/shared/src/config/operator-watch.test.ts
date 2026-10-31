import { describe, expect, it } from 'vitest';
import {
  OPERATOR_DISMISSIBLE_SIGNAL_KINDS,
  OPERATOR_SIGNAL_STEP_GAP_MINUTES,
  OPERATOR_SIGNAL_STEP_KINDS,
  OPERATOR_UNRELEASED_STEP_GAP_HOURS,
  operatorSignalBudget,
  operatorSignalStepRefusal,
} from './operator-watch';
import type { OperatorSignalStepTargets } from './operator-watch';
import { OperatorSignalKind } from '../api/dto';

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
    kind: 'obligation_overdue',
    tool: 'start_task',
    target: { member: null, taskKey: 'AR-1' },
    allowed: idleAllowed,
    stepsAt: [],
    now: NOW,
  } as const;
  it('accepts cleanup signals but gives the Operator no autonomous step for them', () => {
    expect(OperatorSignalKind.parse('process_cleanup_failed')).toBe('process_cleanup_failed');
    expect(operatorSignalStepRefusal({ ...base, kind: 'process_cleanup_failed', level: 'drive' })).toEqual({
      code: 'operator_no_request',
      reason: 'kind',
    });
  });

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

  describe('the unreleased step the owner granted (PM-1201)', () => {
    const unreleased = { ...base, kind: 'unreleased', tool: 'start_member' } as const;
    const allowed = { startTask: null, members: ['devops'], taskKey: null };
    const target = { member: 'devops', taskKey: null };
    const hoursAgo = (hours: number) => minutesAgo(hours * 60);

    it.each(['report', 'unblock', 'drive'] as const)('lets the step through at level %s', (level) => {
      expect(operatorSignalStepRefusal({ ...unreleased, level, target, allowed })).toBeNull();
      expect(OPERATOR_SIGNAL_STEP_KINDS[level]).not.toContain('unreleased');
    });

    it('refuses start_task: the signal gives no card to start', () => {
      expect(
        operatorSignalStepRefusal({ ...unreleased, level: 'report', tool: 'start_task', target, allowed }),
      ).toEqual({
        code: 'operator_no_request',
        reason: 'tool',
      });
    });

    it('allows one step a day with no limit on their number, and tells when the next one may come', () => {
      const level = 'report';
      const many = Array.from({ length: 5 }, (_, i) => hoursAgo(25 + i * 24));
      expect(operatorSignalStepRefusal({ ...unreleased, level, target, allowed, stepsAt: many })).toBeNull();
      const recent = hoursAgo(5);
      expect(operatorSignalStepRefusal({ ...unreleased, level, target, allowed, stepsAt: [recent] })).toEqual(
        {
          code: 'operator_signal_budget',
          reason: 'too_soon',
          retryAt: new Date(
            Date.parse(recent) + OPERATOR_UNRELEASED_STEP_GAP_HOURS * 3_600_000,
          ).toISOString(),
        },
      );
      expect(operatorSignalBudget(level, [recent], NOW, 'unreleased').left).toBe(1);
    });
  });

  it('binds answer_stalled to start_member at unblock and drive, with no task start', () => {
    for (const level of ['report', 'unblock', 'drive'] as const) {
      expect(OPERATOR_SIGNAL_STEP_KINDS[level].includes('answer_stalled')).toBe(level !== 'report');
      for (const tool of ['start_task', 'start_member'] as const) {
        expect(
          operatorSignalStepRefusal({
            ...base,
            level,
            kind: 'answer_stalled',
            tool,
            target: { member: tool === 'start_member' ? 'dev-1' : null, taskKey: 'AR-1' },
            allowed: { startTask: null, members: ['dev-1'], taskKey: 'AR-1' },
          }),
        ).toEqual(
          level === 'report'
            ? { code: 'operator_no_request', reason: 'level' }
            : tool === 'start_task'
              ? { code: 'operator_no_request', reason: 'tool' }
              : null,
        );
      }
    }
  });

  it('lets the overdue obligation be dismissed and stepped on, and gives the retired stall kinds neither', () => {
    expect(OPERATOR_DISMISSIBLE_SIGNAL_KINDS).toContain('obligation_overdue');
    for (const level of ['unblock', 'drive'] as const)
      expect(OPERATOR_SIGNAL_STEP_KINDS[level]).toContain('obligation_overdue');
    for (const kind of ['idle', 'merge_waiting', 'ready_waiting', 'refinement_stalled'] as const) {
      expect(OPERATOR_DISMISSIBLE_SIGNAL_KINDS).not.toContain(kind);
      for (const level of ['unblock', 'drive'] as const)
        expect(OPERATOR_SIGNAL_STEP_KINDS[level]).not.toContain(kind);
    }
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
    const merge = { ...base, tool: 'start_member', allowed: mergeAllowed } as const;
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
