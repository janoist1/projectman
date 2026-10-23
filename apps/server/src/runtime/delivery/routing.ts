import {
  DEFAULT_AGENT_PROVIDER,
  isOpenTask,
  isOperator,
  isProjectManager,
  isRefining,
  isTheme,
  memberOf,
  messageRoute,
  messageWakeBlock,
  messageWakes,
  nominalMessagePlace,
  projectRefines,
  routeFor,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type { ProjectConfig, Session, Task, TeamMessage, WorkItemRef } from '@projectman/shared';
import type { EngineDirectory, SentMessageHold, WakeStart } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type {
  MessageHoldName,
  MessagePlace,
  MessagePlacement,
  MessageRefinement,
  MessageRouting,
  RecipientDelivery,
} from '../../core/messages';
import { staleReasonFor, wakeFactsFor } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { DomainError } from '../../kernel';
import type { SessionOrchestrator } from '../sessions';
import type { MessageDelivery } from './delivery';

/** How long a send that asks for the start's result (`awaitWake`) waits for it before it answers "starting" (PM-543). */
export const WAKE_REPLY_WAIT_MS = 5000;

/**
 * What the send needs to wake a recipient and learn the result, and what the end of a hold calls (the member
 * queue's driver, PM-925): the member's queue is worked through, whatever the reason it is looked at again.
 */
interface MessageWaker {
  wake(projectKey: string, handle: string, workItem: WorkItemRef): Promise<WakeStart>;
  ensure(projectKey: string, handle: string): Promise<void>;
}

/** A card-level hold another module answers; who is held stays the router's rule. */
type CardHoldReason = Extract<SentMessageHold, 'fix_limit' | 'full_test'>;
interface CardHold {
  holds(task: Task, config: ProjectConfig): boolean;
}

/** Places recorded messages, applies holds and delivers or wakes their AI recipients. */
export class MessageRouter implements MessageRouting {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: Pick<
    SessionOrchestrator,
    | 'findRunning'
    | 'waitingPermissionFor'
    | 'reviewRoundDue'
    | 'permissionRestartDue'
    | 'isPaused'
    | 'assertProviderCooldown'
  >;
  private readonly delivery: MessageDelivery;
  private readonly refinement: MessageRefinement;
  private readonly engines: Pick<EngineDirectory, 'engineFor' | 'get'> | undefined;
  private readonly cardHolds = new Map<CardHoldReason, CardHold>();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: MessageRouter['sessions'];
    delivery: MessageDelivery;
    refinement: MessageRefinement;
    /** The engines (PM-315): a message to a member whose engine is not connected waits for it. */
    engines?: Pick<EngineDirectory, 'engineFor' | 'get'>;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.delivery = deps.delivery;
    this.refinement = deps.refinement;
    this.engines = deps.engines;
  }

  private waker: MessageWaker | undefined;
  private wakeReplyWaitMs = WAKE_REPLY_WAIT_MS;

  /**
   * Binds the session starts (PM-543): a send with `awaitWake` calls them directly instead of emitting
   * `message_waiting`. They are built after this class. `replyWaitMs` is for tests.
   */
  registerWaker(waker: MessageWaker, replyWaitMs = WAKE_REPLY_WAIT_MS): void {
    this.waker = waker;
    this.wakeReplyWaitMs = replyWaitMs;
  }

  /** A later registration for the same reason replaces the earlier one. */
  registerCardHold(reason: CardHoldReason, hold: CardHold): void {
    this.cardHolds.set(reason, hold);
  }

  deliver(input: {
    config: ProjectConfig;
    projectKey: string;
    message: TeamMessage;
    placements: readonly MessagePlacement[];
    untilInput: boolean;
    awaitWake: boolean;
  }): ReadonlyMap<string, RecipientDelivery> | Promise<ReadonlyMap<string, RecipientDelivery>> {
    const { config, projectKey, message, placements, untilInput, awaitWake } = input;
    const decided = new Map<string, RecipientDelivery>();
    // The wake-ups the send waits for (`awaitWake`): not emitted as events, but started below.
    const awaited: { handle: string; workItem: WorkItemRef }[] = [];
    const waker = awaitWake ? this.waker : undefined;
    for (const { handle, workItem: where, running, hold } of placements)
      decided.set(
        handle,
        hold
          ? { delivery: 'held', hold }
          : this.deliverOrWake(
              config,
              projectKey,
              handle,
              where,
              running,
              message,
              untilInput,
              waker ? () => awaited.push({ handle, workItem: where }) : undefined,
            ),
      );
    // Preserve ordinary send completion timing; only explicit wake-result waits add a promise.
    if (!waker) return decided;
    return Promise.all(
      awaited.map(({ handle, workItem: where }) => this.awaitStart(waker, projectKey, handle, where)),
    ).then((starts) => {
      awaited.forEach(({ handle }, index) => {
        const entry = decided.get(handle);
        if (entry) decided.set(handle, { ...entry, start: starts[index]! });
      });
      return decided;
    });
  }

  /**
   * Where an AI recipient gets a message that is meant for `workItem`, and the running session
   * there to type it into (none: it waits for a wake-up). For a task card, in this order:
   * 1. the recipient's own running session on the card, a closed card's too;
   * 2. on an open card, the running session on an open family card (the parent of a subtask, the
   *    subtasks of a parent), the most recently active one, so a member has no second session on
   *    the same subject; not for an owner of the card's current stage, who has work there;
   * 3. on a closed card or a theme, the recipient's general chat, running or to be woken: no session
   *    starts on a closed card, and a theme has none;
   * 4. else the card itself, to be woken there.
   */
  place(
    projectKey: string,
    config: ProjectConfig,
    handle: string,
    workItem: WorkItemRef,
    ownCard = false,
    from?: string,
  ): MessagePlace {
    // The Operator has one conversation per person who is not an owner, and one for the others (PM-475).
    workItem = nominalMessagePlace(config, handle, workItem, from);
    const own = this.sessions.findRunning(projectKey, handle, workItem);
    if (own || workItem.type !== 'task') return { workItem, running: own };
    // Meant for the work on this card (an analyst check): not for the member's session on a family card.
    if (ownCard) return { workItem, running: null };
    const task = this.tasks.find(projectKey, workItem.taskKey);
    if (!task) return { workItem, running: null };
    // A theme has no session (PM-192), open or closed, so its messages go to the general chat too.
    if (isTheme(task) || !isOpenTask(task)) {
      const general: WorkItemRef = { type: 'general' };
      return { workItem: general, running: this.sessions.findRunning(projectKey, handle, general) };
    }
    const stage = stageOf(config, task.stageId);
    if (stage && stageOwners(config, stage).includes(handle)) return { workItem, running: null };
    let latest: Session | null = null;
    for (const relative of this.tasks.family(projectKey, task.key)) {
      if (!isOpenTask(relative)) continue;
      const session = this.sessions.findRunning(projectKey, handle, { type: 'task', taskKey: relative.key });
      if (session && (!latest || session.lastActivityAt > latest.lastActivityAt)) latest = session;
    }
    return latest ? { workItem: latest.workItem, running: latest } : { workItem, running: null };
  }

  /** Why a message to AI member `handle` is held back when it is sent (PM-144), in the order the holds are checked. */
  holdOf(
    config: ProjectConfig,
    task: Task | null,
    from: string,
    handle: string,
    opts: { readonly duringRefinement?: boolean },
  ): MessageHoldName | null {
    // The project manager runs on the engine too: no engine, no delivery, whatever its other holds are.
    if (this.heldForEngine(config.project.key, handle)) return 'engine';
    if (isProjectManager(memberOf(config, handle)) || isOperator(memberOf(config, handle))) return null;
    if (this.heldForHandoff(task, handle)) return 'handoff';
    if (this.heldForTurn(config, task, handle, opts)) return 'refinement_turn';
    if (this.heldForFixLimit(config, task, from, handle)) return 'fix_limit';
    if (this.heldForFullTest(config, task, from, handle)) return 'full_test';
    return null;
  }

  /**
   * Whether a message to the member waits because the engine its sessions run on is not connected
   * (PM-315): it is stored and typed in, or wakes the member, when the engine is back
   * (`releaseForEngine`). On this machine's own engine nothing waits.
   */
  private heldForEngine(projectKey: string, handle: string): boolean {
    if (!this.engines) return false;
    const engineId = this.engines.engineFor(projectKey, handle);
    return engineId === null || this.engines.get(engineId) === null;
  }

  pendingTaskKeys(projectKey: string, handle: string): string[] {
    return [
      ...new Set(
        this.ctx.repos.messages.pending(projectKey, handle).flatMap((message) => {
          const route = messageRoute(message, handle);
          return route.type === 'task' ? [route.taskKey] : [];
        }),
      ),
    ];
  }

  /**
   * An engine is connected again (PM-315): the messages that waited for it, and every other message
   * that is still waiting for a member that works on it, reach the member the usual way, unless its card
   * holds them back for another reason.
   */
  async releaseForEngine(engineId: string): Promise<void> {
    if (!this.engines || !this.waker) return;
    for (const summary of this.projects.summaries()) {
      const config = await this.projects.config(summary.key);
      for (const member of config.team.members) {
        if (member.kind !== 'ai' || this.engines.engineFor(summary.key, member.handle) !== engineId) continue;
        await this.waker.ensure(summary.key, member.handle);
      }
    }
  }

  /** Why a message to AI member `handle` is held back as it waits (the same holds as at the send), or null. */
  holdNameOf(config: ProjectConfig, task: Task | null, from: string, handle: string): MessageHoldName | null {
    return this.holdOf(config, task, from, handle, {});
  }

  /** How many messages wait for members that work on the engine (PM-315, the engine's settings view). */
  waitingForEngine(engineId: string): number {
    if (!this.engines) return 0;
    let count = 0;
    for (const summary of this.projects.summaries()) {
      const config = this.projects.cachedConfig(summary.key);
      if (!config) continue;
      for (const member of config.team.members) {
        if (member.kind !== 'ai' || this.engines.engineFor(summary.key, member.handle) !== engineId) continue;
        count += this.ctx.repos.messages.pendingCount(summary.key, member.handle);
      }
    }
    return count;
  }

  /**
   * Whether a message to the member a card is being handed over from waits (PM-342): the old session only
   * writes its note now, and the receiver gets the message when the handoff ends.
   */
  private heldForHandoff(task: Task | null, handle: string): boolean {
    return !!task && this.ctx.repos.taskHandoffs.open(task.key)?.from === handle;
  }

  /**
   * Whether a message about `task` waits for its AI recipient's turn (PM-255): the card is being
   * refined and the recipient is not the member whose turn it is (nobody's turn counts too). Looks at
   * the message's own card only.
   */
  private heldForTurn(
    config: ProjectConfig,
    task: Task | null,
    handle: string,
    opts: { readonly duringRefinement?: boolean },
  ): boolean {
    if (opts.duringRefinement || !task || !isRefining(task, config)) return false;
    return this.refinement.turnMember(task.projectKey, task.key) !== handle;
  }

  /**
   * Whether a message to a card's AI assignee waits because the card reached its fix round limit
   * (PM-262): it is stored and not typed in, and wakes nobody until the hold ends. Only a person's
   * message passes; AI members' and the system's (the review watch's send-back) wait.
   */
  private heldForFixLimit(config: ProjectConfig, task: Task | null, from: string, handle: string): boolean {
    if (!task || task.assignee !== handle || memberOf(config, from)?.kind === 'human') return false;
    return this.cardHolds.get('fix_limit')?.holds(task, config) ?? false;
  }

  /**
   * Whether a message to a reviewer of the card's stage waits for the server's full test of the pinned
   * commit (PM-217): it is stored and wakes nobody until the result is in (`releaseWaiting`). A person's
   * message passes, and so does one to the card's developer.
   */
  private heldForFullTest(config: ProjectConfig, task: Task | null, from: string, handle: string): boolean {
    if (!task || task.assignee === handle || memberOf(config, from)?.kind === 'human') return false;
    const stage = stageOf(config, task.stageId);
    if (!stage || !stageOwners(config, stage).includes(handle)) return false;
    return this.cardHolds.get('full_test')?.holds(task, config) ?? false;
  }

  /**
   * The messages that wait for `handle` on a card (held back by its fix round limit or its full test) reach it: typed into
   * its running session, or one wake-up for all of them.
   */
  async releaseWaiting(projectKey: string, _taskKey: string, handle: string): Promise<void> {
    await this.waker?.ensure(projectKey, handle);
  }

  /**
   * A card that is no longer being refined (`refine` taken off, or moved out of the refinement
   * stages): every AI member with messages waiting for it is woken the usual way, or gets them typed
   * into its running session (PM-255). `before` is the card as it was before the change: only a card
   * that was being refined held messages, so any other change leaves the waiting ones alone.
   */
  async releaseHeld(projectKey: string, taskKey: string, before: Task): Promise<void> {
    const task = this.tasks.find(projectKey, taskKey);
    if (!task || !isOpenTask(task) || isTheme(task)) return;
    const config = await this.projects.config(projectKey);
    if (!projectRefines(config) || !isRefining(before, config) || isRefining(task, config)) return;
    const workItem = routeFor(taskKey);
    // One wake-up covers all of a member's messages, which the session it starts takes together.
    for (const member of config.team.members)
      if (member.kind === 'ai') await this.releaseWaiting(projectKey, taskKey, member.handle);
  }

  /**
   * Whether the session's card holds its member's messages back (PM-219): a refinement turn that is not
   * theirs, the fix round limit, or the full test. A resumed session must respect these holds too.
   */
  async holdsMessagesOf(session: Pick<Session, 'projectKey' | 'member' | 'workItem'>): Promise<boolean> {
    if (this.heldForEngine(session.projectKey, session.member)) return true;
    if (session.workItem.type !== 'task') return false;
    const task = this.tasks.find(session.projectKey, session.workItem.taskKey);
    if (!task) return false;
    const config = await this.projects.config(session.projectKey);
    const member = memberOf(config, session.member);
    if (isProjectManager(member) || isOperator(member)) return false;
    return (
      this.heldForHandoff(task, session.member) ||
      this.heldForTurn(config, task, session.member, {}) ||
      this.heldForFixLimit(config, task, 'system', session.member) ||
      this.heldForFullTest(config, task, 'system', session.member)
    );
  }

  /**
   * The messages that came for a session while its pause held it, and that nobody typed in because its
   * process ended meanwhile (PM-219), wake their recipient the usual way, unless the card holds them back.
   */
  async wakeWaiting(session: Pick<Session, 'projectKey' | 'member' | 'workItem'>): Promise<void> {
    await this.waker?.ensure(session.projectKey, session.member);
  }

  /**
   * The wake-up of one recipient, and its result: `starting` when it is not decided within the wait
   * (the start goes on), `failed` when it could not even be tried (PM-543).
   */
  private async awaitStart(
    waker: MessageWaker,
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
  ): Promise<WakeStart> {
    const start = waker.wake(projectKey, handle, workItem).catch((err: unknown): WakeStart => ({
      state: 'failed',
      code: err instanceof DomainError ? err.code : 'start_failed',
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<WakeStart>((resolve) => {
      timer = setTimeout(() => resolve({ state: 'starting' }), this.wakeReplyWaitMs);
    });
    try {
      return await Promise.race([start, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A running recipient gets the message typed in; otherwise it waits for a wake-up. Returns what was decided.
   * `onWake` takes the wake-up from the `message_waiting` event: the caller starts it (PM-543).
   */
  private deliverOrWake(
    config: ProjectConfig,
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    running: Session | null,
    message: TeamMessage,
    untilInput = false,
    onWake?: () => void,
  ): RecipientDelivery {
    const wake = () =>
      onWake
        ? onWake()
        : void this.ctx.events.emit('message_waiting', {
            projectKey,
            handle,
            workItem,
            messageId: message.id,
          });
    const stale = staleReasonFor(this.ctx, config, message, handle);
    const facts = wakeFactsFor(this.ctx, config, message, handle);
    const wakes = messageWakes(message, facts, stale);
    const block = wakes ? null : messageWakeBlock(message, facts, stale);
    const notWoken: RecipientDelivery = {
      delivery: 'next_input',
      ...(block ? { noWake: block } : {}),
      ...(!wakes && !block && (message.kind ?? 'action') === 'info' ? { info: true as const } : {}),
      ...(!wakes && stale ? { stale } : {}),
    };
    if (!running && !wakes) return notWoken;
    const operator = isOperator(memberOf(config, handle));
    // The Operator takes what does not wake it (an information, a blocked message) only with the owner's next
    // one. What wakes it and is not a person's (PM-885) is a queue item of its lane: the driver delivers it.
    if (operator && !wakes) return notWoken;
    if (operator && !facts.fromHuman) {
      wake();
      return { delivery: 'wake' };
    }
    if (running && running.state === 'waiting_permission' && memberOf(config, message.from)?.kind !== 'human')
      return {
        delivery: 'after_turn',
        waitingPermission: this.sessions.waitingPermissionFor(config, running),
      };
    // A reviewer still in a turn of a round that is over gets it after its restart on the new commit,
    // and so does a session that waits for its restart into a new permission mode (PM-170).
    if (running && (this.sessions.reviewRoundDue(running) || this.sessions.permissionRestartDue(running)))
      return { delivery: 'held', hold: 'restart' };
    // A paused session takes it when the pause is over (PM-219); the message is stored meanwhile.
    if (running && this.sessions.isPaused(running)) {
      this.delivery.holdForPause(running, message);
      return { delivery: 'held', hold: 'pause' };
    }
    // An idle session gets a notice before its next input; it is neither woken nor typed into for it (PM-421).
    if (running && untilInput && running.state === 'idle') {
      this.delivery.holdUntilInput(running, message);
      return { delivery: 'next_input' };
    }
    if (running) {
      try {
        this.sessions.assertProviderCooldown(running.provider ?? DEFAULT_AGENT_PROVIDER);
      } catch (err) {
        if (!(err instanceof DomainError) || err.code !== 'provider_rate_limited') throw err;
        if (!wakes) return notWoken;
        wake();
        return { delivery: 'wake' };
      }
      // The Operator's messages go in as one batch (the owner's and the information waiting with it).
      if (!operator && memberOf(config, message.from)?.kind === 'human')
        this.delivery.deliver(running, message);
      else this.delivery.deliverWaiting(running);
      return { delivery: running.state === 'idle' ? 'typed_now' : 'after_turn' };
    }
    wake();
    return { delivery: 'wake' };
  }
}
