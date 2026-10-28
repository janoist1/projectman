export function createMessaging(deps: ConstructorParameters<typeof Messaging>[0]): Messaging {
  return new Messaging(deps);
}

import { createHash } from 'node:crypto';
import {
  cardBusyGroups,
  coordinationActorRefusal,
  DEFAULT_AGENT_PROVIDER,
  currentHandleOf,
  formatInjectedTeamMessage,
  hasGuestConversations,
  hasBoundOrigin,
  isOpenTask,
  isProjectManager,
  isTheme,
  labelDefinition,
  memberOf,
  ownerHandles,
  messageWakes,
  managerConversationOf,
  routeFor,
  sameWorkItem,
  sessionWorkItemOf,
  questionPayloadOf,
  stageOf,
  stageOwners,
  teamMessageRecipientRefusal,
  uiPlaceKey,
  uiPlaceRefusal,
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
  UiLocation,
  UiPlace,
  WorkItemRef,
} from '@projectman/shared';
import { QUESTION_NOTICE_LIMIT, reaskHint, startReason, truncate } from '../../agent-text';
import type { SentMessageRecipient } from '../../contracts';
import type { MessageRouting, MessageSessions, RecipientDelivery } from './ports';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { DomainError, forbidden, invalid, conflict } from '../../kernel';
import type { MessageAttachmentService } from '../../core/attachments';
import type { DomainEventMap } from '../../core/base';
import { answerText } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { actorHandle, aiActor, humanActor, newId, SYSTEM_ACTOR, unique } from '../../kernel';
import { assertIntegratorAccess, assertSuperMutation } from '../../kernel';
import type { MessageService } from './messages';
import { recipientHasCardRole, staleReasonFor, wakeFactsFor, wakesFor } from './staleness';

interface SendOptions {
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
  /** Marks the message as the reply of an e-mail contact (PM-943): its text reaches the recipient as data. */
  email?: TeamMessage['email'];
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
  /**
   * Places in the app the project manager offers under the message as "go there" buttons (PM-1071). Only
   * the coordination actor, only to people, only places every recipient sees. Not in an HTTP request.
   */
  places?: UiPlace[];
}

interface SendInput {
  to: string[];
  text: string;
  taskKey?: string | null;
  attachmentIds?: string[];
  /** Where the sender is in the app (PM-1071). */
  location?: UiLocation;
}

/** What presenting or accepting Operator signals records with the message (PM-593). */
interface MessageSignals {
  presentation(projectKey: string, signalId: string, by?: string): void;
  decision(projectKey: string, signalId: string, by: string, accepted: boolean): void;
  present(projectKey: string, signalId: string, messageId: string, actionable: boolean): void;
}

type SendReport = { message: TeamMessage; recipients: SentMessageRecipient[] };

interface PreparedSend {
  record(): TeamMessage;
  deliver(message: TeamMessage): SendReport | Promise<SendReport>;
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
  private readonly routing: MessageRouting;
  private readonly messageAttachments: Pick<
    MessageAttachmentService,
    'assertSendable' | 'bindForSend' | 'shareForQuestionGroupAnswer'
  >;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: MessageSessions;
    messages: MessageService;
    routing: MessageRouting;
    /** The files a message carries (PM-516): checked before the message is sent, bound to it as it is recorded. */
    messageAttachments: Pick<
      MessageAttachmentService,
      'assertSendable' | 'bindForSend' | 'shareForQuestionGroupAnswer'
    >;
  }) {
    this.messageAttachments = deps.messageAttachments;
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.messages = deps.messages;
    this.routing = deps.routing;
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
    input: SendInput,
    opts: SendOptions = {},
  ): Promise<TeamMessage> {
    return (await this.sendReporting(projectKey, from, input, opts)).message;
  }

  /** `send`, and what happens to the message for each recipient (PM-144), in the order of `input.to`. */
  sendReporting(
    projectKey: string,
    from: string,
    input: SendInput,
    opts: SendOptions = {},
  ): Promise<{ message: TeamMessage; recipients: SentMessageRecipient[] }> {
    return this.prepareSend(projectKey, from, input, opts, (prepared) => prepared.deliver(prepared.record()));
  }

  /** Continue before yielding: ordinary sends record and deliver immediately; groups retain the preparation. */
  private async prepareSend<T>(
    projectKey: string,
    from: string,
    input: SendInput,
    opts: SendOptions,
    complete: (prepared: PreparedSend) => T | Promise<T>,
  ): Promise<T> {
    const config = await this.projects.config(projectKey);
    assertIntegratorAccess(config, 'write', opts.actor);
    const text = input.text.trim();
    const attachmentIds = input.attachmentIds ?? [];
    // Empty text is a message of files alone (PM-516).
    if (!text && attachmentIds.length === 0)
      throw invalid('invalid_request', 'the message text is empty', { field: 'text' });
    // A renamed member still answers to its old handles (PM-1025).
    const recipients = unique(input.to.map((handle) => currentHandleOf(config, handle) ?? handle)).filter(
      (handle) => handle !== from,
    );
    assertSuperMutation(
      config,
      {
        kind: 'runtime_start',
        providers: recipients.flatMap((handle) => {
          const member = memberOf(config, handle);
          return member?.kind === 'ai' ? [member.provider ?? DEFAULT_AGENT_PROVIDER] : [];
        }),
      },
      opts.actor,
    );
    if (recipients.length === 0)
      throw invalid('invalid_request', 'the message names no recipient but its sender', { field: 'to' });
    // Who the sender may write to is checked before anything is written, bound or woken, and again as
    // the message is recorded (the configuration may change in between).
    this.assertRecipientsAllowed(config, from, recipients, opts);
    const unknown = recipients.filter((handle) => !memberOf(config, handle));
    if (unknown.length > 0)
      throw new DomainError('not_found', `member not found: ${unknown.join(', ')}`, {
        status: 404,
        details: { what: 'member', id: unknown[0], ids: unknown },
      });
    const coordinator = coordinationActorRefusal(config, opts.actor ?? humanActor(from)) === null;
    if (opts.places?.length)
      this.assertPlacesOffered(config, projectKey, recipients, coordinator, opts.places);
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
        !presentation ||
        recipients[0] !== presentation.from
      ) {
        throw conflict(
          'operator_signal_closed',
          'only an owner using their own login may accept a signal presented to them',
        );
      }
    }
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
        const hold = this.routing.holdOf(config, task, from, handle, opts);
        if (hold) return { handle, hold, workItem: routeFor(taskKey), running: null };
        return {
          handle,
          hold: null,
          ...this.routing.place(projectKey, config, handle, workItem, !!opts.ownCard, from),
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
        this.assertRecipientsAllowed(
          this.projects.cachedConfig(projectKey) ?? config,
          from,
          recipients,
          opts,
        );
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
          email: opts.email,
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
          location: input.location,
          places: opts.places,
        });
        for (const signal of signals)
          this.messageSignals!.present(projectKey, signal.id, recorded.id, signal.actionable);
        return recorded;
      });
    const deliver = (message: TeamMessage) => {
      const decided = this.routing.deliver({
        config,
        projectKey,
        message,
        placements: placed,
        untilInput: opts.untilInput === true && opts.kind === 'info',
        awaitWake: opts.awaitWake === true,
      });
      const report = (deliveries: ReadonlyMap<string, RecipientDelivery>): SendReport => ({
        message,
        recipients: recipients.map((handle) => ({
          handle,
          ...(deliveries.get(handle) ?? { delivery: 'inbox' as const }),
        })),
      });
      // Preserve ordinary send completion timing; only explicit wake-result waits add a promise.
      return decided instanceof Promise ? decided.then(report) : report(decided);
    };
    return complete({ record, deliver });
  }

  /**
   * The places the project manager offers (PM-1071), checked before anything is written: the sender is the
   * coordination actor, every recipient is a person who sees every place, and the card or member exists.
   * 403 `project_manager_only`, `place_not_target` or `place_not_visible` (`details`: the recipient and
   * the place's index); 400 `invalid_request` (`field: "places"`) for an AI recipient or a repeated place;
   * 404 `not_found` (`what: "place"`).
   */
  private assertPlacesOffered(
    config: ProjectConfig,
    projectKey: string,
    recipients: readonly string[],
    coordinator: boolean,
    places: readonly UiPlace[],
  ): void {
    if (!coordinator)
      throw forbidden('project_manager_only', 'only the project manager offers places in the app');
    const people = recipients.map((handle) => memberOf(config, handle));
    if (people.some((member) => member?.kind !== 'human'))
      throw invalid('invalid_request', 'places go only to people', { field: 'places' });
    if (new Set(places.map(uiPlaceKey)).size !== places.length)
      throw invalid('invalid_request', 'a place is offered twice', { field: 'places' });
    places.forEach((place, index) => {
      for (const member of people) {
        if (member?.kind !== 'human') continue;
        const refusal = uiPlaceRefusal(place, member.access);
        if (refusal)
          throw forbidden(refusal, `${place.page} is not offered to ${member.handle}`, {
            recipient: member.handle,
            index,
          });
      }
      const missing =
        place.page === 'card'
          ? this.ctx.repos.tasks.get(place.taskKey!)?.projectKey !== projectKey
          : place.page === 'member' && !memberOf(config, place.handle!);
      if (missing)
        throw new DomainError('not_found', `place not found: ${place.page}`, {
          status: 404,
          details: { what: 'place', index },
        });
    });
  }

  /**
   * 403 `recipient_not_contact` (a contact-restricted sender) or `insufficient_access` (a viewer) with the refused
   * recipients in `details`, for the whole message (PM-985). The answer to a member's own question and an e-mail
   * contact's reply have their own rules: the origin is set by the server, never by a request.
   */
  private assertRecipientsAllowed(
    config: ProjectConfig,
    from: string,
    recipients: readonly string[],
    opts: Pick<SendOptions, 'origin' | 'email'>,
  ): void {
    if (opts.origin?.kind === 'answer' || opts.email) return;
    const refusal = teamMessageRecipientRefusal(config, from, recipients);
    if (!refusal) return;
    throw forbidden(
      refusal.code,
      refusal.code === 'recipient_not_contact'
        ? 'the message goes only to the contacts of the project'
        : 'Developer or client access required',
      { recipients: refusal.recipients },
    );
  }

  /**
   * Checks a person's session chat in the existing order, and prepares its typed input.
   */
  async prepareSessionChat({
    projectKey,
    session,
    text,
    from,
    actor,
  }: {
    projectKey: string;
    session: Session;
    text: string;
    from: string;
    actor: Actor;
  }): Promise<{ body: string; input: string }> {
    const body = text.trim();
    if (!body) throw invalid('invalid_request', 'the message text is empty', { field: 'text' });
    const config = await this.projects.config(projectKey);
    assertIntegratorAccess(config, 'write', actor);
    const recipient = memberOf(config, session.member);
    assertSuperMutation(
      config,
      {
        kind: 'runtime_start',
        providers: recipient?.kind === 'ai' ? [recipient.provider ?? DEFAULT_AGENT_PROVIDER] : [],
      },
      actor,
    );
    // A person writes into their own conversation with the Operator or the PM, not into another person's
    // (PM-475, PM-1080). The PM's meetings, schedules and cards are not conversations: they stay as they were.
    if (
      hasGuestConversations(config, memberOf(config, session.member)) &&
      session.workItem.type === 'general' &&
      memberOf(config, from)?.kind === 'human' &&
      !sameWorkItem(session.workItem, managerConversationOf(config, from))
    )
      throw forbidden(
        'operator_owner_only',
        'a person writes to the Operator or the PM only in their own conversation',
      );
    const input = actor.via
      ? formatInjectedTeamMessage(
          from,
          body,
          session.workItem.type === 'task' ? session.workItem.taskKey : null,
          actor.via,
          actor,
        )
      : body;
    return { body, input };
  }

  /** Records a session chat; delivery is confirmed after its input is typed. */
  recordSessionChat({
    projectKey,
    session,
    id,
    body,
    from,
    actor,
  }: {
    projectKey: string;
    session: Session;
    id: string;
    body: string;
    from: string;
    actor: Actor;
  }): TeamMessage {
    return this.messages.record({
      projectKey,
      from,
      to: [session.member],
      id,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      body,
      actor,
      sessionId: session.id,
      // A message in the first input of a starting session waits until that input is typed (PM-189).
      delivered: false,
    });
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

  /** The members a task comment mentions get it as a message from its author. */
  async mentionNotice(note: DomainEventMap['task_note_added']): Promise<void> {
    const { event } = note;
    const author = actorHandle(event.actor);
    // The comment keeps every mention; the notice goes only to those the author may write to now (PM-985).
    const config = await this.projects.config(event.projectKey);
    const refused = new Set(teamMessageRecipientRefusal(config, author, note.mentions)?.recipients);
    const mentions = note.mentions.filter((handle) => !refused.has(handle));
    if (mentions.length === 0) return;
    try {
      await this.send(
        event.projectKey,
        author,
        { to: mentions, text: event.data.text as string, taskKey: event.taskKey },
        { actor: event.actor, sessionId: event.sessionId, origin: { kind: 'note', eventId: event.id } },
      );
    } catch (err) {
      // The author's contacts changed while the notice was being prepared: no notice, the comment stands.
      if (err instanceof DomainError && err.code === 'recipient_not_contact') return;
      throw err;
    }
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
    if (questionPayloadOf(item)?.externalQuestion) return this.answerExternal(item, attachmentIds, close);
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
        text: resolution.integratorTodo
          ? `The integrator resolved its own task (not an owner answer, decision or approval). Result for your question "${question}":\n\n${answerText(item)}`
          : todo && !byOperator
            ? `Answer to your question "${question}":\n\nThe Operator turned it into a task for a person: ` +
              `${todo.what} (where: ${todo.where}; expected: ${todo.expected}). The person's result:\n\n${answerText(item)}`
            : `Answer to your question "${question}":\n\n${answerText(item)}` +
              (byOperator
                ? `\n\n(This answer is from the Operator, not from a person. ${reaskHint(item.id)})`
                : '') +
              (resolution.ownerAnswerRelayed
                ? "\n\n(The integrator relayed this on the owner's behalf. It answers information only: it is not an owner decision or approval.)"
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
        origin: {
          kind: 'answer',
          inboxItemId: item.id,
          ...(resolution.ownerAnswerRelayed ? { ownerAnswerRelayed: true as const } : {}),
          ...(resolution.integratorTodo ? { integratorTodo: true as const } : {}),
        },
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

  /**
   * An owner answered a question the integrator asked through the bearer MCP (PM-784). No session waits for it:
   * the answer stays on the question, and a durable message (already delivered, so no wake and no pending
   * delivery) carries its text and files; the question's payload points to it. The files go through the same
   * send checks as any message, and the question closes in the same transaction.
   */
  private async answerExternal(
    item: InboxItem,
    attachmentIds: readonly string[],
    close: () => InboxItem,
  ): Promise<InboxItem | null> {
    const resolution = item.resolution!;
    const sender = resolverActor(resolution);
    if (attachmentIds.length > 0)
      this.messageAttachments.assertSendable(item.projectKey, sender, attachmentIds);
    const id = newId('msg');
    let closed: InboxItem | null = null;
    this.ctx.unitOfWork(() => {
      const attachments =
        attachmentIds.length > 0
          ? this.messageAttachments.bindForSend(item.projectKey, sender, attachmentIds, id)
          : undefined;
      this.messages.record({
        id,
        projectKey: item.projectKey,
        from: resolverSender(resolution),
        to: [item.source],
        taskKey: item.taskKey,
        body: answerText(item),
        attachments,
        actor: sender,
        sessionId: null,
        humanRecipients: [],
        delivered: true,
        routes: {},
        origin: { kind: 'answer', inboxItemId: item.id },
        kind: 'info',
      });
      this.ctx.repos.inbox.updatePayload(
        item.id,
        { ...item.payload, externalAnswerMessageId: id },
        isoNow(this.ctx),
      );
      closed = close();
    });
    return closed ? this.ctx.repos.inbox.get(item.id) : null;
  }

  /** The same effective route for sending an answer and previewing its admission. */
  async answerWorkItem(item: InboxItem): Promise<WorkItemRef> {
    const config = await this.projects.config(item.projectKey);
    const asker = memberOf(config, item.source);
    const session = item.sessionId ? this.sessions.find(item.sessionId) : null;
    const workItem: WorkItemRef = isProjectManager(asker)
      ? { type: 'general' }
      : session?.member === item.source
        ? session.workItem
        : routeFor(item.taskKey);
    return this.routing.place(
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
        workers.some((worker) => worker.member === handle) ||
        this.routing.holdOf(config, task, from, handle, opts)
      )
        return [];
      const placed = this.routing.place(
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
}

/** The actor a question's resolution is delivered as: the super or connected origin when it has one (PM-757). */
function resolverActor(resolution: {
  by: string;
  via?: 'integrator' | undefined;
  actor?: Actor | undefined;
}): Actor {
  if (hasBoundOrigin(resolution.actor)) return resolution.actor;
  return { ...humanActor(resolution.by), ...(resolution.via ? { via: resolution.via } : {}) };
}

/** The sender handle of that answer: the Operator in the super mode, so the message and its actor agree. */
function resolverSender(resolution: { by: string; actor?: Actor | undefined }): string {
  return hasBoundOrigin(resolution.actor) ? resolution.actor.handle : resolution.by;
}
