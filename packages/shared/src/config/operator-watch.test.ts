import { describe, expect, it } from 'vitest';
import {
  PROJECT_MANAGER_DISMISSIBLE_SIGNAL_KINDS,
  PROJECT_MANAGER_SIGNAL_STEP_GAP_MINUTES,
  PROJECT_MANAGER_SIGNAL_STEP_KINDS,
  OWNER_SILENT_SIGNAL_KINDS,
  isCoordinatorOnlySignal,
  projectManagerSignalBudget,
  ownerQuestionSignalRefusal,
  ownerQuestionSignalRefusalMessage,
  projectManagerSignalStepRefusal,
} from './operator-watch';
import type { ProjectManagerSignalStepTargets } from './operator-watch';
import { ProjectManagerSignalKind } from '../api/dto';

const NOW = '2026-10-12T10:00:00.000Z';
const minutesAgo = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

const idleAllowed: ProjectManagerSignalStepTargets = { startTask: 'AR-1', members: [], taskKey: null };
const mergeAllowed: ProjectManagerSignalStepTargets = {
  startTask: null,
  members: ['claude'],
  taskKey: 'AR-2',
};

describe('ownerQuestionSignalRefusal (PM-1243)', () => {
  it('lists the kinds the owners get no question about', () => {
    expect(OWNER_SILENT_SIGNAL_KINDS).toEqual([
      'unreleased',
      'structural_pattern',
      'milestone_closed',
      'review_follow_ups',
    ]);
  });
  it.each(ProjectManagerSignalKind.options)('refuses exactly the owner-silent kinds: %s', (kind) => {
    const silent = (OWNER_SILENT_SIGNAL_KINDS as readonly string[]).includes(kind);
    expect(ownerQuestionSignalRefusal(kind)).toBe(silent ? 'signal_not_for_owner' : null);
  });
  it('tells the coordinator what to do instead', () => {
    expect(ownerQuestionSignalRefusalMessage('unreleased')).toContain('release_due');
    expect(ownerQuestionSignalRefusalMessage('milestone_closed')).toContain('dismiss_signal');
  });
  it('keeps a review_follow_ups signal for the coordinator: owner-silent, dismissible, no step', () => {
    expect(isCoordinatorOnlySignal('review_follow_ups')).toBe(true);
    expect(PROJECT_MANAGER_DISMISSIBLE_SIGNAL_KINDS).toContain('review_follow_ups');
    for (const level of ['report', 'unblock', 'drive'] as const)
      expect(PROJECT_MANAGER_SIGNAL_STEP_KINDS[level]).not.toContain('review_follow_ups');
  });
});

describe('projectManagerSignalBudget', () => {
  it('gives no step at report, one at unblock and three at drive', () => {
    expect(projectManagerSignalBudget('report', [], NOW)).toEqual({ left: 0, nextAt: null });
    expect(projectManagerSignalBudget('unblock', [], NOW)).toEqual({ left: 1, nextAt: null });
    expect(projectManagerSignalBudget('drive', [], NOW)).toEqual({ left: 3, nextAt: null });
  });

  it('counts the steps taken and waits the gap from the latest one', () => {
    const last = minutesAgo(10);
    expect(projectManagerSignalBudget('drive', [minutesAgo(50), last], NOW)).toEqual({
      left: 1,
      nextAt: new Date(Date.parse(last) + PROJECT_MANAGER_SIGNAL_STEP_GAP_MINUTES * 60_000).toISOString(),
    });
    expect(
      projectManagerSignalBudget('drive', [minutesAgo(PROJECT_MANAGER_SIGNAL_STEP_GAP_MINUTES)], NOW),
    ).toEqual({
      left: 2,
      nextAt: null,
    });
    expect(projectManagerSignalBudget('unblock', [minutesAgo(5)], NOW)).toEqual({ left: 0, nextAt: null });
  });
});

describe('projectManagerSignalStepRefusal', () => {
  const base = {
    level: 'unblock',
    kind: 'obligation_overdue',
    tool: 'start_task',
    target: { member: null, taskKey: 'AR-1' },
    allowed: idleAllowed,
    stepsAt: [],
    now: NOW,
  } as const;
  it('accepts cleanup signals but gives the project manager no autonomous step for them', () => {
    expect(ProjectManagerSignalKind.parse('process_cleanup_failed')).toBe('process_cleanup_failed');
    expect(
      projectManagerSignalStepRefusal({ ...base, kind: 'process_cleanup_failed', level: 'drive' }),
    ).toEqual({
      code: 'operator_no_request',
      reason: 'kind',
    });
  });

  it('lets the step through on the right card at a level that allows the kind', () => {
    expect(projectManagerSignalStepRefusal(base)).toBeNull();
    expect(
      projectManagerSignalStepRefusal({
        ...base,
        kind: 'merge_blocked',
        tool: 'start_member',
        target: { member: 'claude', taskKey: 'AR-2' },
        allowed: mergeAllowed,
      }),
    ).toBeNull();
  });

  it('refuses everything at report', () => {
    expect(projectManagerSignalStepRefusal({ ...base, level: 'report' })).toEqual({
      code: 'operator_no_request',
      reason: 'level',
    });
  });

  it.each(['report', 'unblock', 'drive'] as const)(
    'gives an unreleased signal no step at level %s (PM-1333: the release_due todo carries it)',
    (level) => {
      expect(PROJECT_MANAGER_SIGNAL_STEP_KINDS[level]).not.toContain('unreleased');
      expect(
        projectManagerSignalStepRefusal({
          ...base,
          level,
          kind: 'unreleased',
          tool: 'start_member',
          target: { member: 'devops', taskKey: null },
          allowed: { startTask: null, members: ['devops'], taskKey: null },
        }),
      ).toMatchObject({ code: 'operator_no_request' });
    },
  );

  it('binds answer_stalled to start_member at unblock and drive, with no task start', () => {
    for (const level of ['report', 'unblock', 'drive'] as const) {
      expect(PROJECT_MANAGER_SIGNAL_STEP_KINDS[level].includes('answer_stalled')).toBe(level !== 'report');
      for (const tool of ['start_task', 'start_member'] as const) {
        expect(
          projectManagerSignalStepRefusal({
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

  it('lets the overdue obligation be dismissed and stepped on', () => {
    expect(PROJECT_MANAGER_DISMISSIBLE_SIGNAL_KINDS).toContain('obligation_overdue');
    for (const level of ['unblock', 'drive'] as const)
      expect(PROJECT_MANAGER_SIGNAL_STEP_KINDS[level]).toContain('obligation_overdue');
  });

  it('refuses a tool the signal gives no target for, and a wrong card or member', () => {
    expect(
      projectManagerSignalStepRefusal({
        ...base,
        tool: 'start_member',
        target: { member: 'x', taskKey: null },
      }),
    ).toEqual({
      code: 'operator_no_request',
      reason: 'tool',
    });
    expect(projectManagerSignalStepRefusal({ ...base, allowed: mergeAllowed })).toEqual({
      code: 'operator_no_request',
      reason: 'tool',
    });
    expect(projectManagerSignalStepRefusal({ ...base, target: { member: null, taskKey: 'AR-9' } })).toEqual({
      code: 'operator_no_request',
      reason: 'target',
    });
    const merge = { ...base, tool: 'start_member', allowed: mergeAllowed } as const;
    for (const target of [
      { member: 'dev-1', taskKey: 'AR-2' },
      { member: 'claude', taskKey: 'AR-9' },
      { member: 'claude', taskKey: null },
    ])
      expect(projectManagerSignalStepRefusal({ ...merge, target })).toEqual({
        code: 'operator_no_request',
        reason: 'target',
      });
  });

  it('spends the budget: one step at unblock, three at least half an hour apart at drive', () => {
    expect(projectManagerSignalStepRefusal({ ...base, stepsAt: [minutesAgo(90)] })).toEqual({
      code: 'operator_signal_budget',
      reason: 'used',
      retryAt: null,
    });
    const drive = { ...base, level: 'drive' } as const;
    expect(projectManagerSignalStepRefusal({ ...drive, stepsAt: [minutesAgo(31)] })).toBeNull();
    const recent = minutesAgo(10);
    expect(projectManagerSignalStepRefusal({ ...drive, stepsAt: [recent] })).toEqual({
      code: 'operator_signal_budget',
      reason: 'too_soon',
      retryAt: new Date(Date.parse(recent) + PROJECT_MANAGER_SIGNAL_STEP_GAP_MINUTES * 60_000).toISOString(),
    });
    expect(
      projectManagerSignalStepRefusal({
        ...drive,
        stepsAt: [minutesAgo(100), minutesAgo(70), minutesAgo(40)],
      }),
    ).toEqual({ code: 'operator_signal_budget', reason: 'used', retryAt: null });
  });
});
