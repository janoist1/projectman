import type { SessionStop } from '@projectman/shared';

/**
 * Where a running session stands on closing (PM-288), in one place. In memory only: the next sweep
 * finds a session that is still due. The decision to close stays in `SessionCloser`; this class only
 * holds what it and the orchestrator know about each session.
 *
 * | State                              | Held                   | Enters                   | Leaves                                      |
 * | ---------------------------------- | ---------------------- | ------------------------ | ------------------------------------------- |
 * | open                               | nothing                |                          |                                             |
 * | its step is over (PM-288)          | the `SessionStop`      | `mark`                   | `cancel`, `ended`                           |
 * | waits for the fix (PM-570)         | `awaiting_fix` stop    | `mark` (`workReturned`)  | `cancel` (`requestReviewRound`), `ended`    |
 * | idle, held by a heavy run (PM-569) | the last sighting (ms) | `heavyRunSeen`           | `pruneHeavyRuns` once not idle and running  |
 * | closing                            | a flag                 | `beginClose`             | `ended`                                     |
 *
 * A mark and `closing` are independent: a marked session may be closing as well.
 */
export class CloseStates {
  /** Sessions marked to close at their next idle moment, with the reason. */
  private readonly marks = new Map<string, SessionStop>();
  /** Sessions `SessionOrchestrator.close` is stopping now: nothing is typed into them. */
  private readonly closing = new Set<string>();
  /** When a heavy run of each idle session was last seen (PM-569). */
  private readonly heavyRuns = new Map<string, number>();

  /** The session closes at its next idle moment, for `stop`. */
  mark(sessionId: string, stop: SessionStop): void {
    this.marks.set(sessionId, stop);
  }

  /** Why the session is marked to close; undefined: it is not. */
  markOf(sessionId: string): SessionStop | undefined {
    return this.marks.get(sessionId);
  }

  /** The member gave the work back and the session waits for the fix (PM-570). */
  isAwaitingFix(sessionId: string): boolean {
    return this.marks.get(sessionId)?.kind === 'awaiting_fix';
  }

  /** Takes the mark off; true when there was one. */
  cancel(sessionId: string): boolean {
    return this.marks.delete(sessionId);
  }

  beginClose(sessionId: string): void {
    this.closing.add(sessionId);
  }

  isClosing(sessionId: string): boolean {
    return this.closing.has(sessionId);
  }

  /** Records a sighting of the session's heavy run; true at the first one. */
  heavyRunSeen(sessionId: string, now: number): boolean {
    const first = !this.heavyRuns.has(sessionId);
    this.heavyRuns.set(sessionId, now);
    return first;
  }

  /** Whether the last sighting of the session's heavy run is less than `limitMs` ago. */
  heavyRunHolds(sessionId: string, now: number, limitMs: number): boolean {
    const seen = this.heavyRuns.get(sessionId);
    return seen !== undefined && now - seen < limitMs;
  }

  /** Forgets the sightings of every session that is not in `idleRunning` (idle and running). */
  pruneHeavyRuns(idleRunning: ReadonlySet<string>): void {
    for (const id of [...this.heavyRuns.keys()]) {
      if (!idleRunning.has(id)) this.heavyRuns.delete(id);
    }
  }

  /** The session ended: its mark and `closing` go. A heavy run sighting stays until the sweep prunes it. */
  ended(sessionId: string): void {
    this.marks.delete(sessionId);
    this.closing.delete(sessionId);
  }
}
