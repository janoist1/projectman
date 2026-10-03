import { describe, expect, it } from 'vitest';
import {
  canManageInstancePause,
  isWorkPaused,
  NUDGE_POINTS,
  PauseRequest,
  pauseStateOf,
  RESTART_POINTS,
} from './pause';

describe('isWorkPaused', () => {
  it('holds every project under an instance pause', () => {
    expect(isWorkPaused([{ scope: 'instance', projectKey: null }], 'EX')).toBe(true);
  });

  it('holds only its own project under a project pause', () => {
    const pauses = [{ scope: 'project' as const, projectKey: 'EX' }];
    expect(isWorkPaused(pauses, 'EX')).toBe(true);
    expect(isWorkPaused(pauses, 'OT')).toBe(false);
  });

  it('is false without an open pause', () => {
    expect(isWorkPaused([], 'EX')).toBe(false);
  });
});

describe('canManageInstancePause', () => {
  it('needs owner access in every project', () => {
    expect(canManageInstancePause(['owner', 'owner'])).toBe(true);
    expect(canManageInstancePause(['owner', 'admin'])).toBe(false);
  });

  it('refuses a project without access', () => {
    expect(canManageInstancePause(['owner', null])).toBe(false);
  });

  it('refuses an instance without projects', () => {
    expect(canManageInstancePause([])).toBe(false);
  });
});

describe('pauseStateOf', () => {
  it('is paused without sessions', () => {
    expect(pauseStateOf([])).toBe('paused');
  });

  it('is pausing while a session has no point', () => {
    expect(pauseStateOf([{ point: 'idle' }, { point: null }])).toBe('pausing');
  });

  it('is paused when every session has a point', () => {
    expect(pauseStateOf([{ point: 'idle' }, { point: 'after_tool' }])).toBe('paused');
  });
});

describe('pause points', () => {
  it('restarts a stopped session from the cut and the waiting points only', () => {
    expect(RESTART_POINTS).toEqual([...NUDGE_POINTS, 'waiting_permission', 'waiting_input']);
    expect(RESTART_POINTS).not.toContain('idle');
    expect(RESTART_POINTS).not.toContain('turn_end');
    expect(RESTART_POINTS).not.toContain('exited');
  });
});

describe('PauseRequest', () => {
  it('accepts an empty body', () => {
    expect(PauseRequest.parse({})).toEqual({});
  });

  it('trims the reason and bounds the deadline', () => {
    expect(PauseRequest.parse({ reason: '  deploy ', forceAfterMs: 0 })).toEqual({
      reason: 'deploy',
      forceAfterMs: 0,
    });
    expect(PauseRequest.safeParse({ forceAfterMs: 3_600_001 }).success).toBe(false);
    expect(PauseRequest.safeParse({ reason: '   ' }).success).toBe(false);
  });
});
