import type { AiMemberConfig, MemberConfig, ProjectConfig, Session, WorkItemRef } from '@projectman/shared';
import type { WakeStart } from '../../contracts';
import {
  MEMBER_QUEUE_MAX_ATTEMPTS,
  MEMBER_QUEUE_STUCK_MS,
  MEMBER_QUOTA_WAIT_REASONS,
  memberOf,
  memberQueueStartLimits,
  sessionWorkItemOf,
} from '@projectman/shared';
import { encodeWorkItem } from '../../db';
import type { MemberQueueWaitDetails, StoredMemberQueueItem } from '../../db';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import type { MemberQueue } from '../../core/member-queue';
import { DomainError, KeyedMutex } from '../../kernel';
import type { Admission } from '../admission';
import { isDeferrable, waitingOf } from '../admission';
import { LIVE_SESSION_STATES } from '../sessions';
import type { SessionOrchestrator } from '../sessions';
import type { MemberQueueDriver, MemberQueueLane } from './lane';

/** What the driver needs of the rest of the server. */
interface MemberQueueDriverDeps {
  ctx: DomainContext;
  projects: {
    config(projectKey: string): Promise<ProjectConfig>;
  };
  queue: Pick<MemberQueue, 'publish' | 'closeStart'>;
  admission: Pick<Admission, 'exclusive' | 'start'>;
  sessions: Pick<SessionOrchestrator, 'find' | 'findRunning' | 'isRunning' | 'close'>;
  /** Types a rendered item into the idle session; false: the session did not take it. */
  type(session: Session, item: StoredMemberQueueItem, text: string): Promise<boolean>;
  /** Publishes the member's quota wait and its recovery. */
  quotaWaitChanged?: (projectKey: string, member: string) => Promise<void>;
}

/** An open, queued item of the member the driver looks at, with what was decided of it in this run. */
interface Entry {
  item: StoredMemberQueueItem;
  lane: MemberQueueLane;
  place: WorkItemRef;
  /** The code of the hold that keeps it back, else null. */
  held: string | null;
  wakes: boolean;
}

/** What the last run did to start the member's session (the answer of `wake`). */
type StartResult = Exclude<WakeStart, { state: 'starting' }>;

/** A run of one member's queue, with what asked for it: the run that works the queue is the one that was asked. */
interface Run {
  started: boolean;
  promise: Promise<void>;
  /** At a turn boundary: the run types into the member's live sessions. */
  boundary: boolean;
  /** The sweep or a sender that waits for the start asked: no pause after a failed start, a net for the self-delivering lanes. */
  net: boolean;
}

/** What one attempt to start a session came to: the code that refuses it, and whether the start itself failed. */
interface StartAttempt {
  refused: string | null;
  /** What the refusal said besides its code (the provider, the engine, …), kept with the wait. */
  details?: MemberQueueWaitDetails;
  failed?: true;
}

/** The wait an item is left with in a run: the code of what stops it, and what the refusal said. */
interface Wait {
  code: string;
  details?: MemberQueueWaitDetails;
}

/** How long a failed start is left alone by every trigger but the sweep and a sender that waits for it. */
const FAILED_START_PAUSE_MS = 5_000;

/** A lane that does not take every item of its kinds, so another lane may share them. */
const tellsItemsApart = (lane: MemberQueueLane): boolean => Boolean(lane.owns ?? lane.appliesTo);

const placeKeyOf = (member: AiMemberConfig, place: WorkItemRef): string => {
  const encoded = encodeWorkItem(sessionWorkItemOf(member, place));
  return `${encoded.type}:${encoded.ref}`;
};

/** The key of what a run did to start the member's session at a place: the member's key, then the place's. */
const resultKeyOf = (
  projectKey: string,
  handle: string,
  member: MemberConfig | undefined,
  place: WorkItemRef,
): string => {
  const encoded = encodeWorkItem(sessionWorkItemOf(member, place));
  return `${projectKey}\n${handle}\n${encoded.type}:${encoded.ref}`;
};

/**
 * The member queue's driver (PM-925): whatever happens that could give a member something to do (an item
 * queued, a turn over, a hold lifted, a limit gone) comes here as `ensure`, and the member's queue is worked
 * through level by level, not by the event: items that vanished from the queue are closed, the ones a session
 * can take are delivered to it, and the first of the others starts the session it asks for. What cannot be
 * done now stays queued with the code of what stops it (`wait`), and the sweep tries again.
 */
export class MemberQueueWorker implements MemberQueueDriver {
  private readonly deps: MemberQueueDriverDeps;
  /** The lanes of each kind in the order they were registered: a lane that tells its items apart goes before the general one. */
  private readonly lanes = new Map<string, MemberQueueLane[]>();
  private readonly mutex = new KeyedMutex();
  private readonly queuedRuns = new Map<string, Run>();
  /** What the last run did to start a session, by member and place (`resultKeyOf`): one member's places do not share it. */
  private readonly results = new Map<string, StartResult>();
  /**
   * The last start of a member that failed for a reason no wait overcomes. A start fails after it has made and
   * ended a session, which is an event that works the queue again: only the sweep and a sender that waits for the
   * start try again at once, any other trigger within `FAILED_START_PAUSE_MS` does not.
   */
  private readonly failures = new Map<string, { at: number; code: string }>();
  /** The items that went in with a session start whose first input was not typed yet. */
  private readonly awaitingFirstInput = new Set<string>();
  private readonly quotaWaits = new Set<string>();
  private begun = false;

  constructor(deps: MemberQueueDriverDeps) {
    this.deps = deps;
  }

  register(lane: MemberQueueLane): void {
    for (const kind of lane.kinds) {
      const taken = this.lanes.get(kind) ?? [];
      // Lanes share a kind only by telling their items apart (`owns`, `appliesTo`): a lane that takes everything
      // would shadow the ones after it, so the last one registered is the catch-all.
      if (taken.some((other) => !tellsItemsApart(other)))
        throw new Error(`the member queue has a lane for ${kind} already`);
      this.lanes.set(kind, [...taken, lane]);
    }
  }

  /**
   * One run per member at a time; a call that comes while another run still waits for its turn joins that run.
   * A live session takes its items at a turn boundary only: a change of the queue itself (`deliver: false`)
   * wakes whoever has no session, and leaves the ones that have one to their next boundary.
   */
  ensure(
    projectKey: string,
    member: string,
    options: { deliver?: boolean; net?: boolean } = {},
  ): Promise<void> {
    const key = `${projectKey}\n${member}`;
    const boundary = options.deliver !== false;
    const net = options.net === true;
    const queued = this.queuedRuns.get(key);
    // A run that has not begun takes what this call asks for; one that has begun has read its own already.
    if (queued && !queued.started) {
      queued.boundary ||= boundary;
      queued.net ||= net;
      return queued.promise;
    }
    const run: Run = { started: false, promise: Promise.resolve(), boundary, net };
    run.promise = this.mutex.run(key, async () => {
      run.started = true;
      try {
        await this.work(projectKey, member, run);
      } finally {
        const waiting = this.deps.ctx.repos.memberQueue
          .listOpen(projectKey, member)
          .some(
            (item) =>
              item.state === 'queued' &&
              item.wake &&
              MEMBER_QUOTA_WAIT_REASONS.some((reason) => reason === item.wait?.code),
          );
        const previous = this.quotaWaits.has(key);
        if (waiting) this.quotaWaits.add(key);
        else this.quotaWaits.delete(key);
        if (waiting || previous) {
          try {
            await this.deps.quotaWaitChanged?.(projectKey, member);
          } catch (err) {
            this.deps.ctx.logger.warn({ err, projectKey, member }, 'publishing member quota wait failed');
          }
        }
      }
    });
    this.queuedRuns.set(key, run);
    const forget = () => {
      if (this.queuedRuns.get(key) === run) this.queuedRuns.delete(key);
    };
    run.promise.then(forget, forget);
    return run.promise;
  }

  /** The queue items already carry the new handle; what the driver remembers of the old lane goes. */
  memberRenamed(projectKey: string, from: string): void {
    const key = `${projectKey}\n${from}`;
    this.failures.delete(key);
    this.quotaWaits.delete(key);
    this.forgetResults(key);
  }

  /** What the member's runs did to start a session, at every place: a wake clears it to read only its own run's. */
  private forgetResults(memberKey: string): void {
    for (const resultKey of this.results.keys())
      if (resultKey.startsWith(`${memberKey}\n`)) this.results.delete(resultKey);
  }

  /** The timer's sweep: every member with an open item, and a failed start is tried again at once. */
  async sweep(): Promise<void> {
    await this.begin();
    for (const { projectKey, member } of this.deps.ctx.repos.memberQueue.listOpenMembers())
      await this.workOf(projectKey, member, true);
  }

  /**
   * What freed a place, a limit or a hold tries again for the members that wait for one (an item that wakes
   * and carries a wait code), not for every member with an open item: the timer's `sweep` is the one pass over
   * them all. A member's failed start keeps its pause.
   */
  async retryWaiting(): Promise<void> {
    await this.begin();
    const members = new Map<string, { projectKey: string; member: string }>();
    for (const { projectKey, member } of this.deps.ctx.repos.memberQueue.listWaiting())
      members.set(`${projectKey}\n${member}`, { projectKey, member });
    for (const { projectKey, member } of members.values()) await this.workOf(projectKey, member);
  }

  /** The lanes are told once that the driver looks at the queues for the first time. */
  private async begin(): Promise<void> {
    if (this.begun) return;
    this.begun = true;
    for (const lane of new Set([...this.lanes.values()].flat()))
      await lane.started?.().catch((err: unknown) => {
        this.deps.ctx.logger.warn({ err }, 'a member queue lane could not start');
      });
  }

  private workOf(projectKey: string, member: string, net = false): Promise<void> {
    return this.ensure(projectKey, member, { net }).catch((err: unknown) => {
      this.deps.ctx.logger.warn({ err, projectKey, member }, 'working the member queue failed');
    });
  }

  /** Works the queue, and says what became of the start of a session at `workItem`, for a sender that waits for it. */
  async wake(projectKey: string, member: string, workItem: WorkItemRef): Promise<WakeStart> {
    // Asked before anything is awaited: the run this wake gets is the first one after the sender's message.
    this.forgetResults(`${projectKey}\n${member}`);
    const run = this.ensure(projectKey, member, { net: true });
    const config = await this.deps.projects.config(projectKey);
    await run;
    const result = this.results.get(resultKeyOf(projectKey, member, memberOf(config, member), workItem));
    if (result) return result;
    const session = this.deps.ctx.repos.sessions.findByWorkItem(
      projectKey,
      member,
      sessionWorkItemOf(memberOf(config, member), workItem),
    );
    return session && LIVE_SESSION_STATES.includes(session.state)
      ? { state: 'started', sessionId: session.id }
      : { state: 'failed', code: 'not_started' };
  }

  private laneOf(item: StoredMemberQueueItem, config: ProjectConfig): MemberQueueLane | undefined {
    return this.lanes
      .get(item.kind)
      ?.find((lane) => (!lane.owns || lane.owns(item)) && lane.appliesTo?.(item, config) !== false);
  }

  /** The hold code of each item, by item id: a lane's `holdAll` answers its items together, else `hold` each. */
  private async holdsOf(
    owed: { item: StoredMemberQueueItem; lane: MemberQueueLane }[],
  ): Promise<Map<string, string | null>> {
    const holds = new Map<string, string | null>();
    const unknown = (err: unknown, items: StoredMemberQueueItem[]) => {
      this.deps.ctx.logger.warn(
        { err, itemIds: items.map((item) => item.id) },
        'a member queue hold could not be decided',
      );
      for (const item of items) holds.set(item.id, 'hold_unknown');
    };
    const lanes = new Set(owed.map((entry) => entry.lane));
    for (const lane of lanes) {
      const items = owed.filter((entry) => entry.lane === lane).map((entry) => entry.item);
      if (lane.holdAll) {
        try {
          for (const [id, code] of await lane.holdAll(items)) holds.set(id, code);
        } catch (err) {
          unknown(err, items);
        }
        continue;
      }
      for (const item of items) {
        try {
          holds.set(item.id, await lane.hold(item));
        } catch (err) {
          unknown(err, [item]);
        }
      }
    }
    return holds;
  }

  private close(
    item: StoredMemberQueueItem,
    state: 'done' | 'handed_off' | 'cancelled',
    reason: NonNullable<StoredMemberQueueItem['closeReason']>,
    at: string,
  ): void {
    if (item.kind === 'start' && (reason === 'source_closed' || reason === 'started')) {
      this.deps.queue.closeStart(item, reason);
      return;
    }
    this.deps.ctx.repos.memberQueue.closeBySource(item.projectKey, item.source, {
      state,
      reason,
      at,
      member: item.member,
    });
  }

  private async work(projectKey: string, member: string, run: Run): Promise<void> {
    const { ctx } = this.deps;
    const config = await this.deps.projects.config(projectKey);
    const memberConfig = memberOf(config, member);
    const repo = ctx.repos.memberQueue;
    const at = isoNow(ctx);
    let changed = await this.settleProcessing(config, member, at);

    // A member who left the team (a rename moves the items to the new handle first) has no one to hand the items to.
    if (!memberConfig) {
      for (const item of repo.listOpenByUrgency(projectKey, member))
        if (item.state === 'queued') {
          this.close(item, 'cancelled', 'member_removed', at);
          changed = true;
        }
      if (changed) this.deps.queue.publish(projectKey, member);
      return;
    }

    let entries: Entry[] = [];
    const owed: { item: StoredMemberQueueItem; lane: MemberQueueLane; place: WorkItemRef; wakes: boolean }[] =
      [];
    for (const item of repo.listOpenByUrgency(projectKey, member)) {
      const lane = this.laneOf(item, config);
      if (!lane || item.state !== 'queued' || this.awaitingFirstInput.has(item.id)) continue;
      if (!lane.stillOwed(item)) {
        this.close(item, 'cancelled', 'source_closed', at);
        changed = true;
        continue;
      }
      let place = item.place;
      const relocated = lane.relocate?.(item) ?? null;
      if (relocated === 'closed') {
        this.close(item, 'cancelled', 'place_closed', at);
        changed = true;
        continue;
      }
      if (relocated) {
        repo.move(item.id, relocated);
        lane.moved?.(item, relocated);
        place = relocated;
        changed = true;
      }
      const wakes = lane.wakes?.(item, config) ?? item.wake;
      if (wakes !== item.wake) repo.setWake(item.id, wakes);
      owed.push({ item, lane, place, wakes });
    }
    // The holds of one lane are decided together when the lane can (PM-1106): once per run, not once per item.
    const holds = await this.holdsOf(owed);
    for (const { item, lane, place, wakes } of owed)
      entries.push({
        item: { ...item, place, wake: wakes },
        lane,
        place,
        held: holds.get(item.id) ?? null,
        wakes,
      });
    if (memberConfig.kind !== 'ai') {
      if (changed) this.deps.queue.publish(projectKey, member);
      return;
    }

    // Automatic starts own their specifications and admission lock. Every unheld one gets its
    // attempt, even at a live place; the other lanes read the running sessions afterwards.
    const automatic = entries.filter(
      (entry) => entry.lane.attemptStart && entry.lane.render(entry.item) === null,
    );
    entries = entries.filter((entry) => !automatic.includes(entry));
    for (const { item, lane, held } of automatic) {
      if (held) {
        if (item.wait?.code !== held) {
          repo.setWait(item.id, held, at, item.waitDetails ?? undefined);
          changed = true;
        }
        continue;
      }
      const result = await lane.attemptStart!(item);
      if (result.kind !== 'deferred')
        this.close(
          item,
          result.kind === 'started' ? 'done' : 'cancelled',
          result.kind === 'started' ? 'started' : 'source_closed',
          at,
        );
      // The facade's keep owns both the wait code and its details; do not clear them here.
      changed = true;
    }

    // Each wait is noted once per run: the first refusal of the run, else the hold, else none.
    const waits = new Map<string, Wait>();
    for (const entry of entries) if (entry.held) waits.set(entry.item.id, { code: entry.held });

    const places = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = placeKeyOf(memberConfig, entry.place);
      places.set(key, [...(places.get(key) ?? []), entry]);
    }

    const running = new Map<string, Session | null>();
    for (const [key, group] of places)
      running.set(
        key,
        this.deps.sessions.findRunning(projectKey, member, sessionWorkItemOf(memberConfig, group[0]!.place)),
      );

    const memberKey = `${projectKey}\n${member}`;
    const { boundary: atBoundary, net } = run;
    for (const [key, group] of places) {
      const session = running.get(key);
      if (session && atBoundary)
        changed =
          (await this.deliver(
            config,
            session,
            group.filter((e) => !e.held),
            at,
            net,
          )) || changed;
    }

    const waking = entries.filter(
      (e) => e.wakes && !e.held && !running.get(placeKeyOf(memberConfig, e.place)),
    );
    // One session starts per run: a place whose start is refused lets the next place try (a refusal can be about
    // the place: the owner's conversation with the Operator is not held back by a guest's), the first start ends it.
    const failure = this.failures.get(memberKey);
    const paused = !net && !!failure && Date.now() - failure.at < FAILED_START_PAUSE_MS;
    const tried = new Set<string>();
    for (const first of waking) {
      const key = placeKeyOf(memberConfig, first.place);
      if (tried.has(key)) continue;
      tried.add(key);
      const batch = (places.get(key) ?? []).filter((e) => !e.held && e.item.state === 'queued');
      const started: StartAttempt = paused
        ? { refused: failure.code }
        : await this.start(config, memberConfig, first, batch, at);
      if (!paused) {
        if (started.failed && started.refused)
          this.failures.set(memberKey, { at: Date.now(), code: started.refused });
        else this.failures.delete(memberKey);
      }
      changed = true;
      // What would have gone in with the start waits for it too: it does not wake, but it is held back.
      if (started.refused) {
        const wait: Wait = {
          code: started.refused,
          ...(started.details ? { details: started.details } : {}),
        };
        for (const entry of batch) waits.set(entry.item.id, wait);
        if (started.failed || paused) {
          for (const entry of waking) waits.set(entry.item.id, wait);
          break;
        }
        continue;
      }
      for (const entry of batch) waits.delete(entry.item.id);
      break;
    }

    // What waits is told why, and what does not is told nothing: a lifted hold clears its code.
    for (const entry of entries) {
      const wait = waits.get(entry.item.id) ?? null;
      const current = repo.get(entry.item.id);
      if (!current || current.state !== 'queued') continue;
      if (wait === null) {
        if (current.wait && repo.clearWait(entry.item.id)) changed = true;
      } else if (
        current.wait?.code !== wait.code ||
        (wait.details && JSON.stringify(wait.details) !== JSON.stringify(current.waitDetails))
      ) {
        // The time of a wait is when it began: the same code again keeps it.
        repo.setWait(
          entry.item.id,
          wait.code,
          current.wait?.code === wait.code ? current.wait.at : at,
          wait.details,
        );
        changed = true;
      }
    }
    if (changed) this.deps.queue.publish(projectKey, member);
  }

  /**
   * The items a session was working (`processing`) whose session is gone go back to the queue with one attempt
   * more, and the ones it has had for too long are taken from it first. The third attempt is the last.
   */
  private async settleProcessing(config: ProjectConfig, member: string, at: string): Promise<boolean> {
    const { ctx, sessions } = this.deps;
    const repo = ctx.repos.memberQueue;
    const projectKey = config.project.key;
    let changed = false;
    for (const item of repo.listOpenByUrgency(projectKey, member)) {
      if (item.state !== 'processing') continue;
      const lane = this.laneOf(item, config);
      if (!lane) continue;
      const session = item.sessionId ? sessions.find(item.sessionId) : null;
      const alive =
        !!session && LIVE_SESSION_STATES.includes(session.state) && sessions.isRunning(session.id);
      const since = Date.parse(item.startedAt ?? item.restartedAt ?? item.queuedAt);
      if (alive && Date.parse(at) - since <= MEMBER_QUEUE_STUCK_MS) continue;
      if (alive)
        await sessions
          .close(projectKey, session.id, { kind: 'failed', note: 'a work queue item was stuck' })
          .catch((err: unknown) => {
            ctx.logger.warn({ err, itemId: item.id }, 'could not stop the session of a stuck queue item');
          });
      changed = true;
      if (item.attempts + 1 >= MEMBER_QUEUE_MAX_ATTEMPTS) {
        if (lane.exhausted)
          await lane.exhausted(item).catch((err: unknown) => {
            ctx.logger.warn(
              { err, itemId: item.id },
              'a member queue lane could not settle an exhausted item',
            );
          });
        // The lane may have closed the item itself.
        if (repo.get(item.id)?.state === 'processing')
          this.close(item, 'handed_off', 'attempts_exhausted', at);
      } else repo.requeue(item.id, at);
    }
    return changed;
  }

  /**
   * Types the items the session can take. A lane that renders nothing delivers its own: it has its own hooks
   * at the turn boundary, and the driver asks it to only as a net (`net`: the sweep, a sender that waits).
   * Returns whether anything changed.
   */
  private async deliver(
    config: ProjectConfig,
    session: Session,
    group: Entry[],
    at: string,
    net: boolean,
  ): Promise<boolean> {
    const repo = this.deps.ctx.repos.memberQueue;
    let changed = false;
    const selfDelivering = new Map<MemberQueueLane, StoredMemberQueueItem[]>();
    const batches = new Map<MemberQueueLane, StoredMemberQueueItem[]>();
    const busy = new Set<MemberQueueLane>();
    for (const item of repo.listOpenByUrgency(session.projectKey, session.member))
      if (item.state === 'processing' && item.sessionId === session.id) {
        const lane = this.laneOf(item, config);
        if (lane?.oneAtATime) busy.add(lane);
      }
    for (const { item, lane } of group) {
      if (lane.renderBatch) {
        batches.set(lane, [...(batches.get(lane) ?? []), item]);
        continue;
      }
      const text = lane.render(item);
      if (text === null) {
        selfDelivering.set(lane, [...(selfDelivering.get(lane) ?? []), item]);
        continue;
      }
      // At the turn boundary only, and one at a time where the lane says so.
      if (session.state !== 'idle' || busy.has(lane)) continue;
      if (await this.typeItems(session, lane, [item], () => text, at)) {
        changed = true;
        if (lane.oneAtATime) busy.add(lane);
      }
    }
    // The items of a lane that is given its text together go in as one input.
    for (const [lane, items] of batches) {
      if (session.state !== 'idle' || busy.has(lane)) continue;
      if (await this.typeItems(session, lane, items, lane.renderBatch!, at)) changed = true;
    }
    if (net) for (const [lane, items] of selfDelivering) lane.deliverLive?.(session, items);
    return changed;
  }

  /** Types the items (claimed first where the lane's items stay open) as one input; false: the session did not take it. */
  private async typeItems(
    session: Session,
    lane: MemberQueueLane,
    items: StoredMemberQueueItem[],
    render: (items: StoredMemberQueueItem[]) => string,
    at: string,
  ): Promise<boolean> {
    const repo = this.deps.ctx.repos.memberQueue;
    const claims = lane.completion === 'source' || lane.completion === 'finish';
    const taken = claims ? items.filter((item) => repo.claim(item.id, session.id, at)) : items;
    if (taken.length === 0) return false;
    const typed = await this.deps.type(session, taken[0]!, render(taken)).catch(() => false);
    if (!typed) {
      // A failed typing is no attempt of the item: only a session that ended with it (`settleProcessing`) counts.
      if (claims) for (const item of taken) repo.release(item.id);
      return false;
    }
    this.deps.ctx.unitOfWork(() => {
      for (const item of taken) {
        lane.delivered?.(item, session.id, at);
        if (!claims) this.close(item, 'done', lane.completion === 'start' ? 'started' : 'delivered', at);
      }
    });
    return true;
  }

  /** Marks the items delivered once the session they went in with took its first input; until then the runs leave them be. */
  private settleAfterFirstInput(
    firstInput: Promise<boolean>,
    sessionId: string,
    entries: Entry[],
    at: string,
  ): void {
    const { ctx } = this.deps;
    const repo = ctx.repos.memberQueue;
    for (const entry of entries) this.awaitingFirstInput.add(entry.item.id);
    firstInput
      .catch(() => false)
      .then((typed) => {
        for (const entry of entries) this.awaitingFirstInput.delete(entry.item.id);
        if (!typed) return;
        for (const entry of entries) {
          const claims = entry.lane.completion === 'source' || entry.lane.completion === 'finish';
          if (claims && !repo.claim(entry.item.id, sessionId, at)) continue;
          ctx.unitOfWork(() => {
            entry.lane.delivered?.(entry.item, sessionId, at);
            if (!claims)
              this.close(entry.item, 'done', entry.lane.completion === 'start' ? 'started' : 'delivered', at);
          });
        }
        const [first] = entries;
        if (first) this.deps.queue.publish(first.item.projectKey, first.item.member);
      })
      .catch((err: unknown) => {
        ctx.logger.warn({ err, sessionId }, 'marking the items of a started session delivered failed');
      });
  }

  /**
   * One attempt to start the session `first` asks for, with the items of its place that go in with it. A
   * refusal a later attempt can overcome is the answer `refused`: the code every waking item waits with.
   */
  private async start(
    config: ProjectConfig,
    member: AiMemberConfig,
    first: Entry,
    batch: Entry[],
    at: string,
  ): Promise<StartAttempt> {
    const { ctx, admission } = this.deps;
    const repo = ctx.repos.memberQueue;
    const resultKey = resultKeyOf(first.item.projectKey, member.handle, member, first.place);
    const lane = first.lane;
    // Only what the first input carries goes with the start: an item whose lane renders nothing (a message) is
    // delivered by its lane at a turn boundary, and stays queued until then.
    const entries = (
      lane.oneAtATime ? [first] : batch.filter((e) => e.lane === lane || !e.lane.oneAtATime)
    ).filter((e) => e.lane === lane || e.lane.renderBatch || e.lane.render(e.item) !== null);
    const items = entries.map((e) => e.item);
    // The place as the member's session has it: the project manager has one conversation.
    const place = sessionWorkItemOf(member, first.place);
    // The admission lock holds the decision and the process start only: the capacity counts running processes
    // (PM-1108), and whatever a lane reads from an engine for the first input is done outside it.
    const run = (messages: string[]) =>
      admission.exclusive('queue-start', () =>
        admission.start({
          config,
          member,
          workItem: place,
          messages,
          cause: lane.cause(first.item),
          ...memberQueueStartLimits(first.item.kind),
        }),
      );
    // The first input of the session the start made: the items count as delivered only when it was typed.
    const started: { firstInput?: Promise<boolean>; sessionId?: string } = {};
    try {
      if (lane.start) await lane.start({ config, member: member.handle, place, items, run });
      else {
        const texts: string[] = [];
        const batches = new Map<MemberQueueLane, StoredMemberQueueItem[]>();
        for (const e of entries) {
          if (e.lane.renderBatch) {
            batches.set(e.lane, [...(batches.get(e.lane) ?? []), e.item]);
            continue;
          }
          const text = e.lane.render(e.item);
          if (text !== null) texts.push(text);
        }
        for (const [batchLane, batchItems] of batches) texts.push(batchLane.renderBatch!(batchItems));
        const result = await run(texts);
        if (result.messagesSent !== 0 || texts.length === 0) {
          started.firstInput = result.firstInput;
          started.sessionId = result.session.id;
        }
      }
      // The run does not wait for the first input (it arrives with the session's process, or never, and a stop of
      // the instance would wait for it): the items are marked delivered when it was typed, and are left alone
      // until then; one that does not arrive keeps them queued for the sweep.
      if (started.firstInput && started.sessionId)
        this.settleAfterFirstInput(started.firstInput, started.sessionId, entries, at);
    } catch (err) {
      const code = err instanceof DomainError ? err.code : 'start_failed';
      // The member is being renamed (PM-1025): a wait, not a failure; the items carry the new handle after it.
      if (code === 'member_renaming') return { refused: code };
      if (isDeferrable(err)) {
        const waiting = waitingOf(err, { member: member.handle, at });
        this.results.set(resultKey, { state: 'waiting', reason: waiting.reason });
        for (const entry of entries) {
          const verdict = await entry.lane.deferred?.(entry.item, waiting.reason, at);
          // The lane closed the item through its source (or asks to): it does not wait for the next attempt.
          if (verdict === 'closed' && repo.get(entry.item.id)?.state === 'queued')
            this.close(entry.item, 'cancelled', 'source_closed', at);
        }
        // Said when the reason is new, not at every refusal that stays (as the deferred starts do).
        if (entries.some((e) => e.item.wait?.code !== waiting.reason))
          ctx.logger.info(
            {
              projectKey: first.item.projectKey,
              member: member.handle,
              reason: waiting.reason,
              ...(err.code === 'workspace_codex_config'
                ? { issues: (err.details as { issues?: unknown })?.issues }
                : {}),
            },
            'a queued start is deferred',
          );
        // The card shows the member a wait is about (a handoff waits for the old assignee), the item has its own.
        const { reason, since: _since, member: about, ...rest } = waiting;
        return {
          refused: reason,
          details: about && about !== member.handle ? { ...rest, member: about } : rest,
        };
      }
      ctx.logger.warn(
        { err, projectKey: first.item.projectKey, member: member.handle },
        'a queued session start failed',
      );
      this.results.set(resultKey, { state: 'failed', code });
      let closed = false;
      for (const entry of entries) {
        const verdict = (await entry.lane.refused?.(entry.item, code)) ?? 'wait';
        if (verdict === 'closed') {
          this.close(entry.item, 'cancelled', 'source_closed', at);
          closed = true;
        }
      }
      return {
        refused: closed && entries.every((e) => repo.get(e.item.id)?.state !== 'queued') ? null : code,
        failed: true,
      };
    }
    const session = this.deps.sessions.findRunning(first.item.projectKey, member.handle, place);
    if (session) this.results.set(resultKey, { state: 'started', sessionId: session.id });
    return { refused: null };
  }
}
