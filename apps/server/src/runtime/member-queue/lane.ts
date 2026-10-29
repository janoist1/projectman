import type { MemberQueueItemKind, ProjectConfig, Session, WorkItemRef } from '@projectman/shared';
import type { StoredMemberQueueItem } from '../../db';
import type { EnsureSessionResult, SessionStartCause } from '../sessions';

/**
 * When an item of the lane is done: `delivery` when its text reached a session (the receipt and the item
 * close together), `start` when the session it asked for started, `source` when whatever made the item says
 * so (the item stays `processing` until then), `finish` when the member's turn on it ends.
 */
type MemberQueueCompletion = 'delivery' | 'source' | 'finish' | 'start';

/** What a lane tells the driver about its items; the driver works them (PM-925). */
export interface MemberQueueLane {
  readonly kinds: readonly MemberQueueItemKind[];
  readonly completion: MemberQueueCompletion;
  /** True: a session works one item of the lane at a time; the others wait in the queue. */
  readonly oneAtATime: boolean;
  /** Absent: the lane takes every item of its kinds. Present: only the items it says are its own (lanes may then share a kind). */
  owns?(item: StoredMemberQueueItem): boolean;
  /** Why the session that the item wakes starts. */
  cause(item: StoredMemberQueueItem): SessionStartCause;
  /**
   * Several lanes may serve one kind: the first whose `owns` and `appliesTo` do not say no takes the item.
   * `appliesTo` also reads the project's configuration (who the Operator is). Absent: no say on that.
   */
  appliesTo?(item: StoredMemberQueueItem, config: ProjectConfig): boolean;
  /** The text the member is given; null: the lane delivers its items itself (`deliverLive`, `start`). */
  render(item: StoredMemberQueueItem): string | null;
  /** The text of the items that go in together (a lane that is not `oneAtATime`); absent: each item's `render`. */
  renderBatch?(items: StoredMemberQueueItem[]): string;
  /** False: the source no longer asks for the item; it is closed as cancelled. */
  stillOwed(item: StoredMemberQueueItem): boolean;
  /** A code while something holds the item back (it is neither delivered nor woken for), else null. */
  hold(item: StoredMemberQueueItem): Promise<string | null>;
  /**
   * `hold` for a whole run of the member's queue at once, by item id; absent: `hold` per item. A lane whose
   * hold reads shared state answers all its items from one reading, so the cost does not grow with the queue.
   */
  holdAll?(items: StoredMemberQueueItem[]): Promise<Map<string, string | null>>;
  /** Whether the item wakes the member now; absent: the stored flag. */
  wakes?(item: StoredMemberQueueItem, config: ProjectConfig): boolean;
  /** Where the item goes now that its place is gone: another place, `closed` (cancelled), or null (it stays). */
  relocate?(item: StoredMemberQueueItem): WorkItemRef | 'closed' | null;
  /** The item was moved to `place`: the lane keeps what it keeps about the place in step. */
  moved?(item: StoredMemberQueueItem, place: WorkItemRef): void;
  /** A lane that renders nothing types its items into the member's live session itself. */
  deliverLive?(session: Session, items: StoredMemberQueueItem[]): void;
  /** A lane that brings its own first input starts the session through `run` itself. */
  start?(args: {
    config: ProjectConfig;
    member: string;
    place: WorkItemRef;
    items: StoredMemberQueueItem[];
    run(messages: string[]): Promise<EnsureSessionResult>;
  }): Promise<void>;
  /** Starts a null-rendering item through admission.attempt, outside the driver's admission lock (PM-927). */
  attemptStart?(
    item: StoredMemberQueueItem,
  ): Promise<{ kind: 'started' } | { kind: 'deferred'; code: string } | { kind: 'closed' }>;
  /** The item reached the session: runs in the transaction that closes it (or claims it). */
  delivered?(item: StoredMemberQueueItem, sessionId: string, at: string): void;
  /** The start was refused for good: wait for the next attempt (default), or close the item. */
  refused?(item: StoredMemberQueueItem, code: string): Promise<'wait' | 'closed'>;
  /** The item was started `MEMBER_QUEUE_MAX_ATTEMPTS` times in vain; absent: it is handed off. */
  exhausted?(item: StoredMemberQueueItem): Promise<void>;
  /**
   * The start was deferred for `code` (a limit, a pause, a login): the item's source can show why. `closed`: the
   * lane closed the item itself and it does not wait (default `wait`).
   */
  deferred?(
    item: StoredMemberQueueItem,
    code: string,
    at: string,
  ): void | 'wait' | 'closed' | Promise<void | 'wait' | 'closed'>;
  /** Once, when the driver first looks at the queues (the server started). */
  started?(): Promise<void>;
}

/** The queue's driver (PM-925): wakes the members whose queues hold work, and works the items through. */
export interface MemberQueueDriver {
  /** Works the member's queue through; idempotent, one run at a time per member. */
  ensure(projectKey: string, member: string, options?: { deliver?: boolean; net?: boolean }): Promise<void>;
  /** `ensure` for every member that has an open item: the net under every event that could be lost. */
  sweep(options?: { respectPause?: boolean }): Promise<void>;
  register(lane: MemberQueueLane): void;
  /** The member was renamed (PM-1025): forgets what the driver remembers under the old handle. */
  memberRenamed(projectKey: string, from: string): void;
}
