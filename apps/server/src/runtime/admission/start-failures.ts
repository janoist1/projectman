import { LOCAL_ENGINE_ID, START_FAILURE_LIMIT, startRetryDelayMs } from '@projectman/shared';
import type { AgentProvider, EngineId, Session, WorkItemRef } from '@projectman/shared';
import { encodeWorkItem } from '../../db';
import type { StartFailureRecord } from '../../db';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { conflict } from '../../kernel';
import { countsAsStartFailure, startFailureOf } from './rules';

/** The member's place whose starts are counted: `place` is the session's own work item (`sessionWorkItemOf`). */
export interface StartFailureTarget {
  projectKey: string;
  member: string;
  place: WorkItemRef;
  provider: AgentProvider;
}

/** Why the next automatic start at a place waits (PM-1335). */
export type StartHold =
  | { code: 'start_backoff'; until: string; failures: number; provider: AgentProvider }
  | { code: 'start_failing'; failures: number; provider: AgentProvider; engineId: EngineId | null };

/** What `release` takes back: the stopped places of the filter get one more try. Absent fields match everything. */
export interface StartFailureRelease {
  projectKey?: string;
  member?: string;
  provider?: AgentProvider;
  /** `null` (or the local engine): the local one. */
  engineId?: EngineId | null;
}

const placeOf = (place: WorkItemRef): string => {
  const encoded = encodeWorkItem(place);
  return `${encoded.type}:${encoded.ref}`;
};

const engineKey = (engineId: EngineId | null | undefined): string | null =>
  !engineId || engineId === LOCAL_ENGINE_ID ? null : engineId;

/** The refusal an automatic start gets while its place holds (`start_backoff`, `start_failing`); both can be waited for. */
function startHoldError(hold: StartHold) {
  return hold.code === 'start_backoff'
    ? conflict(
        'start_backoff',
        `the member's starts at this place failed ${hold.failures} times in a row: the next try is after ${hold.until}`,
        { until: hold.until, failures: hold.failures, provider: hold.provider },
      )
    : conflict(
        'start_failing',
        `the member's starts at this place failed ${hold.failures} times in a row: no more automatic tries until someone acts or the provider changes`,
        {
          failures: hold.failures,
          provider: hold.provider,
          ...(hold.engineId ? { engine: hold.engineId } : {}),
        },
      );
}

/**
 * The failed session starts of a member at a place (PM-1335): they are counted when the session could
 * not run (the start failed, or it ended before its first turn). While the count holds, an automatic
 * start waits: 30 s, 1, 2, 4 minutes after the first failures, and no more tries after the fifth until
 * `release`. The counter is in the database, so a backoff survives a server restart. A person's start is
 * never held back; it counts, and its success clears the count.
 */
export class StartFailures {
  private readonly ctx: Pick<DomainContext, 'repos' | 'now'>;
  private readonly engineOf: (projectKey: string, member: string) => EngineId | null | undefined;
  private readonly providerOnHold: (
    provider: AgentProvider,
    engineId: EngineId | null | undefined,
  ) => boolean;
  private readonly awaitsFirstTurn: (sessionId: string) => boolean;
  private released: ((projectKey: string, member: string) => void) | undefined;
  private reachedLimit: ((projectKey: string, member: string, hold: StartHold) => void) | undefined;
  /** Whether the table may hold a row: false (the usual case) spares a query per start; null: not read yet. */
  private rows: boolean | null = null;

  constructor(deps: {
    ctx: Pick<DomainContext, 'repos' | 'now'>;
    /** The engine the member's sessions run on; none: the local one. */
    engineOf: (projectKey: string, member: string) => EngineId | null | undefined;
    /** Whether the provider is in a rate-limit cooldown: a session that ended then did not fail. */
    providerOnHold: (provider: AgentProvider, engineId: EngineId | null | undefined) => boolean;
    awaitsFirstTurn: (sessionId: string) => boolean;
  }) {
    this.ctx = deps.ctx;
    this.engineOf = deps.engineOf;
    this.providerOnHold = deps.providerOnHold;
    this.awaitsFirstTurn = deps.awaitsFirstTurn;
  }

  /** Binds what runs for a member whose stopped place was released (the retries, built after this class). */
  useReleased(released: (projectKey: string, member: string) => void): void {
    this.released = released;
  }

  /** Binds what tells people that a place stopped (the outage watch, built after this class). It runs once per stop. */
  useReachedLimit(reachedLimit: (projectKey: string, member: string, hold: StartHold) => void): void {
    this.reachedLimit = reachedLimit;
  }

  /**
   * Counts one failure of the place; a session counted already counts nothing more (the two counting
   * points see the same failure). Says how the place holds now.
   */
  record(target: StartFailureTarget, failure: { code: string; sessionId: string | null }): StartHold {
    const repo = this.ctx.repos.startFailures;
    const place = placeOf(target.place);
    const existing = repo.get(target.projectKey, target.member, place);
    if (existing && failure.sessionId !== null && existing.lastSessionId === failure.sessionId)
      return this.holdOfRecord(existing);
    const now = isoNow(this.ctx);
    const failures = (existing?.failures ?? 0) + 1;
    const stopped = failures >= START_FAILURE_LIMIT;
    const record: StartFailureRecord = {
      projectKey: target.projectKey,
      member: target.member,
      place,
      provider: target.provider,
      engineId: engineKey(this.engineOf(target.projectKey, target.member)),
      failures,
      lastCode: failure.code.slice(0, 64),
      lastSessionId: failure.sessionId,
      firstAt: existing?.firstAt ?? now,
      lastAt: now,
      retryAt: stopped
        ? null
        : new Date(this.ctx.now().getTime() + startRetryDelayMs(failures)).toISOString(),
      stoppedAt: stopped ? now : null,
    };
    this.rows = true;
    repo.save(record);
    const hold = this.holdOfRecord(record);
    if (stopped && existing?.stoppedAt == null) this.reachedLimit?.(target.projectKey, target.member, hold);
    return hold;
  }

  /** How the place holds now; none: the next automatic start may go ahead. */
  holdOf(target: Pick<StartFailureTarget, 'projectKey' | 'member' | 'place'>): StartHold | null {
    if (!this.mayHoldRows()) return null;
    const row = this.ctx.repos.startFailures.get(target.projectKey, target.member, placeOf(target.place));
    if (!row) return null;
    if (row.stoppedAt === null && row.retryAt !== null && row.retryAt <= isoNow(this.ctx)) return null;
    return this.holdOfRecord(row);
  }

  /**
   * A start is about to try. An automatic one is refused while the place holds. A session is counted once per
   * attempt, not once per id: a restart resumes the session the last attempt failed with, so the id of the last
   * failure is forgotten here.
   */
  beginAttempt(
    target: Pick<StartFailureTarget, 'projectKey' | 'member' | 'place'>,
    automatic: boolean,
  ): void {
    if (!this.mayHoldRows()) return;
    const repo = this.ctx.repos.startFailures;
    const row = repo.get(target.projectKey, target.member, placeOf(target.place));
    if (!row) return;
    if (automatic && (row.stoppedAt !== null || (row.retryAt !== null && row.retryAt > isoNow(this.ctx))))
      throw startHoldError(this.holdOfRecord(row));
    if (row.lastSessionId !== null) repo.save({ ...row, lastSessionId: null });
  }

  /**
   * The catch of a start: counts the failure when it is one, and for an automatic start returns the
   * refusal to throw in its place (it can be waited for, so the start is kept). Any other error comes back unchanged.
   */
  failedStart(err: unknown, target: StartFailureTarget, automatic: boolean): unknown {
    const failure = startFailureOf(err);
    if (!failure) return err;
    const hold = this.record(target, failure);
    return automatic ? startHoldError(hold) : err;
  }

  /** The member's session at the place works: the failures are over. */
  succeeded(target: Pick<StartFailureTarget, 'projectKey' | 'member' | 'place'>): void {
    if (!this.mayHoldRows()) return;
    this.ctx.repos.startFailures.remove(target.projectKey, target.member, placeOf(target.place));
  }

  /** Whether any place of the member stopped at the limit (the outage that tells people watches this). */
  stoppedFor(projectKey: string, member: string): boolean {
    return this.ctx.repos.startFailures
      .list()
      .some((row) => row.projectKey === projectKey && row.member === member && row.stoppedAt !== null);
  }

  /** Whether any place of the provider on the engine stopped at the limit. */
  stoppedOn(provider: AgentProvider, engineId: EngineId | null | undefined): boolean {
    const engine = engineKey(engineId);
    return this.ctx.repos.startFailures
      .list()
      .some((row) => row.stoppedAt !== null && row.provider === provider && row.engineId === engine);
  }

  /**
   * A person or a changed environment gives the stopped places of the filter one more try: the next
   * failure stops them again at once. Says the members it released to `useReleased`.
   */
  release(filter: StartFailureRelease): void {
    const repo = this.ctx.repos.startFailures;
    const now = isoNow(this.ctx);
    const engine = filter.engineId === undefined ? undefined : engineKey(filter.engineId);
    const members = new Map<string, { projectKey: string; member: string }>();
    for (const row of repo.list()) {
      if (row.stoppedAt === null) continue;
      if (filter.projectKey !== undefined && row.projectKey !== filter.projectKey) continue;
      if (filter.member !== undefined && row.member !== filter.member) continue;
      if (filter.provider !== undefined && row.provider !== filter.provider) continue;
      if (engine !== undefined && row.engineId !== engine) continue;
      repo.save({ ...row, failures: START_FAILURE_LIMIT - 1, retryAt: now, stoppedAt: null });
      members.set(`${row.projectKey}\u0000${row.member}`, { projectKey: row.projectKey, member: row.member });
    }
    for (const { projectKey, member } of members.values()) this.released?.(projectKey, member);
  }

  /** A session ended: one that never took its first turn and did not stop on purpose is a failed start. */
  sessionEnded(event: Session & { beforeFirstTurn?: boolean }): void {
    if (!event.beforeFirstTurn || !countsAsStartFailure(event.lastStop) || !event.provider) return;
    // A rate limit that ended the session is the provider's, not the start's.
    if (this.providerOnHold(event.provider, event.engineId)) return;
    this.record(
      { projectKey: event.projectKey, member: event.member, place: event.workItem, provider: event.provider },
      { code: event.lastStop?.code ?? 'exited_before_first_input', sessionId: event.id },
    );
  }

  /** A live session changed state: working (or idle after a turn) shows the place starts well again. */
  stateChanged(session: Session): void {
    const worked =
      session.state === 'working' || (session.state === 'idle' && !this.awaitsFirstTurn(session.id));
    if (worked)
      this.succeeded({ projectKey: session.projectKey, member: session.member, place: session.workItem });
  }

  /** The member's handle changed: the counts of the old handle are of no use. */
  memberRenamed(projectKey: string, from: string): void {
    this.ctx.repos.startFailures.removeMember(projectKey, from);
  }

  private mayHoldRows(): boolean {
    this.rows ??= this.ctx.repos.startFailures.list().length > 0;
    return this.rows;
  }

  private holdOfRecord(row: StartFailureRecord): StartHold {
    const provider = row.provider as AgentProvider;
    if (row.stoppedAt !== null)
      return { code: 'start_failing', failures: row.failures, provider, engineId: row.engineId };
    return { code: 'start_backoff', until: row.retryAt ?? row.lastAt, failures: row.failures, provider };
  }
}
