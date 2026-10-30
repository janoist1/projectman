import { describe, expect, test } from 'vitest';
import {
  DEFAULT_OBLIGATION_MINUTES,
  PAUSING_REFUSALS,
  obligationMinutesOf,
  obligationRungsOf,
  planObligation,
  type Obligation,
  type ObligationFacts,
} from './obligation';

const OPENED = '2026-10-01T10:00:00.000Z';
const DUE = '2026-10-01T10:30:00.000Z';

const row = (patch: Partial<Obligation> = {}): Obligation => ({
  id: 'obl_1',
  projectKey: 'PM',
  taskKey: 'PM-1',
  kind: 'merge',
  responsible: 'claude',
  subject: 'mrg_1',
  openedAt: OPENED,
  dueAt: DUE,
  pausedSince: null,
  pauseReason: null,
  wokenAt: null,
  pmToldAt: null,
  handedOverAt: null,
  inboxItemId: null,
  state: 'open',
  closedAt: null,
  ...patch,
});

const facts = (patch: Partial<ObligationFacts> = {}): ObligationFacts => ({
  paused: null,
  active: false,
  lastActivityAt: null,
  ...patch,
});

describe('planObligation', () => {
  test('a row that is not open does not move', () => {
    for (const state of ['handed_over', 'fulfilled', 'cancelled'] as const)
      expect(planObligation(row({ state }), facts(), '2026-10-02T00:00:00.000Z', 30)).toEqual({
        kind: 'none',
      });
  });

  test('a pause starts once', () => {
    expect(planObligation(row(), facts({ paused: 'inbox' }), DUE, 30)).toEqual({
      kind: 'pause',
      reason: 'inbox',
    });
    expect(
      planObligation(row({ pausedSince: OPENED, pauseReason: 'inbox' }), facts({ paused: 'inbox' }), DUE, 30),
    ).toEqual({ kind: 'none' });
  });

  test('the end of a pause restarts the clock', () => {
    expect(planObligation(row({ pausedSince: OPENED }), facts(), '2026-10-01T12:00:00.000Z', 30)).toEqual({
      kind: 'resume',
      dueAt: '2026-10-01T12:30:00.000Z',
    });
  });

  test('nothing happens before the deadline', () => {
    expect(planObligation(row(), facts(), '2026-10-01T10:29:59.000Z', 30)).toEqual({ kind: 'none' });
  });

  test('recent activity of the responsible moves the deadline', () => {
    expect(
      planObligation(
        row(),
        facts({ lastActivityAt: '2026-10-01T10:20:00.000Z' }),
        '2026-10-01T10:31:00.000Z',
        30,
      ),
    ).toEqual({ kind: 'extend', dueAt: '2026-10-01T10:50:00.000Z' });
  });

  test('old activity does not move the deadline', () => {
    expect(planObligation(row(), facts({ lastActivityAt: OPENED }), '2026-10-01T10:31:00.000Z', 30)).toEqual({
      kind: 'wake',
      dueAt: '2026-10-01T11:01:00.000Z',
    });
  });

  test('a responsible at work gets more time', () => {
    expect(planObligation(row(), facts({ active: true }), '2026-10-01T10:31:00.000Z', 30)).toEqual({
      kind: 'extend',
      dueAt: '2026-10-01T11:01:00.000Z',
    });
  });

  test('the first expiry wakes the responsible', () => {
    expect(planObligation(row(), facts(), '2026-10-01T10:30:00.000Z', 30)).toEqual({
      kind: 'wake',
      dueAt: '2026-10-01T11:00:00.000Z',
    });
  });

  test('the second expiry tells the project manager', () => {
    const woken = row({ wokenAt: DUE, dueAt: '2026-10-01T11:00:00.000Z' });
    expect(planObligation(woken, facts(), '2026-10-01T11:00:00.000Z', 30)).toEqual({
      kind: 'tell_pm',
      dueAt: '2026-10-01T11:30:00.000Z',
    });
  });

  test('the third expiry hands the step over', () => {
    const told = row({
      wokenAt: DUE,
      pmToldAt: '2026-10-01T11:00:00.000Z',
      dueAt: '2026-10-01T11:30:00.000Z',
    });
    expect(planObligation(told, facts(), '2026-10-01T11:30:00.000Z', 30)).toEqual({ kind: 'hand_over' });
  });

  test('a step without the wake rung hands over at the first expiry', () => {
    expect(planObligation(row(), facts(), DUE, 30, ['hand_over'])).toEqual({ kind: 'hand_over' });
  });

  test('a step with no responsible tells the project manager first, then hands over a gap later', () => {
    const rungs = ['tell_pm', 'hand_over'] as const;
    expect(planObligation(row({ responsible: null }), facts(), DUE, 30, rungs)).toEqual({
      kind: 'tell_pm',
      dueAt: '2026-10-01T11:00:00.000Z',
    });
    const told = row({ responsible: null, pmToldAt: DUE, dueAt: '2026-10-01T11:00:00.000Z' });
    expect(planObligation(told, facts(), '2026-10-01T11:00:00.000Z', 30, rungs)).toEqual({
      kind: 'hand_over',
    });
  });

  describe('a ladder without the project manager rung', () => {
    const rungs = ['wake', 'hand_over'] as const;

    test('the reminder leaves two gaps before the hand-over', () => {
      expect(planObligation(row(), facts(), DUE, 30, rungs)).toEqual({
        kind: 'wake',
        dueAt: '2026-10-01T11:30:00.000Z',
      });
    });

    test('the hand-over comes at three gaps from the start', () => {
      const woken = row({ wokenAt: DUE, dueAt: '2026-10-01T11:30:00.000Z' });
      expect(planObligation(woken, facts(), '2026-10-01T11:29:00.000Z', 30, rungs)).toEqual({ kind: 'none' });
      expect(planObligation(woken, facts(), '2026-10-01T11:30:00.000Z', 30, rungs)).toEqual({
        kind: 'hand_over',
      });
    });

    test('the project manager dropping between the expiries extends the deadline to the reminder + 2N', () => {
      // The reminder ran on the full ladder (next due after N); the project manager is gone at the second expiry.
      const woken = row({ wokenAt: DUE, dueAt: '2026-10-01T11:00:00.000Z' });
      expect(planObligation(woken, facts(), '2026-10-01T11:00:00.000Z', 30, rungs)).toEqual({
        kind: 'extend',
        dueAt: '2026-10-01T11:30:00.000Z',
      });
    });

    test('a pause or activity counts the longer gap too', () => {
      const woken = row({ wokenAt: DUE, dueAt: '2026-10-01T11:30:00.000Z' });
      expect(
        planObligation(
          { ...woken, pausedSince: '2026-10-01T10:40:00.000Z', pauseReason: 'inbox' },
          facts(),
          '2026-10-01T12:00:00.000Z',
          30,
          rungs,
        ),
      ).toEqual({ kind: 'resume', dueAt: '2026-10-01T13:00:00.000Z' });
      expect(
        planObligation(
          woken,
          facts({ lastActivityAt: '2026-10-01T11:10:00.000Z' }),
          '2026-10-01T11:31:00.000Z',
          30,
          rungs,
        ),
      ).toEqual({ kind: 'extend', dueAt: '2026-10-01T12:10:00.000Z' });
    });
  });

  test('the number of minutes sets the deadline length', () => {
    expect(planObligation(row(), facts(), DUE, 5)).toEqual({
      kind: 'wake',
      dueAt: '2026-10-01T10:35:00.000Z',
    });
  });
});

describe('obligationRungsOf', () => {
  const full = ['wake', 'tell_pm', 'hand_over'] as const;

  test('keeps every rung when someone is responsible and a project manager can be told', () => {
    expect(obligationRungsOf(full, { responsible: 'dev', projectManager: 'pm' })).toEqual([...full]);
  });

  test('drops the reminder when nobody is responsible', () => {
    expect(obligationRungsOf(full, { responsible: null, projectManager: 'pm' })).toEqual([
      'tell_pm',
      'hand_over',
    ]);
  });

  test('drops the word to the project manager when there is none', () => {
    expect(obligationRungsOf(full, { responsible: 'dev', projectManager: null })).toEqual([
      'wake',
      'hand_over',
    ]);
  });

  test('drops the word to the project manager when they are the responsible', () => {
    expect(obligationRungsOf(full, { responsible: 'pm', projectManager: 'pm' })).toEqual([
      'wake',
      'hand_over',
    ]);
  });
});

describe('obligationMinutesOf', () => {
  test('defaults to 20 minutes', () => {
    expect(DEFAULT_OBLIGATION_MINUTES).toBe(20);
    expect(obligationMinutesOf({})).toBe(20);
  });

  test('uses the configured value', () => {
    expect(obligationMinutesOf({ obligationMinutes: 10 })).toBe(10);
  });
});

describe('PAUSING_REFUSALS', () => {
  test('pauses on engine and team holds but not on capacity', () => {
    expect(PAUSING_REFUSALS).toContain('engine_offline');
    expect(PAUSING_REFUSALS).toContain('team_paused');
    expect(PAUSING_REFUSALS).not.toContain('workspace_busy');
  });
});
