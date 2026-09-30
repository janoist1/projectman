import type { Session } from '@projectman/shared';

/** A session that still runs (it may be idle between turns); exited and failed ones ended. */
export function isLiveSession(session: Pick<Session, 'state'>): boolean {
  return session.state !== 'exited' && session.state !== 'failed';
}

export type SessionStatus = 'needs_you' | 'working' | 'idle' | 'failed' | 'exited';

/** The status dot of a session: needs you, working, idle between turns, or ended. */
export function sessionStatus(session: Pick<Session, 'state'>, needsYou: boolean): SessionStatus {
  if (needsYou) return 'needs_you';
  if (session.state === 'working') return 'working';
  if (isLiveSession(session)) return 'idle';
  return session.state === 'failed' ? 'failed' : 'exited';
}
