import { describe, expect, it } from 'vitest';
import { CloseStates } from './close-states';

const STEP_DONE = { kind: 'step_done', taskKey: 'PM-1' } as const;
const AWAITING_FIX = { kind: 'awaiting_fix', taskKey: 'PM-1' } as const;

describe('CloseStates marks', () => {
  it('holds the reason a session is marked for', () => {
    const states = new CloseStates();
    expect(states.markOf('s1')).toBeUndefined();
    states.mark('s1', STEP_DONE);
    expect(states.markOf('s1')).toEqual(STEP_DONE);
    expect(states.markOf('s2')).toBeUndefined();
  });

  it('replaces the mark of a session marked again', () => {
    const states = new CloseStates();
    states.mark('s1', STEP_DONE);
    states.mark('s1', AWAITING_FIX);
    expect(states.markOf('s1')).toEqual(AWAITING_FIX);
  });

  it('cancels a mark and says so only when there was one', () => {
    const states = new CloseStates();
    expect(states.cancel('s1')).toBe(false);
    states.mark('s1', STEP_DONE);
    expect(states.cancel('s1')).toBe(true);
    expect(states.markOf('s1')).toBeUndefined();
    expect(states.cancel('s1')).toBe(false);
  });

  it('knows a session that waits for the fix only by its awaiting_fix mark', () => {
    const states = new CloseStates();
    expect(states.isAwaitingFix('s1')).toBe(false);
    states.mark('s1', STEP_DONE);
    expect(states.isAwaitingFix('s1')).toBe(false);
    states.mark('s1', { kind: 'handed_off', taskKey: 'PM-1' });
    expect(states.isAwaitingFix('s1')).toBe(false);
    states.mark('s1', AWAITING_FIX);
    expect(states.isAwaitingFix('s1')).toBe(true);
    states.cancel('s1');
    expect(states.isAwaitingFix('s1')).toBe(false);
  });
});

describe('CloseStates closing', () => {
  it('is independent of the mark', () => {
    const states = new CloseStates();
    states.mark('s1', STEP_DONE);
    expect(states.isClosing('s1')).toBe(false);
    states.beginClose('s1');
    expect(states.isClosing('s1')).toBe(true);
    states.cancel('s1');
    expect(states.isClosing('s1')).toBe(true);
    expect(states.isClosing('s2')).toBe(false);
  });
});

describe('CloseStates heavy runs', () => {
  it('is true at the first sighting only', () => {
    const states = new CloseStates();
    expect(states.heavyRunSeen('s1', 1_000)).toBe(true);
    expect(states.heavyRunSeen('s1', 2_000)).toBe(false);
    expect(states.heavyRunSeen('s2', 2_000)).toBe(true);
  });

  it('holds until the limit after the last sighting', () => {
    const states = new CloseStates();
    expect(states.heavyRunHolds('s1', 5_000, 1_000)).toBe(false);
    states.heavyRunSeen('s1', 1_000);
    expect(states.heavyRunHolds('s1', 1_999, 1_000)).toBe(true);
    expect(states.heavyRunHolds('s1', 2_000, 1_000)).toBe(false);
    states.heavyRunSeen('s1', 2_000);
    expect(states.heavyRunHolds('s1', 2_999, 1_000)).toBe(true);
  });

  it('prunes only the sessions outside the idle set', () => {
    const states = new CloseStates();
    states.heavyRunSeen('s1', 1_000);
    states.heavyRunSeen('s2', 1_000);
    states.pruneHeavyRuns(new Set(['s1']));
    expect(states.heavyRunHolds('s1', 1_500, 1_000)).toBe(true);
    expect(states.heavyRunHolds('s2', 1_500, 1_000)).toBe(false);
    expect(states.heavyRunSeen('s2', 2_000)).toBe(true);
  });
});

describe('CloseStates.ended', () => {
  it('drops the mark and closing, and keeps the heavy run sighting', () => {
    const states = new CloseStates();
    states.mark('s1', AWAITING_FIX);
    states.beginClose('s1');
    states.heavyRunSeen('s1', 1_000);
    states.ended('s1');
    expect(states.markOf('s1')).toBeUndefined();
    expect(states.isAwaitingFix('s1')).toBe(false);
    expect(states.isClosing('s1')).toBe(false);
    expect(states.heavyRunHolds('s1', 1_500, 1_000)).toBe(true);
  });
});
