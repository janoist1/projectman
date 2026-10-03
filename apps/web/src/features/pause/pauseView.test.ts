import { describe, expect, it } from 'vitest';
import type { PausedSession, PauseStatus, ProjectPauseView } from '@projectman/shared';
import { formatClock } from '../../i18n/format';
import { t } from '../../i18n/t';
import {
  canForceNow,
  forceCountdown,
  openPauses,
  pausedRowsOf,
  pausedSessionMap,
  pointExplanation,
  pointText,
  runningText,
  sortRows,
  stoppedCount,
  visiblePause,
} from './pauseView';

function row(sessionId: string, patch: Partial<PausedSession> = {}): PausedSession {
  return {
    sessionId,
    projectKey: 'AC',
    member: 'be-1',
    workItem: { type: 'task', taskKey: 'AC-20' },
    since: '2026-10-01T10:00:00.000Z',
    point: null,
    tool: null,
    waitingFor: 'Bash',
    pausedAt: null,
    stopped: false,
    ...patch,
  };
}

function pause(scope: 'project' | 'instance', sessions: PausedSession[], patch: Partial<PauseStatus> = {}) {
  return {
    id: `pau_${scope}`,
    scope,
    projectKey: scope === 'project' ? 'AC' : null,
    kind: 'manual',
    state: sessions.some((entry) => entry.point === null) ? 'pausing' : 'paused',
    source: 'app',
    requestedBy: 'Te',
    requestedAt: '2026-10-01T10:00:00.000Z',
    reason: null,
    forceAt: '2026-10-01T10:05:00.000Z',
    sessions,
    ...patch,
  } satisfies PauseStatus;
}

const at = (iso: string) => Date.parse(iso);

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [7_400, '0:07'],
    [300_000, '5:00'],
    [723_000, '12:03'],
    [-5_000, '0:00'],
  ])('writes %i ms as %s', (ms, text) => expect(formatClock(ms)).toBe(text));
});

describe('which pause is shown', () => {
  it('lists nothing without an open pause', () => {
    expect(openPauses(undefined)).toEqual([]);
    expect(openPauses({ project: null, instance: null })).toEqual([]);
    expect(visiblePause({ project: null, instance: null })).toBeNull();
  });

  it('shows the instance pause first and keeps the project pause as the other', () => {
    const view: ProjectPauseView = { project: pause('project', []), instance: pause('instance', []) };
    expect(openPauses(view).map((entry) => entry.scope)).toEqual(['instance', 'project']);
    const shown = visiblePause(view)!;
    expect(shown.pause.scope).toBe('instance');
    expect(shown.other?.scope).toBe('project');
  });

  it('shows the project pause alone when only it is open', () => {
    const shown = visiblePause({ project: pause('project', []), instance: null })!;
    expect(shown.pause.scope).toBe('project');
    expect(shown.other).toBeNull();
  });
});

describe('the sessions the pauses hold', () => {
  it('reads a session in both pauses as the one that has not stopped yet', () => {
    const stopped = row('s1', { point: 'idle', pausedAt: '2026-10-01T10:00:01.000Z' });
    const running = row('s1');
    const view: ProjectPauseView = {
      project: pause('project', [stopped]),
      instance: pause('instance', [running]),
    };
    expect(pausedSessionMap(view).get('s1')!.point).toBeNull();
    const other: ProjectPauseView = {
      project: pause('project', [running]),
      instance: pause('instance', [stopped]),
    };
    expect(pausedSessionMap(other).get('s1')!.point).toBeNull();
  });

  it('gives the rows of the project, undefined when no pause is open and empty when nobody ran', () => {
    expect(pausedRowsOf({ project: null, instance: null }, 'AC')).toBeUndefined();
    expect(pausedRowsOf({ project: pause('project', []), instance: null }, 'AC')).toEqual([]);
    const view: ProjectPauseView = {
      project: pause('project', [row('s1'), row('s2', { projectKey: 'OT' })]),
      instance: null,
    };
    expect(pausedRowsOf(view, 'AC')!.map((entry) => entry.sessionId)).toEqual(['s1']);
  });

  it('counts the stopped ones', () => {
    const sessions = [row('s1', { point: 'idle' }), row('s2'), row('s3', { point: 'after_tool' })];
    expect(stoppedCount({ sessions })).toEqual({ done: 2, total: 3 });
  });

  it('sorts the running first by age, then the stopped by when they stopped', () => {
    const rows = [
      row('late', { point: 'idle', pausedAt: '2026-10-01T10:00:09.000Z' }),
      row('new', { since: '2026-10-01T10:00:05.000Z' }),
      row('early', { point: 'idle', pausedAt: '2026-10-01T10:00:02.000Z' }),
      row('old'),
    ];
    expect(sortRows(rows).map((entry) => entry.sessionId)).toEqual(['old', 'new', 'early', 'late']);
  });
});

describe('what a row says', () => {
  it('names the tool in the UI language and keeps an unknown one', () => {
    expect(pointText('after_tool', 'Bash')).toBe(t('session.pausePoint.after_tool', { tool: 'Parancs' }));
    expect(runningText('Bash')).toBe(t('session.pausePoint.running', { tool: 'Parancs' }));
    expect(runningText(null)).toBe(t('session.pausePoint.running', { tool: t('session.tools.other') }));
  });

  it('has no tool in the points that are not about a step', () => {
    expect(pointText('idle', null)).toBe(t('session.pausePoint.idle'));
  });

  it('explains only the points that cut a step', () => {
    expect(pointExplanation('after_tool')).toBe(t('session.pausePoint.explain.after_tool'));
    expect(pointExplanation('interrupted')).toBe(t('session.pausePoint.explain.interrupted'));
    expect(pointExplanation('idle')).toBeNull();
  });
});

describe('the deadline', () => {
  const status = pause('project', [row('s1')]);

  it('counts down to the force time and ends there', () => {
    expect(forceCountdown(status, at('2026-10-01T10:04:00.000Z'))).toBe(60_000);
    expect(forceCountdown(status, at('2026-10-01T10:05:00.000Z'))).toBeNull();
    expect(forceCountdown(status, at('2026-10-01T10:06:00.000Z'))).toBeNull();
  });

  it('offers the force only while someone runs and the deadline is not over', () => {
    expect(canForceNow(status, at('2026-10-01T10:01:00.000Z'))).toBe(true);
    expect(canForceNow(status, at('2026-10-01T10:05:00.000Z'))).toBe(false);
    const settled = pause('project', [row('s1', { point: 'idle' })]);
    expect(canForceNow(settled, at('2026-10-01T10:01:00.000Z'))).toBe(false);
  });
});
