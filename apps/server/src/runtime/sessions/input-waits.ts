import type { Session } from '@projectman/shared';
import { isoNow } from '../../domain/context';
import type { DomainContext } from '../../domain/context';
import type { InputStallAlerts } from '../watchers';
import type { SessionTimers } from './session-timers';

/** A session waiting for input at its terminal this long is reported to the owners (PM-199). */
export const INPUT_STALL_MS = 10 * 60_000;

export interface InputWaitsDeps {
  ctx: DomainContext;
  timers: Pick<SessionTimers, 'arm' | 'disarm'>;
  /** Tells the owners of a session that waits for input unseen; none: nobody is told. */
  alerts?: Pick<InputStallAlerts, 'raise'>;
  /** How long a session may wait before they are told. */
  stallMs: number;
  isPaused: (session: Pick<Session, 'id' | 'projectKey'>) => boolean;
}

/**
 * A session in `waiting_input` holds its messages back, and nothing in the app need show why:
 * after `stallMs` the owners are told (PM-199). The wait is timed from its first state event; a
 * repeated one (a new activity) does not restart it.
 */
export class InputWaits {
  private readonly deps: InputWaitsDeps;
  /** When each session that waits for input began to wait, until the wait is over. */
  private readonly since = new Map<string, string>();

  constructor(deps: InputWaitsDeps) {
    this.deps = deps;
  }

  /** The session's state changed (or a pause ended): starts the wait's timer, or drops it. */
  watch(session: Session): void {
    const waiting = session.state === 'waiting_input';
    const current = this.since.has(session.id);
    if (!waiting) {
      this.forget(session.id);
      return;
    }
    const { alerts, ctx, stallMs, timers } = this.deps;
    if (current || !alerts) return;
    const since = isoNow(ctx);
    this.since.set(session.id, since);
    timers.arm('input', session.id, stallMs, () => {
      this.since.delete(session.id);
      // The wait may have ended some other way than a state event: nothing to say then.
      if (ctx.repos.sessions.get(session.id)?.state !== 'waiting_input') return;
      // A pause held the session: nobody is to blame for the wait, and `afterPause` watches it again.
      if (this.deps.isPaused(session)) return;
      try {
        const item = alerts.raise(session.id, since, Math.max(1, Math.round(stallMs / 60_000)));
        if (item) ctx.logger.warn({ sessionId: session.id, since }, 'session waits for input unseen');
      } catch (err) {
        ctx.logger.warn({ err, sessionId: session.id }, 'input wait alert failed');
      }
    });
  }

  /** The session ended: its wait is over. */
  ended(sessionId: string): void {
    this.forget(sessionId);
  }

  /** Shutdown: the waits are forgotten (the timers are closed with their set). */
  dispose(): void {
    this.since.clear();
  }

  private forget(sessionId: string): void {
    if (!this.since.delete(sessionId)) return;
    this.deps.timers.disarm('input', sessionId);
  }
}
