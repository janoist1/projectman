import type { PauseOutcome } from '../contracts';

/**
 * Pausing a session (PM-218). The state of one pause; the session (session.ts) drives it: it holds
 * the input, answers the tool hooks with a halting answer (or sends Esc), and settles the pause
 * when the session has stopped.
 */

/** What the agent is told when a pause ended its turn after a tool (English: the agent reads it). */
export const PAUSED_AFTER_TOOL = 'Paused by projectman after this tool finished.';

/** What the agent is told when a pause ended its turn before a tool ran (English: the agent reads it). */
export const PAUSED_BEFORE_TOOL =
  'Paused by projectman before this tool ran; it did not run. Run it again after the pause if it is still needed.';

export class PauseState {
  /** `stopping`: the session is still working towards a stop; `stopped`: `outcome` is where it stopped. */
  phase: 'stopping' | 'stopped' = 'stopping';
  outcome: PauseOutcome | null = null;
  /** Where the first halting answer, the end of the turn or a forced Esc stopped the turn. */
  halt: PauseOutcome | null = null;
  /** A halting answer or an Esc went out: the turn is ending, and a release must not drop its nudge. */
  turnEnding = false;
  /** The deadline of the first call: it forces the pause. */
  deadline: NodeJS.Timeout | null = null;
  /** The check that the Stop hook followed a halting answer. */
  stopCheck: NodeJS.Timeout | null = null;
  /** The one Esc of the regular way (Codex), and the one of the forced way. */
  regularEsc = false;
  forced = false;
  /** The deadline passed or `forcePause` was called: the forced Esc goes out as soon as it can. */
  forceRequested = false;
  private waiters: Array<(outcome: PauseOutcome | null) => void> = [];

  /** Where it stopped now, or when it does. */
  result(): Promise<PauseOutcome | null> {
    return this.phase === 'stopped' ? Promise.resolve(this.outcome) : this.wait();
  }

  /** Resolves when the pause settles (the outcome), or when it is taken back (null). */
  wait(): Promise<PauseOutcome | null> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Stopped at `outcome`: wakes the waiters. */
  settle(outcome: PauseOutcome): void {
    this.phase = 'stopped';
    this.outcome = outcome;
    for (const resolve of this.waiters.splice(0)) resolve(outcome);
  }

  /** A stopped session works again: stopping once more, from scratch (no deadline, nothing sent yet). */
  restart(): void {
    this.phase = 'stopping';
    this.outcome = null;
    this.halt = null;
    this.turnEnding = false;
    this.regularEsc = false;
    this.forced = false;
    this.forceRequested = false;
  }

  /** Taken back before the session stopped: the waiters get null. */
  cancel(): void {
    for (const resolve of this.waiters.splice(0)) resolve(null);
  }

  /** Records where the turn stopped, unless that is known already (the first one counts). */
  noteHalt(outcome: PauseOutcome): void {
    this.halt ??= outcome;
  }
}
