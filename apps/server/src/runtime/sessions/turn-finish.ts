import type { Session } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { SessionTimers } from './session-timers';

interface TurnFinishesDeps {
  logger: DomainContext['logger'];
  timers: Pick<SessionTimers, 'arm' | 'disarm'>;
  /** How long the session that moved a task to done may take to finish its turn. */
  limitMs: number;
  /** Cleans a done task up now (`DoneCleanup.run`, without a mover). */
  cleanUp: (projectKey: string, taskKey: string) => void;
}

/**
 * Sessions that moved their task to done in the middle of a turn (PM-190): the task's cleanup runs
 * once the turn ends, or at the limit.
 */
export class TurnFinishes {
  private readonly deps: TurnFinishesDeps;
  private readonly finishing = new Map<string, { projectKey: string; taskKey: string }>();

  constructor(deps: TurnFinishesDeps) {
    this.deps = deps;
  }

  /** Waits for the session's turn to end (`ended`), at most `limitMs`; the first deadline stands. */
  wait(session: Session, taskKey: string): void {
    if (this.finishing.has(session.id)) return;
    this.finishing.set(session.id, { projectKey: session.projectKey, taskKey });
    this.deps.timers.arm('turn', session.id, this.deps.limitMs, () => {
      this.deps.logger.info({ sessionId: session.id, taskKey }, 'done task: the turn limit passed');
      this.ended(session.id);
    });
    this.deps.logger.info({ sessionId: session.id, taskKey }, 'done task: the mover finishes its turn first');
  }

  /** A finishing session is idle, ended or out of time: its done task is cleaned up now. */
  ended(sessionId: string): void {
    const finishing = this.finishing.get(sessionId);
    if (!finishing) return;
    this.finishing.delete(sessionId);
    this.deps.timers.disarm('turn', sessionId);
    this.deps.cleanUp(finishing.projectKey, finishing.taskKey);
  }

  /** Shutdown: the waits are forgotten (the timers are closed with their set). */
  dispose(): void {
    this.finishing.clear();
  }
}
