/**
 * Work the domain does in the background, so that what caused it does not wait (a stage
 * hand-over after a move, a message wake-up, a plan usage probe). Stopping refuses new work
 * and waits for the work that is running.
 */
export class BackgroundTasks {
  private readonly running = new Set<Promise<void>>();
  private stopped = false;

  /** Starts `work` unless stopping; a failure goes to `onError`. Returns whether it started. */
  run(work: () => Promise<void>, onError: (err: unknown) => void): boolean {
    if (this.stopped) return false;
    let started: Promise<void>;
    try {
      started = work(); // at once: the work may queue for a lock in the order it was caused
    } catch (err) {
      started = Promise.reject(err);
    }
    const task: Promise<void> = started.catch(onError).finally(() => this.running.delete(task));
    this.running.add(task);
    return true;
  }

  /** Accepts work again (after a stop). */
  start(): void {
    this.stopped = false;
  }

  /** Accepts no new work and waits for the running work to settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.running]);
  }
}
