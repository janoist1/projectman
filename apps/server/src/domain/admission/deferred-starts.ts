import { z } from 'zod';
import { Actor, MemberHandle, TaskKey, TaskStartWaiting, WorkItemRef } from '@projectman/shared';
import type { ProjectConfig, Task } from '@projectman/shared';
import type { DeferredStartRecord } from '../../db';

/**
 * What an automatic start needs to be rebuilt when the server starts again: plain data, stored
 * as JSON next to why the start waits. The kind says which module rebuilds it.
 */
export const StartSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator_signals'), projectKey: z.string() }),
  /**
   * Resume the same member's task after a provider quota hold (PM-377) or a lost provider login
   * (PM-467). `after` is missing in rows stored before PM-467: those are quota resumes.
   */
  z.object({
    kind: z.literal('provider_resume'),
    projectKey: z.string(),
    taskKey: TaskKey,
    handle: MemberHandle,
    stageId: z.string(),
    after: z.enum(['quota', 'login']).optional(),
  }),
  /** A stage hand-over: the move into stage `to`, and who made it. */
  z.object({
    kind: z.literal('hand_over'),
    projectKey: z.string(),
    taskKey: TaskKey,
    from: z.string(),
    to: z.string(),
    actor: Actor,
    eventId: z.string().optional(),
  }),
  /**
   * A card moved without an assignee into the work stage `to` (PM-119), by `actor` from `from`:
   * it starts like the Start button does. `assignee` is the member an earlier, partly done
   * attempt of this very start already assigned (so that it is told apart from an assignment
   * someone else made).
   */
  z.object({
    kind: z.literal('work_start'),
    projectKey: z.string(),
    taskKey: TaskKey,
    from: z.string(),
    to: z.string(),
    actor: Actor,
    assignee: MemberHandle.optional(),
    /** A person moved the card after the warning that a prerequisite is open (PM-204): it does not wait for it. */
    despitePrerequisites: z.boolean().optional(),
    /**
     * The Start button on a card whose gate waits for labels an AI member sets (PM-236): the setter's
     * session started, and this start goes ahead once the labels are on. The card is still in
     * `from` (it moves when the start runs), and `developer` is the assignee the person chose.
     */
    afterLabels: z.boolean().optional(),
    developer: MemberHandle.optional(),
  }),
  /**
   * The turn of an AI member for the refinement step `label` of a card (decision 31); `stageId` is
   * the card's stage when it was tried.
   */
  z.object({
    kind: z.literal('refinement_turn'),
    projectKey: z.string(),
    taskKey: TaskKey,
    stageId: z.string(),
    label: z.string(),
  }),
  /** The wake-up of an AI recipient of waiting messages; `stageId` is the task's stage when it was tried. */
  z.object({
    kind: z.literal('message_wake'),
    projectKey: z.string(),
    handle: MemberHandle,
    workItem: WorkItemRef,
    stageId: z.string().nullable(),
  }),
  /** The notice of a loop (PM-261) to the member who holds the scheduling duty, which admission made wait. */
  z.object({
    kind: z.literal('loop_notice'),
    projectKey: z.string(),
    taskKey: TaskKey,
    loopId: z.string(),
    watcher: MemberHandle,
  }),
  /** The start of the receiver of a finished assignee handoff (PM-342); `stageId` is the card's stage when it was tried. */
  z.object({
    kind: z.literal('handoff_takeover'),
    projectKey: z.string(),
    taskKey: TaskKey,
    handoffId: z.string(),
    handle: MemberHandle,
    stageId: z.string(),
  }),
]);
export type StartSpec = z.infer<typeof StartSpec>;

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
  /** What the start needs to be rebuilt after a restart; read when its deferral is stored. */
  spec(): StartSpec;
  /** Whether the start still applies to its task as it is now (null: it has no task). */
  stillValid(task: Task | null): boolean;
  /** One try, under admission; throws the refusal. */
  run(): Promise<void>;
  /** The member a refused start waits for, once `run` chose one. */
  waitsFor(): string | undefined;
  /** Further refusals this start waits for, besides the ones every automatic start waits for. */
  defers?: readonly TaskStartWaiting['reason'][];
  /**
   * Whether the card still lacks what a start that waits for labels (`label_missing`) waits for:
   * it is not retried then, as a retry could only be refused again.
   */
  blocked?(task: Task, config: ProjectConfig): boolean;
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

/** Where the deferrals are kept besides memory (the `deferred_starts` table). */
export interface DeferredStartStore {
  save(record: DeferredStartRecord): void;
  remove(key: string): void;
  /** Oldest first. */
  list(): DeferredStartRecord[];
}

/**
 * The automatic starts admission refused with a reason that can clear (the master switch,
 * concurrency, plan usage, capacity). They are kept in memory and in SQLite, so that a restart
 * does not lose them: what this store holds, the table holds, and `restore` loads it back when
 * the server starts. The messages a wake-up would deliver stay in SQLite regardless.
 */
export class DeferredStarts {
  private readonly entries = new Map<string, DeferredStart>();
  private readonly store: DeferredStartStore | undefined;

  /** `store`: where the deferrals are kept besides memory (none: only in memory). */
  constructor(store?: DeferredStartStore) {
    this.store = store;
  }

  /**
   * Takes the deferral of a start for a new attempt, which keeps a new one or ends it. The
   * attempt replaces it, so it leaves this store's view; it stays in SQLite until the attempt
   * settles, so that a restart in the middle of one does not lose the start.
   */
  take(key: string): DeferredStart | undefined {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry;
  }

  keep(entry: DeferredStart): void {
    this.entries.set(entry.start.key, entry);
    this.store?.save(recordOf(entry));
  }

  drop(key: string): void {
    this.entries.delete(key);
    this.store?.remove(key);
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
      if (!entry.start.stillValid(task)) this.drop(entry.start.key);
    }
  }

  /**
   * Startup: puts the stored deferrals back as they were (why they wait, since when), oldest
   * first. Nothing is tried: the retry does that, under admission. A stored start that cannot
   * be rebuilt (its shape is unknown, or `rebuild` has no task for it any more) is removed.
   */
  restore(rebuild: (spec: StartSpec) => AutomaticStart | null): { restored: number; removed: number } {
    let restored = 0;
    let removed = 0;
    for (const record of this.store?.list() ?? []) {
      const spec = StartSpec.safeParse(record.spec);
      const waiting = TaskStartWaiting.safeParse(record.waiting);
      const start = spec.success && waiting.success ? rebuild(spec.data) : null;
      if (!start || !waiting.success) {
        this.store?.remove(record.key);
        removed++;
        continue;
      }
      const entry = { start, waiting: waiting.data };
      this.entries.set(start.key, entry);
      if (start.key !== record.key) {
        // The key is made up differently than when the start was stored.
        this.store?.remove(record.key);
        this.store?.save(recordOf(entry));
      }
      restored++;
    }
    return { restored, removed };
  }

  private forTask(task: Task): DeferredStart[] {
    return [...this.entries.values()].filter(
      (entry) => entry.start.projectKey === task.projectKey && entry.start.taskKey === task.key,
    );
  }
}

function recordOf({ start, waiting }: DeferredStart): DeferredStartRecord {
  return {
    key: start.key,
    projectKey: start.projectKey,
    taskKey: start.taskKey,
    spec: start.spec(),
    waiting,
  };
}
