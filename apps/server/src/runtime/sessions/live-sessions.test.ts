import type { Session } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { LiveSessions } from './live-sessions';

function sessionOf(id: string, workItem: Session['workItem'] = { type: 'task', taskKey: 'PM-1' }): Session {
  return { id, projectKey: 'PM', member: 'dev', workItem } as Session;
}

/** What a promise settled with, once the microtasks ran; 'pending' while it did not settle. */
async function outcome(promise: Promise<boolean>): Promise<boolean | 'pending'> {
  return Promise.race([promise, Promise.resolve('pending' as const)]);
}

/** Fills every record of the session, as a start does. */
function startProcess(live: LiveSessions, id: string) {
  const token = live.issueToken(sessionOf(id));
  live.providers.set(id, 'claude');
  live.resuming.add(id);
  live.awaitingFirstTurn.add(id);
  live.modes.set(id, 'default');
  live.mergeFixes.set(id, { branch: 'fix', cwd: '/w' });
  live.grants.set(id, 2);
  live.guides.set(id, { rules: '# Team rules' });
  live.stopReasons.set(id, { kind: 'restart', restartFor: 'permission' });
  return { token, firstInput: live.awaitFirstInput(id) };
}

function holdsNothing(live: LiveSessions, id: string) {
  expect(live.providers.has(id)).toBe(false);
  expect(live.resuming.has(id)).toBe(false);
  expect(live.awaitingFirstTurn.has(id)).toBe(false);
  expect(live.modes.has(id)).toBe(false);
  expect(live.mergeFixes.has(id)).toBe(false);
  expect(live.grants.has(id)).toBe(false);
  expect(live.guides.has(id)).toBe(false);
}

describe('LiveSessions tokens', () => {
  it('resolves a token to the session behind it', () => {
    const live = new LiveSessions();
    const token = live.issueToken(sessionOf('s1'));
    expect(live.resolveToken(token)).toEqual({
      sessionId: 's1',
      projectKey: 'PM',
      member: 'dev',
      taskKey: 'PM-1',
    });
    expect(live.resolveToken('unknown')).toBeNull();
  });

  it('has no task key for a session that is not on a task', () => {
    const live = new LiveSessions();
    const token = live.issueToken(sessionOf('s1', { type: 'general' }));
    expect(live.resolveToken(token)?.taskKey).toBeNull();
  });

  it('revokes the old token when the session gets a new one', () => {
    const live = new LiveSessions();
    const first = live.issueToken(sessionOf('s1'));
    const second = live.issueToken(sessionOf('s1'));
    expect(second).not.toBe(first);
    expect(live.resolveToken(first)).toBeNull();
    expect(live.resolveToken(second)?.sessionId).toBe('s1');
  });

  it('revokes only the token of the session named', () => {
    const live = new LiveSessions();
    const one = live.issueToken(sessionOf('s1'));
    const two = live.issueToken(sessionOf('s2'));
    live.revokeToken('s1');
    expect(live.resolveToken(one)).toBeNull();
    expect(live.resolveToken(two)?.sessionId).toBe('s2');
    live.revokeToken('s1');
  });
});

describe('LiveSessions first input', () => {
  it('settles as typed', async () => {
    const live = new LiveSessions();
    const waiting = live.awaitFirstInput('s1');
    expect(await outcome(waiting)).toBe('pending');
    live.settleFirstInput('s1', true);
    await expect(waiting).resolves.toBe(true);
  });

  it('settles as not typed', async () => {
    const live = new LiveSessions();
    const waiting = live.awaitFirstInput('s1');
    live.settleFirstInput('s1', false);
    await expect(waiting).resolves.toBe(false);
  });

  it('settles the earlier waiter as not typed when the session waits again', async () => {
    const live = new LiveSessions();
    const first = live.awaitFirstInput('s1');
    const second = live.awaitFirstInput('s1');
    await expect(first).resolves.toBe(false);
    expect(await outcome(second)).toBe('pending');
    live.settleFirstInput('s1', true);
    await expect(second).resolves.toBe(true);
  });

  it('ignores a settle with no waiter', () => {
    const live = new LiveSessions();
    expect(() => live.settleFirstInput('s1', true)).not.toThrow();
  });
});

describe('LiveSessions.startFailed', () => {
  it('drops what the start set and keeps the stop reason', async () => {
    const live = new LiveSessions();
    const { token, firstInput } = startProcess(live, 's1');
    live.startFailed('s1');
    holdsNothing(live, 's1');
    expect(live.resolveToken(token)).toBeNull();
    await expect(firstInput).resolves.toBe(false);
    expect(live.stopReasons.get('s1')).toEqual({ kind: 'restart', restartFor: 'permission' });
  });

  it('leaves the other sessions alone', () => {
    const live = new LiveSessions();
    startProcess(live, 's1');
    const other = startProcess(live, 's2');
    live.startFailed('s1');
    expect(live.resolveToken(other.token)?.sessionId).toBe('s2');
    expect(live.resuming.has('s2')).toBe(true);
    expect(live.grants.get('s2')).toBe(2);
  });
});

describe('LiveSessions.ended', () => {
  it('returns the stop reason and whether the process resumed, and drops everything', async () => {
    const live = new LiveSessions();
    const { token, firstInput } = startProcess(live, 's1');
    expect(live.ended('s1')).toEqual({
      stop: { kind: 'restart', restartFor: 'permission' },
      resuming: true,
    });
    holdsNothing(live, 's1');
    expect(live.stopReasons.has('s1')).toBe(false);
    expect(live.resolveToken(token)).toBeNull();
    await expect(firstInput).resolves.toBe(false);
  });

  it('says there was no stop reason and no resume for a plain process', () => {
    const live = new LiveSessions();
    live.providers.set('s1', 'claude');
    expect(live.ended('s1')).toEqual({ stop: undefined, resuming: false });
    expect(live.providers.has('s1')).toBe(false);
  });

  it('is harmless for a session that is not held', () => {
    const live = new LiveSessions();
    expect(live.ended('s1')).toEqual({ stop: undefined, resuming: false });
  });
});
