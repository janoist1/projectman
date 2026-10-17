export function createMessaging(deps: ConstructorParameters<typeof Messaging>[0]): Messaging {
  return new Messaging(deps);
}

import { createHash } from 'node:crypto';
import {
  cardBusyGroups,
  coordinationActorRefusal,
  DEFAULT_AGENT_PROVIDER,
  formatInjectedTeamMessage,
  hasSuperOrigin,
  isOpenTask,
  isOperator,
  isProjectManager,
  isRefining,
  isTheme,
  labelDefinition,
  memberOf,
  operatorOf,
  ownerHandles,
  messageRoute,
  messageWakeBlock,
  messageWakes,
  operatorConversationOf,
  projectRefines,
  routeFor,
  sameWorkItem,
  sessionWorkItemOf,
  QuestionCloseRule,
  questionPayloadOf,
  quoteOf,
  stageHandsOverForReview,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type {
  Actor,
  CardBusyDetails,
  InboxItem,
  ProjectConfig,
  Session,
  SessionStartCause,
  Task,
  TeamMessage,
  TeamMessageAnswer,
  WorkItemRef,
} from '@projectman/shared';
import { roleLabel, truncate } from '../../agent-text';
import type { EngineDirectory, SentMessageHold, SentMessageRecipient, WakeStart } from '../../contracts';
import type { MessageDeliveryPort, MessageRefinement, MessageSessions } from './ports';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { DomainError, forbidden, invalid, conflict } from '../../kernel';
import type { MessageAttachmentService } from '../../core/attachments';
import type { DomainEventMap } from '../../core/base';
import { answerText } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { actorHandle, aiActor, humanActor, newId, SYSTEM_ACTOR, unique } from '../../kernel';
import type { MessageService } from './messages';
import { recipientHasCardRole, staleReasonFor, wakeFactsFor, wakesFor } from './staleness';

/** How long a send that asks for the start's result (`awaitWake`) waits for it before it answers "starting" (PM-543). */
export const WAKE_REPLY_WAIT_MS = 5000;

export interface SendOptions {
  /** Checks same-role card workers before any send effects (PM-662). External entry points opt in. */
  workerCheck?: boolean;
  origin?: TeamMessage['origin'];
  kind?: TeamMessage['kind'];
  subject?: TeamMessage['subject'];
  /** Who sends it (default: the human `from`). */
  actor?: Actor;
  /** The AI session it was sent from (recorded in the timeline). */
  sessionId?: string | null;
  /** Where AI recipients get it (default: `routeFor(taskKey)`). */
  workItem?: WorkItemRef;
  /**
   * Reaches an AI recipient even when its card is being refined and it is not its turn (PM-255):
   * the answer to the recipient's own question is not held back. Internal, not a contract.
   */
  duringRefinement?: boolean;
  /** Marks the message as the answer to an AI member's question (PM-249): the card thread shows it as one. */
  answer?: TeamMessageAnswer;
  /**
   * Only with `kind: 'info'` (PM-421): an idle running session gets the message before its next input,
   * not at once (a busy one at the end of its turn, as any message). Internal, not a contract.
   */
  untilInput?: boolean;
  /**
   * The message is for the recipient's work on this very card (PM-421): it is not steered to a running
   * session on a family card (`place`, step 2). Internal, not a contract.
   */
  ownCard?: boolean;
  /** The owner's request to the Operator this message is sent during (PM-463). Internal, not a contract. */
  operatorRequest?: string;
  operatorSignal?: string;
  signalActionable?: boolean;
  operatorSignals?: { id: string; actionable: boolean }[];
  /** Runs synchronously in the message transaction, before binding files or recording the message. */
  beforeRecord?: () => void;
  /**
   * The send waits (at most `WAKE_REPLY_WAIT_MS`) for the wake-up of each recipient that gets no running
   * session's input, and reports what became of it (`SentMessageRecipient.start`, PM-543). Without it the
   * wake-up goes on in the background (`message_waiting`) and the send is not slowed. Internal, not a contract.
   */
  awaitWake?: boolean;
  /** Server-owned group fanout only; never accepted from send_message or an HTTP request. */
  questionGroupShare?: { primaryItemId: string; itemId: string };
}

/** What the send needs to wake a recipient and learn the result (`MessageStarts.wake`). */
export interface MessageWaker {
  wake(projectKey: string, handle: string, workItem: WorkItemRef): Promise<WakeStart>;
}

/** What presenting or accepting Operator signals records with the message (PM-593). */
export interface MessageSignals {
  presentation(projectKey: string, signalId: string, by?: string): void;
  decision(projectKey: string, signalId: string, by: string, accepted: boolean): void;
  present(projectKey: string, signalId: string, messageId: string, actionable: boolean): void;
}

type SendReport = { message: TeamMessage; recipients: SentMessageRecipient[] };

interface PreparedSend {
  record(): TeamMessage;
  deliver(message: TeamMessage): SendReport | Promise<SendReport>;
}

/** A card-level hold another module answers; who is held stays messaging's rule. */
export type CardHoldReason = Extract<SentMessageHold, 'fix_limit' | 'full_test'>;
export interface CardHold {
  holds(task: Task, config: ProjectConfig): boolean;
}

/**
 * The one way team messages are sent (REST, the send_message team tool, label and @mention
 * notices, answers to AI questions): validated the same way, recorded with a receipt per
 * recipient, then typed into each AI recipient's running session for the work item, or left
 * waiting for its wake-up through admission (the `message_waiting` domain event). A message about a
 * card that is being refined waits until its AI recipient's turn, or the end of the refinement.
 * Humans read theirs in the app. A message never goes to its own sender.
 */
export class Messaging {
  private messageSignals?: MessageSignals;
  registerSignals(signals: MessageSignals): void {
    this.messageSignals = signals;
  }
  /** A card start mapped to the permanent channel still gives the manager its assignment. */
  async projectManagerStart(
    projectKey: string,
    handle: string,
    taskKey: string,
    cause?: SessionStartCause,
  ): Promise<void> {
    const config = await this.projects.config(projectKey);
    const task = this.tasks.get(projectKey, taskKey);
    await this.send(
      projectKey,
      'system',
      {
        to: [handle],
        taskKey,
        text: `Work on ${task.key}: ${task.title}${startReason(config, cause ?? null)}. Read get_task task_key ${task.key} for the current requirements and act on this assignment.`,
      },
      { actor: SYSTEM_ACTOR, kind: 'action' },
    );
  }

  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: MessageSessions;
  private readonly messages: MessageService;
  private readonly delivery: MessageDeliveryPort;
  private readonly refinement: MessageRefinement;
  private readonly messageAttachments: Pick<
    MessageAttachmentService,
    'assertSendable' | 'bindForSend' | 'shareForQuestionGroupAnswer'
  >;
  private readonly engines: Pick<EngineDirectory, 'engineFor' | 'get'> | undefined;
  private readonly cardHolds = new Map<CardHoldReason, CardHold>();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: MessageSessions;
    messages: MessageService;
    delivery: MessageDeliveryPort;
    refinement: MessageRefinement;
    /** The engines (PM-315): a message to a member whose engine is not connected waits for it. */
    engines?: Pick<EngineDirectory, 'engineFor' | 'get'>;
    /** The files a message carries (PM-516): checked before the message is sent, bound to it as it is recorded. */
    messageAttachments: Pick<
      MessageAttachmentService,
      'assertSendable' | 'bindForSend' | 'shareForQuestionGroupAnswer'
    >;
  }) {
    this.messageAttachments = deps.messageAttachments;
    this.engines = deps.engines;
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.messages = deps.messages;
    this.delivery = deps.delivery;
    this.refinement = deps.refinement;
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

  /**
   * Sends `text` (trimmed, not empty) from `from` to the members `to` (the sender left out, at
   * least one left, all of them members), optionally about a task of the project. Refusals:
   * 400 invalid_request with `details.field` "text" or "to", 404 not_found for unknown members
   * (`details.ids`) or an unknown task.
   */
  async send(
    projectKey: string,
    from: string,
    input: { to: string[]; text: string; taskKey?: string | null; attachmentIds?: string[] },
    opts: SendOptions = {},
  ): Promise<TeamMessage> {
    return (await this.sendReporting(projectKey, from, input, opts)).message;
  }

  /** `send`, and what happens to the message for each recipient (PM-144), in the order of `input.to`. */
  sendReporting(
    projectKey: string,
    from: string,
    input: { to: string[]; text: string; taskKey?: string | null; attachmentIds?: string[] },
    opts: SendOptions = {},
  ): Promise<{ message: TeamMessage; recipients: SentMessageRecipient[] }> {
    return this.prepareSend(projectKey, from, input, opts, (prepared) => prepared.deliver(prepared.record()));
  }

  /** Continue before yielding: ordinary sends record and deliver immediately; groups retain the preparation. */
  private async prepareSend<T>(
    projectKey: string,
    from: string,
    input: { to: string[]; text: string; taskKey?: string | null; attachmentIds?: string[] },
    opts: SendOptions,
    complete: (prepared: PreparedSend) => T | Promise<T>,
  ): Promise<T> {
    const config = await this.projects.config(projectKey);
    const text = input.text.trim();
    const attachmentIds = input.attachmentIds ?? [];
    // Empty text is a message of files alone (PM-516).
    if (!text && attachmentIds.length === 0)
      throw invalid('invalid_request', 'the message text is empty', { field: 'text' });
    const recipients = unique(input.to).filter((handle) => handle !== from);
    if (recipients.length === 0)
      throw invalid('invalid_request', 'the message names no recipient but its sender', { field: 'to' });
    const unknown = recipients.filter((handle) => !memberOf(config, handle));
    if (unknown.length > 0)
      throw new DomainError('not_found', `member not found: ${unknown.join(', ')}`, {
        status: 404,
        details: { what: 'member', id: unknown[0], ids: unknown },
      });
    const coordinator = coordinationActorRefusal(config, opts.actor ?? humanActor(from)) === null;
    const signals =
      opts.operatorSignals ??
      (coordinator && opts.operatorSignal !== undefined
        ? [{ id: opts.operatorSignal, actionable: opts.signalActionable ?? false }]
        : []);
    if (
      opts.operatorSignals !== undefined &&
      (!coordinator ||
        opts.operatorSignal !== undefined ||
        signals.length === 0 ||
        signals.length > 20 ||
        new Set(signals.map((s) => s.id)).size !== signals.length)
    )
      throw invalid('invalid_request', 'invalid signal presentation arguments');
    if (signals.length > 0) {
      const session = opts.sessionId && this.ctx.repos.sessions.get(opts.sessionId);
      if (
        !session ||
        session.projectKey !== projectKey ||
        session.member !== from ||
        session.workItem.type !== 'general' ||
        session.workItem.with
      )
        throw forbidden('project_manager_only', 'signal presentation requires the PM internal conversation');
      if (recipients.some((handle) => !ownerHandles(config).includes(handle)))
        throw invalid('invalid_request', 'signals go only to owners');
      for (const signal of signals) this.messageSignals!.presentation(projectKey, signal.id, from);
    }
    if (opts.operatorSignal !== undefined && !coordinator) {
      const signal = this.ctx.repos.operatorSignals.get(opts.operatorSignal);
      const presentation = signal?.messageId && this.ctx.repos.messages.get(signal.messageId);
      if (
        !ownerHandles(config).includes(from) ||
        (opts.actor && (opts.actor.kind !== 'human' || opts.actor.handle !== from || opts.actor.via)) ||
        recipients.length !== 1 ||
        recipients[0] !== (presentation ? presentation.from : operatorOf(config)?.handle)
      ) {
        throw conflict(
          'operator_signal_closed',
          'only an owner using their own login may accept a signal addressed to the Operator',
        );
      }
    }
    if (!opts.origin) this.assertMayWriteToOperator(config, from, recipients, opts.actor);
    const sender = opts.actor ?? humanActor(from);
    // The files are checked before anything else is done for the message (a refusal leaves nothing behind)
    // and bound to it in its own unit of work below.
    if (attachmentIds.length > 0 && !opts.questionGroupShare)
      this.messageAttachments.assertSendable(projectKey, sender, attachmentIds);
    const taskKey = input.taskKey ?? null;
    const task = taskKey ? this.tasks.get(projectKey, taskKey) : null;
    const humans = recipients.filter((handle) => memberOf(config, handle)?.kind === 'human');
    if (opts.workerCheck && task && isOpenTask(task) && !isTheme(task)) {
      const busy = this.cardBusyOf(config, task, from, recipients, opts);
      if (busy)
        throw conflict(
          'card_busy',
          `${task.key}: ${busy.groups
            .map(
              (group) =>
                `${[...group.working.map((worker) => worker.handle), ...group.joining].join(', ')} already work on it as ${group.role}`,
            )
            .join('; ')}; send again with despiteWorkers: true if the parallel work is intended`,
          busy,
        );
    }
    // The task's developer writing to a reviewer or tester hands over new work (a re-review, a
    // retest): their next round starts from the latest commit (PM-138, the owner's answer).
    if (
      (opts.kind ?? 'action') === 'action' &&
      task &&
      isOpenTask(task) &&
      task.assignee === from &&
      (!opts.workItem || opts.workItem.type === 'task')
    ) {
      // An AI member's message asks a new round only of a recipient with a role on the card (PM-426).
      const fromAi = memberOf(config, from)?.kind === 'ai';
      for (const handle of recipients)
        if (!humans.includes(handle) && (!fromAi || recipientHasCardRole(this.ctx, config, task, handle)))
          this.sessions.requestReviewRound(projectKey, task.key, handle);
      // The task's pinned commit follows the branch (PM-183) when it is the stage's reviewers or
      // testers who were asked: that is a new round, not a branch that moved behind their back.
      const stage = stageOf(config, task.stageId);
      if (stage && stageOwners(config, stage).some((handle) => recipients.includes(handle)))
        await this.tasks.repinReview(projectKey, task.key, from).catch((err: unknown) => {
          this.ctx.logger.warn(
            { err, taskKey: task.key },
            'could not pin the commit of the new review round',
          );
        });
      // A new commit pinned: its full test is queued before the reviewers get this message (PM-217).
      await this.ctx.events.emit('task_review_round', { projectKey, taskKey: task.key, from });
    }
    // Where each AI recipient gets it is decided before it is recorded: the receipt keeps the
    // route when it is not the default place, so the message is found there while it waits.
    const workItem = opts.workItem ?? routeFor(taskKey);
    // A card that is being refined is worked by one member at a time: a message for another member
    // waits for its turn (PM-255) at the card itself, whatever sessions the family has.
    const placed = recipients
      .filter((handle) => !humans.includes(handle))
      .map((handle) => {
        const hold = this.holdOf(config, task, from, handle, opts);
        if (hold) return { handle, hold, workItem: routeFor(taskKey), running: null };
        return {
          handle,
          hold: null,
          ...this.place(projectKey, config, handle, workItem, !!opts.ownCard, from),
        };
      });
    const routes: Record<string, WorkItemRef> = {};
    for (const { handle, workItem: where } of placed)
      if (!sameWorkItem(where, routeFor(taskKey))) routes[handle] = where;
    // The Operator's answer to a question and a forward of one (PM-558) are never stale: they keep no version.
    const unversioned =
      opts.origin?.kind === 'question_forward' ||
      (opts.origin?.kind === 'answer' && memberOf(config, from)?.kind === 'ai');
    const version =
      task && !unversioned
        ? {
            stageId: task.stageId,
            commit: (await this.sessions.sourceHead(config, task))?.commit ?? null,
            reviewCommit: this.tasks.get(projectKey, task.key).reviewPin?.commit ?? null,
          }
        : undefined;
    const record = () =>
      this.ctx.unitOfWork(() => {
        opts.beforeRecord?.();
        if (signals.length > 0) {
          if (coordinationActorRefusal(this.projects.cachedConfig(projectKey)!, sender))
            throw forbidden('project_manager_only', 'the coordination actor changed before presentation');
          for (const signal of signals) this.messageSignals!.presentation(projectKey, signal.id, from);
        }
        if (opts.operatorSignal !== undefined && !coordinator)
          this.messageSignals!.decision(projectKey, opts.operatorSignal, from, true);
        const id =
          opts.answer && recipients.length === 1
            ? `msg_answer_${createHash('sha256')
                .update(JSON.stringify([opts.answer.inboxItemId, recipients[0]]))
                .digest('hex')}`
            : newId('msg');
        const previous = opts.answer ? this.ctx.repos.messages.get(id) : null;
        if (previous) return previous;
        const attachments =
          attachmentIds.length > 0
            ? opts.questionGroupShare
              ? this.messageAttachments.shareForQuestionGroupAnswer(
                  projectKey,
                  opts.questionGroupShare.primaryItemId,
                  opts.questionGroupShare.itemId,
                  attachmentIds,
                )
              : this.messageAttachments.bindForSend(projectKey, sender, attachmentIds, id)
            : undefined;
        const recorded = this.messages.record({
          id,
          projectKey,
          from,
          to: recipients,
          taskKey,
          body: text,
          attachments,
          actor: sender,
          sessionId: opts.sessionId ?? null,
          humanRecipients: humans,
          delivered: recipients.every((handle) => humans.includes(handle)),
          routes,
          answer: opts.answer,
          origin: opts.origin,
          kind: opts.kind ?? 'action',
          subject: opts.subject,
          operatorRequest: opts.operatorRequest,
          operatorSignal: coordinator
            ? signals.length === 1
              ? signals[0]!.id
              : undefined
            : opts.operatorSignal,
          version,
        });
        for (const signal of signals)
          this.messageSignals!.present(projectKey, signal.id, recorded.id, signal.actionable);
        return recorded;
      });
    const deliver = (message: TeamMessage) => {
      const decided = new Map<string, Omit<SentMessageRecipient, 'handle'>>();
      // The wake-ups the send waits for (`awaitWake`): not emitted as events, but started below.
      const awaited: { handle: string; workItem: WorkItemRef }[] = [];
      const waker = opts.awaitWake ? this.waker : undefined;
      for (const { handle, workItem: where, running, hold } of placed)
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
                opts.untilInput === true && opts.kind === 'info',
                waker ? () => awaited.push({ handle, workItem: where }) : undefined,
              ),
        );
      const report = (): SendReport => ({
        message,
        recipients: recipients.map((handle) => ({
          handle,
          ...(decided.get(handle) ?? { delivery: 'inbox' as const }),
        })),
      });
      // Preserve ordinary send completion timing; only explicit wake-result waits add a promise.
      if (!waker) return report();
      return Promise.all(
        awaited.map(({ handle, workItem: where }) => this.awaitStart(waker, projectKey, handle, where)),
      ).then((starts) => {
        awaited.forEach(({ handle }, index) => {
          const entry = decided.get(handle);
          if (entry) decided.set(handle, { ...entry, start: starts[index]! });
        });
        return report();
      });
    };
    return complete({ record, deliver });
  }

  /**
   * A human writes into an AI session's chat: recorded as a team message and typed in as plain
   * text. A stopped session is resumed for it without admission (a person asked), but not
   * while the project's AI work is switched off or the member is on leave (nothing is recorded
   * then: a message sent to the member through `send` waits for the call-back instead); a session
   * that starts takes the text in its first input, so it is not typed again.
   */
  async sendToSession(
    projectKey: string,
    sessionId: string,
    text: string,
    from: string,
    actor: Actor = humanActor(from),
  ): Promise<TeamMessage> {
    const session = this.sessions.get(projectKey, sessionId);
    const body = text.trim();
    if (!body) throw invalid('invalid_request', 'the message text is empty', { field: 'text' });
    const config = await this.projects.config(projectKey);
    this.assertMayWriteToOperator(config, from, [session.member], actor);
    // A person writes into their own conversation with the Operator, not into another person's (PM-475).
    if (
      isOperator(memberOf(config, session.member)) &&
      memberOf(config, from)?.kind === 'human' &&
      !sameWorkItem(session.workItem, operatorConversationOf(config, from))
    )
      throw forbidden(
        'operator_owner_only',
        'a person writes to the Operator only in their own conversation',
      );
    const input = actor.via
      ? formatInjectedTeamMessage(
          from,
          body,
          session.workItem.type === 'task' ? session.workItem.taskKey : null,
          actor.via,
        )
      : body;
    const running = this.sessions.isRunning(session.id);
    const messageId = newId('msg');
    const started = running
      ? null
      : await this.sessions.ensureSession(projectKey, session.member, session.workItem, {
          messages: [input],
          cause: { kind: 'message', by: actor, quote: quoteOf(body), messageId },
        });
    const sentAsFirstInput = (started?.messagesSent ?? 0) > 0;
    // A session about to restart into a new permission mode takes it after the restart (PM-170).
    const held = running && this.sessions.permissionRestartDue(session);
    const message = this.messages.record({
      projectKey,
      from,
      to: [session.member],
      id: messageId,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      body,
      actor,
      sessionId: session.id,
      // A message in the first input of a starting session waits until that input is typed (PM-189).
      delivered: false,
    });
    if (held) this.delivery.holdAsWritten(session, message);
    else if (running && this.sessions.isPaused(session)) {
      // Typed as it was written, once the pause is over (PM-219).
      this.delivery.holdAsWritten(session, message);
      this.delivery.holdForPause(session, message);
    } else if (started && sentAsFirstInput)
      this.delivery.deliverWithFirstInput(session.member, [message], started.firstInput, started.session);
    else this.delivery.deliver(started?.session ?? session, message, input);
    return message;
  }

  /**
   * A person writes to the Operator only with their own login (PM-463, PM-475): through the integrator key
   * it is refused with 403 operator_owner_only. AI members and the system pass: their messages are stored and
   * reach the Operator as information with the owner's next one, and wake nobody.
   */
  private assertMayWriteToOperator(
    config: ProjectConfig,
    from: string,
    recipients: readonly string[],
    actor?: Actor,
  ): void {
    if (!recipients.some((handle) => isOperator(memberOf(config, handle)))) return;
    const sender = memberOf(config, from);
    if (sender?.kind !== 'human') return;
    if (actor?.via)
      throw forbidden('operator_owner_only', "only a person's own login may write to the Operator");
  }

  /** Labels that notify the assignee (e.g. "QA: failed") reach them as a message from whoever set them. */
  async labelNotice(notice: DomainEventMap['task_labels_notice']): Promise<void> {
    const { task, actor } = notice;
    if (!task.assignee) return;
    const config = await this.projects.config(task.projectKey);
    const names = notice.labels.map((id) => labelDefinition(config, id)?.name ?? id);
    await this.send(
      task.projectKey,
      actorHandle(actor),
      {
        to: [task.assignee],
        text: [names.join(', '), notice.comment].filter(Boolean).join('\n\n'),
        taskKey: task.key,
      },
      {
        actor,
        origin: {
          kind: 'label',
          labels: notice.labels,
          eventId: this.ctx.repos.timeline.latestOfType(task.projectKey, task.key, 'task_labels_changed')?.id,
        },
      },
    );
  }

  /**
   * A card's description changed while it is in development or in a review stage (PM-184): every
   * session running on the card, but the one of the member who wrote the change, is told to stop and
   * read it again. A reviewer's review measures the old description, so its session is stopped and
   * resumed at once with the notice as its first input. The notice is not stored as a message. It
   * reaches a session that is in a turn only when the turn ends (the runner queues it): urgent
   * messages into running work are PM-117.
   */
  async descriptionNotice(change: DomainEventMap['task_description_changed']): Promise<void> {
    const { actor } = change;
    const task = this.tasks.find(change.task.projectKey, change.task.key);
    if (!task || !isOpenTask(task)) return;
    const config = await this.projects.config(task.projectKey);
    const stage = stageOf(config, task.stageId);
    const reviewing = stage?.kind === 'step' && stageHandsOverForReview(config, stage);
    if (!stage || (stage.kind !== 'work' && !reviewing)) return;
    const reviewers = reviewing ? stageOwners(config, stage) : [];
    const from = actorHandle(actor);
    const text = `The description of ${task.key} changed (by ${from}). Stop and read it with get_task before you continue.`;
    for (const session of this.sessions.list(task.projectKey, { taskKey: task.key })) {
      if (session.workItem.type !== 'task' || session.member === actor.handle) continue;
      if (!this.sessions.isRunning(session.id)) continue;
      const prefixed = formatInjectedTeamMessage(from, text, task.key);
      // A reviewer that cannot be restarted now (AI work off, on leave) is told like the others.
      if (reviewers.includes(session.member) && task.assignee !== session.member) {
        const restarted = await this.sessions
          .restartWithMessages(task.projectKey, session.id, [prefixed], {
            kind: 'description_changed',
            by: actor,
          })
          .catch((err: unknown) => {
            // The session was stopped before the start failed: there is nothing left to tell.
            this.ctx.logger.warn({ err, sessionId: session.id }, 'could not restart the reviewer');
            return true;
          });
        if (restarted) continue;
      }
      this.delivery.notice(session, from, text, task.key);
    }
  }

  /** The members a task comment mentions get it as a message from its author. */
  async mentionNotice(note: DomainEventMap['task_note_added']): Promise<void> {
    const { event, mentions } = note;
    await this.send(
      event.projectKey,
      actorHandle(event.actor),
      { to: mentions, text: event.data.text as string, taskKey: event.taskKey },
      { actor: event.actor, sessionId: event.sessionId, origin: { kind: 'note', eventId: event.id } },
    );
  }

  /**
   * A member's session started or resumed on a card (PM-249): the card's other workers are told who
   * came, in which role and why. The notice is not stored as a message and starts no session; an idle
   * session keeps it until its next input (`MessageDelivery.noticeOrHold`).
   */
  async joinedNotice(joined: DomainEventMap['task_session_joined']): Promise<void> {
    const { session, resumed, cause } = joined;
    if (session.workItem.type !== 'task') return;
    const task = this.tasks.find(session.projectKey, session.workItem.taskKey);
    if (!task || !isOpenTask(task)) return;
    const config = await this.projects.config(task.projectKey);
    const member = memberOf(config, session.member);
    const role = member?.kind === 'ai' ? roleLabel(member.role, config.team.roles) : session.member;
    const text =
      `\`${session.member}\` (${role}) ${resumed ? 'is working on' : 'started working on'} ${task.key}` +
      `${resumed ? ' again' : ' too'}${startReason(config, cause)}. ` +
      "Coordinate by send_message with the members it concerns, and do not overwrite each other's part.";
    for (const worker of this.sessions.cardWorkers(task.projectKey, task, config))
      if (worker.member !== session.member) this.delivery.noticeOrHold(worker, 'projectman', text, task.key);
  }

  /**
   * An ask_human question on a card was answered (PM-249): the card's other workers get the question
   * and the answer, so that they do not ask it again. The asker gets the answer by `answer`. Not
   * stored as a message, and starts no session.
   */
  async answeredNotice(item: InboxItem): Promise<void> {
    const resolution = item.resolution;
    if (item.kind !== 'question' || !resolution || !item.taskKey) return;
    // A forwarded question is not answered yet: the member it went to answers the asker.
    if (resolution.rule === 'operator_forwarded') return;
    const task = this.tasks.find(item.projectKey, item.taskKey);
    if (!task || !isOpenTask(task)) return;
    const config = await this.projects.config(item.projectKey);
    const workers = this.sessions
      .cardWorkers(task.projectKey, task, config)
      .filter((worker) => worker.member !== item.source);
    if (workers.length === 0) return;
    // The same question the card thread shows (`toCardQuestion`): a blank one falls back to the title.
    const question =
      typeof item.payload.question === 'string' && item.payload.question.trim()
        ? item.payload.question
        : item.title;
    const answer = answerText(item);
    const cut =
      Array.from(question).length > QUESTION_NOTICE_LIMIT || Array.from(answer).length > ANSWER_NOTICE_LIMIT;
    const eventId = cut
      ? this.ctx.repos.timeline
          .listOfTypes(task.projectKey, task.key, ['question_answered'], 20)
          .find((event) => event.data.inboxItemId === item.id)?.id
      : undefined;
    const text =
      `On ${task.key}, \`${item.source}\` asked a person: "${truncate(question, QUESTION_NOTICE_LIMIT)}" ` +
      `\`${resolution.by}\` answered: "${truncate(answer, ANSWER_NOTICE_LIMIT)}". Do not ask it again.` +
      (eventId ? ` If it is cut, read it whole: get_task task_key ${task.key}, event_id ${eventId}.` : '');
    for (const worker of workers) this.delivery.noticeOrHold(worker, 'projectman', text, task.key);
  }

  /**
   * A pending question was closed without an answer (PM-556): its asking member's session, when it runs,
   * is told why and not to wait for the answer. Not stored as a message, and starts no session.
   */
  async closedNotice(item: InboxItem): Promise<void> {
    const rule = QuestionCloseRule.safeParse(item.resolution?.rule);
    if (item.kind !== 'question' || !rule.success || !item.sessionId) return;
    const session = this.sessions.find(item.sessionId);
    if (!session || !this.sessions.isRunning(session.id)) return;
    const question =
      typeof item.payload.question === 'string' && item.payload.question.trim()
        ? item.payload.question
        : item.title;
    const note = item.resolution?.note?.trim();
    const text =
      `Your question "${truncate(question, QUESTION_NOTICE_LIMIT)}" was closed: ${QUESTION_CLOSE_REASONS[rule.data]}. ` +
      `Do not wait for its answer.${note ? ` Note: ${truncate(note, ANSWER_NOTICE_LIMIT)}` : ''}` +
      (rule.data === 'operator_moot' ? ` ${reaskHint(item.id)}` : '');
    await this.delivery.notice(session, 'projectman', text, item.taskKey);
  }

  /**
   * A human answered an AI member's `ask_human` question: the answer goes back to the asking session. The
   * Operator answers one it screens the same way (PM-558): the actor is then the AI member and the text
   * says how to ask a person after all.
   */
  async answer(
    item: InboxItem,
    attachmentIds: readonly string[],
    close: () => InboxItem,
  ): Promise<InboxItem | null> {
    const resolution = item.resolution;
    if (item.kind !== 'question' || !resolution) return null;
    const config = await this.projects.config(item.projectKey);
    const asker = memberOf(config, item.source);
    if (asker?.kind !== 'ai') return null;
    const question = typeof item.payload.question === 'string' ? item.payload.question : item.title;
    const workItem = await this.answerWorkItem(item);
    const byOperator = resolution.rule === 'operator_answered';
    const todo = questionPayloadOf(item)?.screening?.todo;
    let closed: InboxItem | null = null;
    const result = await this.sendReporting(
      item.projectKey,
      resolverSender(resolution),
      {
        to: [asker.handle],
        text:
          todo && !byOperator
            ? `Answer to your question "${question}":\n\nThe Operator turned it into a task for a person: ` +
              `${todo.what} (where: ${todo.where}; expected: ${todo.expected}). The person's result:\n\n${answerText(item)}`
            : `Answer to your question "${question}":\n\n${answerText(item)}` +
              (byOperator
                ? `\n\n(This answer is from the Operator, not from a person. ${reaskHint(item.id)})`
                : ''),
        taskKey: item.taskKey,
        attachmentIds: [...attachmentIds],
      },
      {
        awaitWake: true,
        beforeRecord: () => {
          closed = close();
        },
        sessionId: item.sessionId,
        workItem,
        // The answer to the member's own question is never held back by the refinement line.
        duringRefinement: true,
        actor:
          memberOf(config, resolution.by)?.kind === 'ai' ? aiActor(resolution.by) : resolverActor(resolution),
        origin: { kind: 'answer', inboxItemId: item.id },
        answer: { inboxItemId: item.id, question, answer: answerText(item) },
      },
    );
    const recipient = result.recipients.find((r) => r.handle === asker.handle);
    if (recipient?.start?.state === 'waiting')
      this.messages.recordAnswerDelivery(result.message, asker.handle, {
        state: 'waiting',
        reason: recipient.start.reason,
        since: isoNow(this.ctx),
      });
    else if (
      recipient?.start?.state === 'started' ||
      recipient?.delivery === 'typed_now' ||
      recipient?.delivery === 'after_turn'
    )
      this.messages.recordAnswerDelivery(result.message, asker.handle, {
        state: 'delivered',
        at: isoNow(this.ctx),
      });
    return closed ? this.ctx.repos.inbox.get(item.id) : null;
  }

  /** The same effective route for sending an answer and previewing its admission. */
  async answerWorkItem(item: InboxItem): Promise<WorkItemRef> {
    const config = await this.projects.config(item.projectKey);
    const asker = memberOf(config, item.source);
    const session = item.sessionId ? this.sessions.find(item.sessionId) : null;
    const workItem: WorkItemRef =
      isProjectManager(asker) || isOperator(asker)
        ? { type: 'general' }
        : session?.member === item.source
          ? session.workItem
          : routeFor(item.taskKey);
    return this.place(
      item.projectKey,
      config,
      item.source,
      workItem,
      false,
      item.resolution?.by ?? item.assignees[0],
    ).workItem;
  }

  /** All rows and durable answer messages commit together; delivery starts only after that commit. */
  async answerGroup(items: InboxItem[], attachmentIds: readonly string[], close: () => void): Promise<void> {
    const prepared: PreparedSend[] = [];
    for (const item of items) {
      const resolution = item.resolution!;
      const config = await this.projects.config(item.projectKey);
      if (memberOf(config, item.source)?.kind !== 'ai') continue;
      if (item.taskKey && !this.tasks.find(item.projectKey, item.taskKey)) continue;
      const question = questionPayloadOf(item)?.question ?? item.title;
      const workItem = await this.answerWorkItem(item);
      prepared.push(
        await this.prepareSend(
          item.projectKey,
          resolverSender(resolution),
          {
            to: [item.source],
            taskKey: item.taskKey,
            text: `Answer to your question "${question}":\n\n${answerText(item)}`,
            attachmentIds: [...attachmentIds],
          },
          {
            actor: resolverActor(resolution),
            sessionId: item.sessionId,
            workItem,
            duringRefinement: true,
            origin: { kind: 'answer', inboxItemId: item.id },
            answer: { inboxItemId: item.id, question, answer: answerText(item) },
            ...(prepared.length > 0
              ? {
                  questionGroupShare: {
                    primaryItemId: this.ctx.repos.inbox.groupOf(item.id)!.primaryItemId,
                    itemId: item.id,
                  },
                }
              : {}),
            beforeRecord: () => {
              if (item.taskKey && !this.tasks.find(item.projectKey, item.taskKey))
                throw conflict('question_group_incompatible', 'a source card was deleted before delivery');
            },
          },
          (send) => send,
        ),
      );
    }
    const messages = this.ctx.unitOfWork(() => {
      close();
      return prepared.map((send) => send.record());
    });
    for (const [index, send] of prepared.entries()) await send.deliver(messages[index]!);
  }

  /**
   * The Operator passes a screened question to another member (PM-558): the member gets an action message
   * (origin `question_forward`, so it wakes even with no role on the card) and the asking member an info
   * message saying where it went and how to ask a person after all. `close` runs in the transaction of the
   * message to the recipient. Returns the closed item.
   */
  async forwardQuestion(
    item: InboxItem,
    forward: { to: string; note: string },
    close: () => InboxItem,
  ): Promise<InboxItem | null> {
    const resolution = item.resolution;
    if (item.kind !== 'question' || !resolution) return null;
    const asker = item.source;
    const question = typeof item.payload.question === 'string' ? item.payload.question : item.title;
    const details = typeof item.payload.details === 'string' ? item.payload.details.trim() : '';
    const by = resolution.by;
    let closed: InboxItem | null = null;
    await this.send(
      item.projectKey,
      by,
      {
        to: [forward.to],
        taskKey: item.taskKey,
        text:
          `\`${asker}\` asked a person${item.taskKey ? ` on ${item.taskKey}` : ''}, and the Operator passed the question on to you, ` +
          `because answering it is your part of the work:\n\n${question}` +
          (details ? `\n\nDetails from \`${asker}\`:\n${details}` : '') +
          `\n\nThe Operator's note: ${forward.note}\n\nAnswer \`${asker}\` yourself with send_message.`,
      },
      {
        beforeRecord: () => {
          closed = close();
        },
        kind: 'action',
        actor: aiActor(by),
        origin: { kind: 'question_forward', inboxItemId: item.id },
        duringRefinement: true,
      },
    );
    // The question is closed by now; a failing notice (the asker left the project) must not undo the handling.
    try {
      await this.send(
        item.projectKey,
        by,
        {
          to: [asker],
          taskKey: item.taskKey,
          text:
            `Your question "${truncate(question, QUESTION_NOTICE_LIMIT)}" went to \`${forward.to}\`, not to a person: ` +
            `${forward.note} \`${forward.to}\` answers you with a message. ${reaskHint(item.id)}`,
        },
        {
          kind: 'info',
          actor: aiActor(by),
          duringRefinement: true,
        },
      );
    } catch (err) {
      this.ctx.logger.warn({ err, itemId: item.id }, 'could not tell the asker where the question went');
    }
    return closed;
  }

  /** Predicts who would join this card, using the same holds, placement and wake rule as delivery. */
  private cardBusyOf(
    config: ProjectConfig,
    task: Task,
    from: string,
    recipients: readonly string[],
    opts: SendOptions,
  ): CardBusyDetails | null {
    if ((opts.kind ?? 'action') !== 'action') return null;
    const workers = this.sessions.cardWorkers(task.projectKey, task, config);
    const draft = {
      from,
      taskKey: task.key,
      via: opts.actor?.via,
      origin: opts.origin,
      kind: 'action' as const,
    };
    const joining = recipients.flatMap((handle) => {
      const member = memberOf(config, handle);
      if (member?.kind !== 'ai') return [];
      const role = member.role;
      if (
        isProjectManager(member) ||
        isOperator(member) ||
        workers.some((worker) => worker.member === handle) ||
        this.holdOf(config, task, from, handle, opts)
      )
        return [];
      const placed = this.place(
        task.projectKey,
        config,
        handle,
        opts.workItem ?? routeFor(task.key),
        !!opts.ownCard,
        from,
      );
      if (
        placed.workItem.type !== 'task' ||
        placed.workItem.taskKey !== task.key ||
        (!placed.running && !messageWakes(draft, wakeFactsFor(this.ctx, config, draft, handle), null))
      )
        return [];
      return [{ handle, role }];
    });
    const working = workers.flatMap((worker) => {
      const member = memberOf(config, worker.member);
      return member?.kind === 'ai' && worker.member !== from && worker.member !== task.handoff?.from
        ? [{ handle: worker.member, role: member.role, state: worker.state }]
        : [];
    });
    const groups = cardBusyGroups({ working, joining });
    return groups.length > 0 ? { taskKey: task.key, groups } : null;
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
  private place(
    projectKey: string,
    config: ProjectConfig,
    handle: string,
    workItem: WorkItemRef,
    ownCard = false,
    from?: string,
  ): { workItem: WorkItemRef; running: Session | null } {
    const recipient = memberOf(config, handle);
    // The Operator has one conversation per person who is not an owner, and one for the others (PM-475).
    workItem =
      from !== undefined && isOperator(recipient) && (workItem.type === 'task' || workItem.type === 'general')
        ? operatorConversationOf(config, from)
        : sessionWorkItemOf(recipient, workItem);
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
  private holdOf(
    config: ProjectConfig,
    task: Task | null,
    from: string,
    handle: string,
    opts: SendOptions,
  ): 'handoff' | 'refinement_turn' | 'fix_limit' | 'full_test' | 'engine' | null {
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
    if (!this.engines) return;
    for (const summary of this.projects.summaries()) {
      const config = await this.projects.config(summary.key);
      for (const member of config.team.members) {
        if (member.kind !== 'ai' || this.engines.engineFor(summary.key, member.handle) !== engineId) continue;
        const places: WorkItemRef[] = [];
        for (const message of this.ctx.repos.messages.pending(summary.key, member.handle)) {
          const route = sessionWorkItemOf(member, messageRoute(message, member.handle));
          if (!places.some((place) => sameWorkItem(place, route))) places.push(route);
        }
        for (const workItem of places) {
          if (await this.holdsMessagesOf({ projectKey: summary.key, member: member.handle, workItem }))
            continue;
          const running = this.sessions.findRunning(summary.key, member.handle, workItem);
          for (const message of this.messages.waiting(summary.key, member.handle, workItem))
            this.deliverOrWake(config, summary.key, member.handle, workItem, running, message);
        }
      }
    }
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
        count += this.ctx.repos.messages.pending(summary.key, member.handle).length;
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
  private heldForTurn(config: ProjectConfig, task: Task | null, handle: string, opts: SendOptions): boolean {
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
  async releaseWaiting(projectKey: string, taskKey: string, handle: string): Promise<void> {
    const config = await this.projects.config(projectKey);
    const workItem = sessionWorkItemOf(memberOf(config, handle), routeFor(taskKey));
    const waiting = this.messages.waiting(projectKey, handle, workItem);
    const running = this.sessions.findRunning(projectKey, handle, workItem);
    for (const message of waiting) this.deliverOrWake(config, projectKey, handle, workItem, running, message);
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
    if (await this.holdsMessagesOf(session)) return;
    const config = await this.projects.config(session.projectKey);
    const first = this.messages
      .waiting(session.projectKey, session.member, session.workItem)
      .find((message) => wakesFor(this.ctx, config, message, session.member));
    if (!first) return;
    void this.ctx.events.emit('message_waiting', {
      projectKey: session.projectKey,
      handle: session.member,
      workItem: session.workItem,
      messageId: first.id,
    });
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
  ): Omit<SentMessageRecipient, 'handle'> {
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
    const notWoken: Omit<SentMessageRecipient, 'handle'> = {
      delivery: 'next_input',
      ...(block ? { noWake: block } : {}),
      ...(!wakes && !block && (message.kind ?? 'action') === 'info' ? { info: true as const } : {}),
      ...(!wakes && stale ? { stale } : {}),
    };
    if (!running && !wakes) return notWoken;
    const operator = isOperator(memberOf(config, handle));
    // The Operator takes what does not wake it (an AI member's message) only with the owner's next one (PM-463).
    if (operator && !wakes) return notWoken;
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

/** The actor a question's resolution is delivered as: the super origin when it has one (PM-757). */
function resolverActor(resolution: {
  by: string;
  via?: 'integrator' | undefined;
  actor?: Actor | undefined;
}): Actor {
  if (hasSuperOrigin(resolution.actor)) return resolution.actor;
  return { ...humanActor(resolution.by), ...(resolution.via ? { via: resolution.via } : {}) };
}

/** The sender handle of that answer: the Operator in the super mode, so the message and its actor agree. */
function resolverSender(resolution: { by: string; actor?: Actor | undefined }): string {
  return hasSuperOrigin(resolution.actor) ? resolution.actor.handle : resolution.by;
}

/** How much of a question and of its answer the notice to the card's other workers carries. */
const QUESTION_NOTICE_LIMIT = 200;
const ANSWER_NOTICE_LIMIT = 500;

/** How the asking member gets its question to a person after all, once the Operator handled it (PM-558). */
function reaskHint(inboxItemId: string): string {
  return (
    `If that does not settle it, ask a person: call ask_human again with reask_of "${inboxItemId}" and ` +
    'reask_reason (why it is not settled); that question goes straight to a person, without screening.'
  );
}

/** Why a question was closed without an answer, as the asking member's notice says it (PM-556). */
const QUESTION_CLOSE_REASONS: Record<QuestionCloseRule, string> = {
  task_done: 'the card it was about is done',
  task_cancelled: 'the card it was about was cancelled',
  handed_off: 'the card it was about was handed to someone else',
  assignee_changed: 'the card it was about has a new assignee',
  withdrawn: 'it was withdrawn',
  group_withdrawn: 'every asker withdrew the shared question',
  operator_moot: 'the Operator found it moot: nothing is left to answer',
};

/** Why a session joined a card, as the joined notice says it (empty when nothing is known). */
function startReason(config: ProjectConfig, cause: SessionStartCause | null): string {
  if (!cause) return '';
  const sender = cause.by ? `\`${cause.by.handle}\`${cause.by.via ? ' via the integrator' : ''}` : null;
  switch (cause.kind) {
    case 'message':
      return ` (woken by a team message${sender ? ` from ${sender}` : ''})`;
    case 'mention':
    case 'answer':
      return ` (woken by ${cause.kind}${sender ? ` from ${sender}` : ''}${cause.quote ? `: ${cause.quote}` : ''})`;
    case 'hand_over':
      return ` (the card entered ${stageOf(config, cause.to ?? '')?.name ?? cause.to}${sender ? `, moved by ${sender}` : ''})`;
    case 'refinement':
      return ` (its refinement step for label ${cause.labels?.join(', ')})`;
    case 'start_button':
      return sender ? ` (started by ${sender})` : ' (started with the Start button)';
    default:
      return ` (${cause.kind})`;
  }
}
