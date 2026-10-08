import {
  DEFAULT_AGENT_PROVIDER,
  formatInjectedTeamMessage,
  isOpenTask,
  isRefining,
  isTheme,
  labelDefinition,
  memberOf,
  projectRefines,
  routeFor,
  sameWorkItem,
  quoteOf,
  stageHandsOverForReview,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type {
  Actor,
  InboxItem,
  ProjectConfig,
  Session,
  Task,
  TeamMessage,
  TeamMessageAnswer,
  WorkItemRef,
} from '@projectman/shared';
import { roleLabel, truncate } from '../../agent-text';
import type { SentMessageRecipient } from '../../contracts';
import type { RefinementSteps } from '../admission';
import type { DomainContext } from '../context';
import { DomainError, invalid } from '../errors';
import type { DomainEventMap } from '../events';
import { answerText } from '../inbox';
import type { ProjectService } from '../projects';
import type { SessionOrchestrator, SessionStartCause } from '../sessions';
import type { TaskService } from '../tasks';
import { actorHandle, humanActor, newId, unique } from '../util';
import type { MessageDelivery } from './delivery';
import type { MessageService } from './messages';
import { wakesFor } from './staleness';

export interface SendOptions {
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
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly messages: MessageService;
  private readonly delivery: MessageDelivery;
  private readonly refinement: Pick<RefinementSteps, 'turnMember'>;
  private fixLimit: { heldFor(task: Task, config: ProjectConfig): boolean } | undefined;
  private fullTests:
    | {
        holds(task: Task, config: ProjectConfig): boolean;
        sync(projectKey: string, taskKey: string): Promise<void>;
      }
    | undefined;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    messages: MessageService;
    delivery: MessageDelivery;
    refinement: Pick<RefinementSteps, 'turnMember'>;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.messages = deps.messages;
    this.delivery = deps.delivery;
    this.refinement = deps.refinement;
  }

  /** Binds the fix round limit (PM-262); it sends messages itself, so it is built after this class. */
  useFixLimit(fixLimit: { heldFor(task: Task, config: ProjectConfig): boolean }): void {
    this.fixLimit = fixLimit;
  }

  /** Binds the server's full test before review (PM-217); it sends messages itself, so it is built after this class. */
  useFullTests(fullTests: {
    holds(task: Task, config: ProjectConfig): boolean;
    sync(projectKey: string, taskKey: string): Promise<void>;
  }): void {
    this.fullTests = fullTests;
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
    input: { to: string[]; text: string; taskKey?: string | null },
    opts: SendOptions = {},
  ): Promise<TeamMessage> {
    return (await this.sendReporting(projectKey, from, input, opts)).message;
  }

  /** `send`, and what happens to the message for each recipient (PM-144), in the order of `input.to`. */
  async sendReporting(
    projectKey: string,
    from: string,
    input: { to: string[]; text: string; taskKey?: string | null },
    opts: SendOptions = {},
  ): Promise<{ message: TeamMessage; recipients: SentMessageRecipient[] }> {
    const config = await this.projects.config(projectKey);
    const text = input.text.trim();
    if (!text) throw invalid('invalid_request', 'the message text is empty', { field: 'text' });
    const recipients = unique(input.to).filter((handle) => handle !== from);
    if (recipients.length === 0)
      throw invalid('invalid_request', 'the message names no recipient but its sender', { field: 'to' });
    const unknown = recipients.filter((handle) => !memberOf(config, handle));
    if (unknown.length > 0)
      throw new DomainError('not_found', `member not found: ${unknown.join(', ')}`, {
        status: 404,
        details: { what: 'member', id: unknown[0], ids: unknown },
      });
    const taskKey = input.taskKey ?? null;
    const task = taskKey ? this.tasks.get(projectKey, taskKey) : null;
    const humans = recipients.filter((handle) => memberOf(config, handle)?.kind === 'human');
    // The task's developer writing to a reviewer or tester hands over new work (a re-review, a
    // retest): their next round starts from the latest commit (PM-138, the owner's answer).
    if (
      (opts.kind ?? 'action') === 'action' &&
      task &&
      isOpenTask(task) &&
      task.assignee === from &&
      (!opts.workItem || opts.workItem.type === 'task')
    ) {
      for (const handle of recipients)
        if (!humans.includes(handle)) this.sessions.requestReviewRound(projectKey, task.key, handle);
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
      await this.fullTests?.sync(projectKey, task.key).catch((err: unknown) => {
        this.ctx.logger.warn({ err, taskKey: task.key }, 'could not queue the full test of the new round');
      });
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
        return { handle, hold: null, ...this.place(projectKey, config, handle, workItem) };
      });
    const routes: Record<string, WorkItemRef> = {};
    for (const { handle, workItem: where } of placed)
      if (!sameWorkItem(where, routeFor(taskKey))) routes[handle] = where;
    const message = this.messages.record({
      projectKey,
      from,
      to: recipients,
      taskKey,
      body: text,
      actor: opts.actor ?? humanActor(from),
      sessionId: opts.sessionId ?? null,
      humanRecipients: humans,
      delivered: recipients.every((handle) => humans.includes(handle)),
      routes,
      answer: opts.answer,
      origin: opts.origin,
      kind: opts.kind ?? 'action',
      subject: opts.subject,
      version: task
        ? {
            stageId: task.stageId,
            commit: (await this.sessions.sourceHead(config, task))?.commit ?? null,
            reviewCommit: this.tasks.get(projectKey, task.key).reviewPin?.commit ?? null,
          }
        : undefined,
    });
    const decided = new Map<string, Omit<SentMessageRecipient, 'handle'>>();
    for (const { handle, workItem: where, running, hold } of placed)
      decided.set(
        handle,
        hold
          ? { delivery: 'held', hold }
          : this.deliverOrWake(config, projectKey, handle, where, running, message),
      );
    return {
      message,
      recipients: recipients.map((handle) => ({
        handle,
        ...(decided.get(handle) ?? { delivery: 'inbox' as const }),
      })),
    };
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
      this.delivery.deliverWithFirstInput(session.member, [message], started.firstInput);
    else this.delivery.deliver(started?.session ?? session, message, input);
    return message;
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

  /** A human answered an AI member's `ask_human` question: the answer goes back to the asking session. */
  async answer(item: InboxItem): Promise<void> {
    const resolution = item.resolution;
    if (item.kind !== 'question' || !resolution) return;
    const config = await this.projects.config(item.projectKey);
    const asker = memberOf(config, item.source);
    if (asker?.kind !== 'ai') return;
    const question = typeof item.payload.question === 'string' ? item.payload.question : item.title;
    const session = item.sessionId ? this.sessions.find(item.sessionId) : null;
    await this.send(
      item.projectKey,
      resolution.by,
      {
        to: [asker.handle],
        text: `Answer to your question "${question}":\n\n${answerText(item)}`,
        taskKey: item.taskKey,
      },
      {
        sessionId: item.sessionId,
        workItem: session?.member === asker.handle ? session.workItem : routeFor(item.taskKey),
        // The answer to the member's own question is never held back by the refinement line.
        duringRefinement: true,
        actor: { ...humanActor(resolution.by), ...(resolution.via ? { via: resolution.via } : {}) },
        origin: { kind: 'answer', inboxItemId: item.id },
        answer: { inboxItemId: item.id, question, answer: answerText(item) },
      },
    );
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
  ): { workItem: WorkItemRef; running: Session | null } {
    const own = this.sessions.findRunning(projectKey, handle, workItem);
    if (own || workItem.type !== 'task') return { workItem, running: own };
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
  ): 'handoff' | 'refinement_turn' | 'fix_limit' | 'full_test' | null {
    if (this.heldForHandoff(task, handle)) return 'handoff';
    if (this.heldForTurn(config, task, handle, opts)) return 'refinement_turn';
    if (this.heldForFixLimit(config, task, from, handle)) return 'fix_limit';
    if (this.heldForFullTest(config, task, from, handle)) return 'full_test';
    return null;
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
    return this.fixLimit?.heldFor(task, config) ?? false;
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
    return this.fullTests?.holds(task, config) ?? false;
  }

  /**
   * The messages that wait for `handle` on a card (held back by its fix round limit or its full test) reach it: typed into
   * its running session, or one wake-up for all of them.
   */
  async releaseWaiting(projectKey: string, taskKey: string, handle: string): Promise<void> {
    const config = await this.projects.config(projectKey);
    const workItem = routeFor(taskKey);
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
    if (session.workItem.type !== 'task') return false;
    const task = this.tasks.find(session.projectKey, session.workItem.taskKey);
    if (!task) return false;
    const config = await this.projects.config(session.projectKey);
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

  /** A running recipient gets the message typed in; otherwise it waits for a wake-up. Returns what was decided. */
  private deliverOrWake(
    config: ProjectConfig,
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    running: Session | null,
    message: TeamMessage,
  ): Omit<SentMessageRecipient, 'handle'> {
    const wakes = wakesFor(this.ctx, config, message, handle);
    if (!running && !wakes) return { delivery: 'next_input' };
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
    if (running) {
      try {
        this.sessions.assertProviderCooldown(running.provider ?? DEFAULT_AGENT_PROVIDER);
      } catch (err) {
        if (!(err instanceof DomainError) || err.code !== 'provider_rate_limited') throw err;
        if (!wakes) return { delivery: 'next_input' };
        void this.ctx.events.emit('message_waiting', { projectKey, handle, workItem, messageId: message.id });
        return { delivery: 'wake' };
      }
      if (memberOf(config, message.from)?.kind === 'human') this.delivery.deliver(running, message);
      else this.delivery.deliverWaiting(running);
      return { delivery: running.state === 'idle' ? 'typed_now' : 'after_turn' };
    }
    void this.ctx.events.emit('message_waiting', { projectKey, handle, workItem, messageId: message.id });
    return { delivery: 'wake' };
  }
}

/** How much of a question and of its answer the notice to the card's other workers carries. */
const QUESTION_NOTICE_LIMIT = 200;
const ANSWER_NOTICE_LIMIT = 500;

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
