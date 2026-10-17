import { decodeProjectEventCursor, encodeProjectEventCursor } from '@projectman/shared';
import type { ProjectChangeEvent, ProjectChangeEventsResponse, ProjectChangeKind } from '@projectman/shared';
import type { Repositories } from '../../db';
import { conflict, invalid, unavailable } from '../../kernel';

/** How often a waiting read looks at the journal even without a wake (a safety net, not the mechanism). */
const SAFETY_POLL_MS = 1000;
/** A key that expires is checked this long after its expiry instant. */
const EXPIRY_MARGIN_MS = 5;

export interface ChangeJournalPoll {
  projectKey: string;
  /** The cursor of the last entry the reader has; absent: from the start of the journal. */
  after?: string;
  limit: number;
  waitMs: number;
  /**
   * Checks again that the reader may still read (credential, membership); throws when not. Called
   * on every wake and once more right before the answer is returned.
   */
  recheck(): void | Promise<void>;
  /** Other reasons to check again (a key was revoked); returns how to stop listening. */
  subscribe?: (wake: () => void) => () => void;
  /** Milliseconds until the reader's credential expires, null: never. Asked on every round. */
  expiresInMs?: () => number | null;
  /** The request went away: the wait ends. */
  signal?: AbortSignal;
}

/**
 * The durable project change journal (PM-761): what changed in a project, in the order it
 * committed, readable again with a cursor. An entry is written inside the transaction of the change
 * (a rollback leaves none); the wake only tells waiting readers to look, and a reader always reads
 * the database.
 */
export class ChangeJournal {
  private readonly waiters = new Map<string, Set<() => void>>();
  private stopped = false;
  private readonly repos: Repositories;
  private readonly now: () => Date;

  constructor(repos: Repositories, now: () => Date) {
    this.repos = repos;
    this.now = now;
  }

  /**
   * Writes an entry. Call it inside the unit of work of the change it announces. The wake can go
   * out at once: a waiting reader runs only after the synchronous transaction has ended.
   */
  record(projectKey: string, kind: ProjectChangeKind, entityId: string | null): void {
    this.repos.projectChanges.append(projectKey, kind, entityId, this.now().toISOString());
    this.notify(projectKey);
  }

  /** The server is stopping: waiting readers end with `server_stopping` instead of holding the shutdown up. */
  stop(): void {
    this.stopped = true;
    for (const set of [...this.waiters.values()]) for (const wake of [...set]) wake();
  }

  /** Tells the readers waiting on the project to look at the journal. */
  notify(projectKey: string): void {
    for (const wake of [...(this.waiters.get(projectKey) ?? [])]) wake();
  }

  /** One page, without waiting. */
  read(projectKey: string, after: string | undefined, limit: number): ProjectChangeEventsResponse {
    const generation = this.repos.projectChanges.generation();
    const afterSeq = this.position(projectKey, generation, after);
    const rows = this.repos.projectChanges.list(projectKey, afterSeq, limit);
    const events: ProjectChangeEvent[] = rows.map((row) => ({
      cursor: encodeProjectEventCursor({ generation, projectKey, seq: row.seq }),
      projectKey: row.projectKey,
      kind: row.kind,
      entityId: row.entityId,
      at: row.at,
    }));
    return {
      events,
      nextCursor:
        events.at(-1)?.cursor ?? encodeProjectEventCursor({ generation, projectKey, seq: afterSeq }),
    };
  }

  /**
   * Like `read`, but with nothing to return it waits up to `waitMs` for the first entry. It reads
   * again after it has started listening, so a change that commits in between is never missed.
   */
  async poll(opts: ChangeJournalPoll): Promise<ProjectChangeEventsResponse> {
    let page = this.read(opts.projectKey, opts.after, opts.limit);
    if (page.events.length === 0 && opts.waitMs > 0 && !opts.signal?.aborted) {
      const deadline = Date.now() + opts.waitMs;
      let wake: (() => void) | null = null;
      const woken = () => wake?.();
      const set = this.waiters.get(opts.projectKey) ?? new Set<() => void>();
      this.waiters.set(opts.projectKey, set);
      set.add(woken);
      const stopOther = opts.subscribe?.(woken);
      const onAbort = () => woken();
      opts.signal?.addEventListener('abort', onAbort);
      try {
        for (;;) {
          if (this.stopped) throw unavailable('server_stopping', 'The server is stopping');
          page = this.read(opts.projectKey, opts.after, opts.limit);
          const remaining = deadline - Date.now();
          if (page.events.length > 0 || remaining <= 0 || opts.signal?.aborted) break;
          const expiresIn = opts.expiresInMs?.() ?? null;
          const sleep = Math.min(
            remaining,
            SAFETY_POLL_MS,
            expiresIn === null ? Infinity : Math.max(expiresIn, 0) + EXPIRY_MARGIN_MS,
          );
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, sleep);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = null;
          await opts.recheck();
        }
      } finally {
        opts.signal?.removeEventListener('abort', onAbort);
        stopOther?.();
        set.delete(woken);
        if (set.size === 0) this.waiters.delete(opts.projectKey);
      }
    }
    await opts.recheck();
    return page;
  }

  /** The sequence number a cursor stands for; a cursor that is not this journal's, for this project, is refused. */
  private position(projectKey: string, generation: string, after: string | undefined): number {
    if (after === undefined) return 0;
    const cursor = decodeProjectEventCursor(after);
    if (!cursor || cursor.projectKey !== projectKey)
      throw invalid('invalid_event_cursor', 'The event cursor is not valid for this project');
    // A position behind a journal that is not the one the cursor was issued for (another generation, or
    // an older copy of the database restored under the same one) cannot be continued.
    if (cursor.generation !== generation || cursor.seq > this.repos.projectChanges.latestSeq())
      throw conflict(
        'event_cursor_expired',
        'The event cursor belongs to an earlier journal; read again from the start',
      );
    return cursor.seq;
  }
}
