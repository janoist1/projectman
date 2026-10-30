import { describe, expect, test } from 'vitest';
import {
  DEFAULT_OBLIGATION_MINUTES,
  PAUSING_REFUSALS,
  obligationMinutesOf,
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

  test('the second expiry hands the step over', () => {
    const woken = row({ wokenAt: DUE, dueAt: '2026-10-01T11:00:00.000Z' });
    expect(planObligation(woken, facts(), '2026-10-01T11:00:00.000Z', 30)).toEqual({ kind: 'hand_over' });
  });

  test('a step without the wake rung hands over at the first expiry', () => {
    expect(planObligation(row(), facts(), DUE, 30, ['hand_over'])).toEqual({ kind: 'hand_over' });
  });

  test('the number of minutes sets the deadline length', () => {
    expect(planObligation(row(), facts(), DUE, 5)).toEqual({
      kind: 'wake',
      dueAt: '2026-10-01T10:35:00.000Z',
    });
  });
});

describe('obligationMinutesOf', () => {
  test('defaults to 30 minutes', () => {
    expect(DEFAULT_OBLIGATION_MINUTES).toBe(30);
    expect(obligationMinutesOf({})).toBe(30);
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
