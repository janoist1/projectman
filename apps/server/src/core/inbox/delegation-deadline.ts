/** The longest a timer waits in one go (a `setTimeout` above this fires at once); a longer wait wakes early and re-arms. */
const MAX_WAIT_MS = 2 ** 31 - 1;

/** How soon a sweep that failed is tried again. */
const RETRY_MS = 5000;

/**
 * Runs the delegation sweep when the earliest deadline of a delegated question passes (PM-1374), instead of
 * every second. The deadline is known when the question is created or delivered, so nothing ticks while no
 * delegation waits. A deadline that moved later or a question that was decided only wakes the timer once too
 * early: the sweep then finds nothing due and arms the next deadline. Inert until `start()`.
 */
export class DelegationDeadlineTimer {
  private readonly now: () => number;
  private readonly sweep: () => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt: number | null = null;
  private started = false;

  constructor(deps: {
    now: () => number;
    /** Hands the due questions to a person and calls `note` with the deadlines that are left. */
    sweep: () => Promise<void>;
  }) {
    this.now = deps.now;
    this.sweep = deps.sweep;
  }

  /** Sweeps once, which arms the timer for the earliest deadline that is left. */
  start(): void {
    this.started = true;
    this.fire();
  }

  stop(): void {
    this.started = false;
    this.disarm();
  }

  /** A delegation waits until `dueAt` (epoch milliseconds): the timer moves up if that is sooner than its call. */
  note(dueAt: number): void {
    if (!this.started || (this.dueAt !== null && this.dueAt <= dueAt)) return;
    this.disarm();
    this.dueAt = dueAt;
    this.timer = setTimeout(() => this.fire(), Math.min(Math.max(dueAt - this.now(), 0), MAX_WAIT_MS));
    this.timer.unref();
  }

  /** A refresh failed: the sweep runs again in a few seconds. */
  retrySoon(): void {
    this.note(this.now() + RETRY_MS);
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = null;
  }

  private fire(): void {
    this.disarm();
    // The sweep logs what it could not refresh; the next try is soon, so a deadline is never missed.
    this.sweep().catch(() => this.retrySoon());
  }
}
