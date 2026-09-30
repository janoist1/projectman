import type { Task, TaskStartWaiting } from '@projectman/shared';

/**
 * An automatic session start (a stage hand-over, a message wake-up) that admission may refuse
 * for now; the refused start is kept and retried.
 */
export interface AutomaticStart {
  /** One deferral per key: a later attempt of the same start replaces it. */
  key: string;
  projectKey: string;
  /** The task whose card shows why the start waits; null for a general chat. */
  taskKey: string | null;
  /** Whether the start still applies to its task as it is now (null: it has no task). */
  stillValid(task: Task | null): boolean;
  /** One try, under admission; throws the refusal. */
  run(): Promise<void>;
  /** The member a refused start waits for, once `run` chose one. */
  waitsFor(): string | undefined;
  /** Tries the start again (the retry loop). */
  retry(): Promise<void>;
  /** What is logged when the start is deferred, and when a retry fails. */
  log: { deferred: string; retryFailed: string; fields(): Record<string, unknown> };
}

/** A refused start and why it waits. */
export interface DeferredStart {
  start: AutomaticStart;
  waiting: TaskStartWaiting;
}

/**
 * The automatic starts admission refused with a reason that can clear (the master switch,
 * concurrency, plan usage, capacity), in memory. The messages a wake-up would deliver stay in
 * SQLite regardless.
 */
export class DeferredStarts {
  private readonly entries = new Map<string, DeferredStart>();

  /** Removes and returns the deferral of a start (a new attempt replaces it). */
  take(key: string): DeferredStart | undefined {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry;
  }

  keep(entry: DeferredStart): void {
    this.entries.set(entry.start.key, entry);
  }

  drop(key: string): void {
    this.entries.delete(key);
  }

  /** Whether this very deferral is still kept (a retry may have replaced or dropped it). */
  holds(entry: DeferredStart): boolean {
    return this.entries.get(entry.start.key) === entry;
  }

  /** The deferrals, oldest first. */
  list(): DeferredStart[] {
    return [...this.entries.values()];
  }

  /** Why AI work on the task waits: its earliest deferral that still applies, if any. */
  waitingFor(task: Task): TaskStartWaiting | undefined {
    return this.forTask(task)
      .filter((entry) => entry.start.stillValid(task))
      .map((entry) => entry.waiting)
      .sort((a, b) => a.since.localeCompare(b.since))[0];
  }

  /** Drops the task's deferrals it made obsolete (it moved on or closed), even if it later returns. */
  discardStale(task: Task): void {
    for (const entry of this.forTask(task)) {
      if (!entry.start.stillValid(task)) this.entries.delete(entry.start.key);
    }
  }

  private forTask(task: Task): DeferredStart[] {
    return [...this.entries.values()].filter(
      (entry) => entry.start.projectKey === task.projectKey && entry.start.taskKey === task.key,
    );
  }
}
