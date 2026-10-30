import { z } from 'zod';
import {
  Actor,
  MemberHandle,
  SESSION_IDLE_CLOSE_MINUTES,
  TaskKey,
  TaskStartWaiting,
  WorkItemRef,
} from '@projectman/shared';
import type { CapacityHolder, ProjectConfig, Task } from '@projectman/shared';
import type { DeferredStartRecord, StoredMemberQueueItem } from '../../db';
import type { StartQueue } from './start-queue';

/**
 * What an automatic start needs to be rebuilt when the server starts again: plain data, stored
 * as JSON next to why the start waits. The kind says which module rebuilds it.
 */
export const StartSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator_signals'), projectKey: z.string() }),
  z.object({ kind: z.literal('question_screening'), projectKey: z.string() }),
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
    /** Resume this interrupted stage owner after an engine restart (PM-1092). */
    resumeMember: MemberHandle.optional(),
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

/** The members a start spec names (the ones whose handle a rename would change). */
function specMembers(spec: StartSpec): string[] {
  switch (spec.kind) {
    case 'provider_resume':
    case 'message_wake':
    case 'handoff_takeover':
      return [spec.handle];
    case 'loop_notice':
      return [spec.watcher];
    case 'work_start':
      return [spec.assignee, spec.developer, spec.actor.handle].filter((h): h is string => !!h);
    case 'hand_over':
      return [spec.actor.handle, spec.resumeMember].filter((h): h is string => !!h);
    default:
      return [];
  }
}

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

/** A member's capacity and what holds its places now; none for a member that has no capacity (not AI). */
type CapacityReader = (
  projectKey: string,
  handle: string,
) => { holders: CapacityHolder[]; capacity: number } | undefined;

/** A queued wake-up (PM-925) that waits for a code a start can wait for, and the card it is about. */
export interface QueueWait {
  projectKey: string;
  taskKey: string | null;
  waiting: TaskStartWaiting;
}

/** What the member queue's wake-ups wait for: they carry the wait on the queue item, not a deferral. */
interface QueueWaitReader {
  all(): QueueWait[];
}

const cardKey = (projectKey: string, taskKey: string | null) => `${projectKey}\0${taskKey}`;

/** The wait of a queued item as a card shows it; null for a code no start waits for (a hold, an unknown one). */
export function queueItemWaiting(item: StoredMemberQueueItem): TaskStartWaiting | null {
  const reason = item.wait ? TaskStartWaiting.shape.reason.safeParse(item.wait.code) : null;
  if (!item.wait || !reason?.success) return null;
  const waiting = TaskStartWaiting.safeParse({
    member: item.member,
    ...item.waitDetails,
    reason: reason.data,
    since: item.wait.at,
  });
  return waiting.success ? waiting.data : { reason: reason.data, since: item.wait.at, member: item.member };
}

/**
 * Where the deferrals no member's queue can hold are kept besides memory (the `deferred_starts`
 * table): the starts that wait for no chosen AI member yet. The others are queue items (PM-927).
 */
interface DeferredStartStore {
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
  private capacityOf: CapacityReader | undefined;
  private queueWaitReader: QueueWaitReader | undefined;
  private readonly queue: StartQueue | undefined;
  private rebuild: ((spec: StartSpec) => AutomaticStart | null) | undefined;
  /** The keys of the starts under a new attempt, with the card each belongs to (none if the deferral was gone). */
  private readonly inFlight = new Map<string, { projectKey: string; taskKey: string | null } | null>();
  /** While many cards are read: the queued waits of every project, by card, loaded once. */
  private waitsByCard: Map<string, TaskStartWaiting[]> | undefined;

  /** `store`: where the deferrals are kept besides memory (none: only in memory). */
  constructor(store?: DeferredStartStore, queue?: StartQueue) {
    this.store = store;
    this.queue = queue;
  }

  /**
   * Takes the deferral of a start for a new attempt, which keeps a new one or ends it. The
   * attempt replaces it, so it leaves this store's view; it stays in SQLite until the attempt
   * settles, so that a restart in the middle of one does not lose the start.
   */
  take(key: string): DeferredStart | undefined {
    const entry = this.entries.get(key) ?? this.fromQueue(key);
    this.entries.delete(key);
    this.inFlight.set(
      key,
      entry ? { projectKey: entry.start.projectKey, taskKey: entry.start.taskKey } : null,
    );
    return entry;
  }

  /**
   * Whether a deferred start of the task is under a new attempt right now. While it runs `waitingFor` is silent
   * (the attempt either settles the wait or keeps a new one), so a reader of the wait uses this to tell
   * "no longer waiting" from "being tried" (PM-455).
   */
  attempting(task: Task): boolean {
    return [...this.inFlight.values()].some(
      (card) => card?.projectKey === task.projectKey && card.taskKey === task.key,
    );
  }

  keep(entry: DeferredStart): void {
    this.inFlight.delete(entry.start.key);
    this.entries.set(entry.start.key, entry);
    const write = () => {
      if (this.queue?.keep(entry)) this.store?.remove(entry.start.key);
      else this.store?.save(recordOf(entry));
    };
    if (this.queue) this.queue.persist(write);
    else write();
  }

  drop(key: string): void {
    this.inFlight.delete(key);
    this.entries.delete(key);
    this.store?.remove(key);
    this.queue?.close(key, false);
  }

  /** The taken start ran successfully; its durable item may now close. */
  started(key: string): void {
    this.inFlight.delete(key);
    this.entries.delete(key);
    this.store?.remove(key);
    this.queue?.close(key, true);
  }

  held(start: AutomaticStart): boolean {
    return this.queue?.held(start) ?? false;
  }

  /** Queued starts are retried by their lane, after the legacy retry round. */
  queued(key: string): boolean {
    return this.queue?.has(key) ?? false;
  }

  /** Whether this very deferral is still kept (a retry may have replaced or dropped it). */
  holds(entry: DeferredStart): boolean {
    return this.entries.get(entry.start.key) === entry;
  }

  /** The deferrals the store keeps, oldest first. A queue-held start is in it too: `restore` and `keep` put it here. */
  list(): DeferredStart[] {
    return [...this.entries.values()];
  }

  /** A start only its queue item holds (it was not kept here), rebuilt from the item. */
  private fromQueue(key: string): DeferredStart | undefined {
    const record = this.queue?.records().find((record) => record.key === key);
    if (!record || this.inFlight.has(key)) return undefined;
    const spec = StartSpec.safeParse(record.spec);
    const waiting = TaskStartWaiting.safeParse(record.waiting);
    const start = spec.success ? this.rebuild?.(spec.data) : null;
    return start && waiting.success ? { start, waiting: waiting.data } : undefined;
  }

  /** Whether a kept deferral of the project names the member: a handle rename waits until none does (PM-1025). */
  names(projectKey: string, handle: string): boolean {
    return this.list().some(
      ({ start, waiting }) =>
        start.projectKey === projectKey &&
        (waiting.member === handle || specMembers(start.spec()).includes(handle)),
    );
  }

  /** Binds what the member queue waits for (built after this store): its wake-ups are never deferred here. */
  useQueueWaits(reader: QueueWaitReader): void {
    this.queueWaitReader = reader;
  }

  /** The queued wake-ups that wait for a code a start can wait for, in every project. */
  queueWaits(): QueueWait[] {
    return this.queueWaitReader?.all() ?? [];
  }

  /**
   * Runs a synchronous read of many cards with the queued waits loaded once, grouped by card: the cards
   * then do not each scan the member queue.
   */
  reading<T>(read: () => T): T {
    if (this.waitsByCard || !this.queueWaitReader) return read();
    const byCard = new Map<string, TaskStartWaiting[]>();
    for (const wait of this.queueWaits()) {
      const key = cardKey(wait.projectKey, wait.taskKey);
      byCard.set(key, [...(byCard.get(key) ?? []), wait.waiting]);
    }
    this.waitsByCard = byCard;
    try {
      return read();
    } finally {
      this.waitsByCard = undefined;
    }
  }

  private queuedWaitsOf(task: Task): TaskStartWaiting[] {
    if (this.waitsByCard) return this.waitsByCard.get(cardKey(task.projectKey, task.key)) ?? [];
    return this.queueWaits()
      .filter((wait) => wait.projectKey === task.projectKey && wait.taskKey === task.key)
      .map((wait) => wait.waiting);
  }

  /** Why AI work on the task waits: its earliest deferral that still applies or its earliest queued wake-up that waits, if any. */
  waitingFor(task: Task): TaskStartWaiting | undefined {
    const waiting = [
      ...this.forTask(task)
        .filter((entry) => entry.start.stillValid(task) && !this.held(entry.start))
        .map((entry) => entry.waiting),
      ...this.queuedWaitsOf(task),
    ].sort((a, b) => a.since.localeCompare(b.since))[0];
    if (waiting?.reason !== 'member_at_capacity' || !waiting.member) return waiting;
    // What holds the member's places is read now, never stored: it shows the present situation (PM-297).
    const capacity = this.capacityOf?.(task.projectKey, waiting.member);
    return capacity ? { ...waiting, ...capacity, closeAfterMinutes: SESSION_IDLE_CLOSE_MINUTES } : waiting;
  }

  /** Binds the reader of a member's capacity and what holds it (built after this store). */
  useCapacity(capacityOf: CapacityReader): void {
    this.capacityOf = capacityOf;
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
    this.rebuild = rebuild;
    let restored = 0;
    let removed = 0;
    for (const record of [...(this.store?.list() ?? []), ...(this.queue?.records() ?? [])]) {
      const spec = StartSpec.safeParse(record.spec);
      const waiting = TaskStartWaiting.safeParse(record.waiting);
      const start = spec.success && waiting.success ? rebuild(spec.data) : null;
      if (!start || !waiting.success) {
        this.drop(record.key);
        removed++;
        continue;
      }
      // A restored factory may choose its member only when run; the persisted wait remembers it.
      const entry = {
        start: { ...start, waitsFor: () => start.waitsFor() ?? waiting.data.member },
        waiting: waiting.data,
      };
      this.keep(entry);
      if (start.key !== record.key) {
        // The key is made up differently than when the start was stored.
        this.entries.delete(record.key);
        this.inFlight.delete(record.key);
        this.store?.remove(record.key);
        this.queue?.retire(record.key);
      }
      restored++;
    }
    return { restored, removed };
  }

  private forTask(task: Task): DeferredStart[] {
    return this.list().filter(
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
