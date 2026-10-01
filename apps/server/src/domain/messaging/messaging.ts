import {
  formatInjectedTeamMessage,
  isOpenTask,
  labelDefinition,
  memberOf,
  routeFor,
  sameWorkItem,
  stageHandsOverForReview,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type { Actor, InboxItem, ProjectConfig, Session, TeamMessage, WorkItemRef } from '@projectman/shared';
import type { DomainContext } from '../context';
import { DomainError, invalid } from '../errors';
import type { DomainEventMap } from '../events';
import { answerText } from '../inbox';
import type { ProjectService } from '../projects';
import type { SessionOrchestrator } from '../sessions';
import type { TaskService } from '../tasks';
import { actorHandle, humanActor, unique } from '../util';
import type { MessageDelivery } from './delivery';
import type { MessageService } from './messages';

export interface SendOptions {
  /** Who sends it (default: the human `from`). */
  actor?: Actor;
  /** The AI session it was sent from (recorded in the timeline). */
  sessionId?: string | null;
  /** Where AI recipients get it (default: `routeFor(taskKey)`). */
  workItem?: WorkItemRef;
}

/**
 * The one way team messages are sent (REST, the send_message team tool, label and @mention
 * notices, answers to AI questions): validated the same way, recorded with a receipt per
 * recipient, then typed into each AI recipient's running session for the work item, or left
 * waiting for its wake-up through admission (the `message_waiting` domain event). Humans read
 * theirs in the app. A message never goes to its own sender.
 */
export class Messaging {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly messages: MessageService;
  private readonly delivery: MessageDelivery;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    messages: MessageService;
    delivery: MessageDelivery;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.messages = deps.messages;
    this.delivery = deps.delivery;
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
    if (task && task.assignee === from && (!opts.workItem || opts.workItem.type === 'task')) {
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
    }
    // Where each AI recipient gets it is decided before it is recorded: the receipt keeps the
    // route when it is not the default place, so the message is found there while it waits.
    const workItem = opts.workItem ?? routeFor(taskKey);
    const placed = recipients
      .filter((handle) => !humans.includes(handle))
      .map((handle) => ({ handle, ...this.place(projectKey, config, handle, workItem) }));
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
    });
    for (const { handle, workItem: where, running } of placed)
      this.deliverOrWake(projectKey, handle, where, running, message);
    return message;
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
  ): Promise<TeamMessage> {
    const session = this.sessions.get(projectKey, sessionId);
    const body = text.trim();
    if (!body) throw invalid('invalid_request', 'the message text is empty', { field: 'text' });
    const running = this.sessions.isRunning(session.id);
    const started = running
      ? null
      : await this.sessions.ensureSession(projectKey, session.member, session.workItem, { messages: [body] });
    const sentAsFirstInput = (started?.messagesSent ?? 0) > 0;
    // A session about to restart into a new permission mode takes it after the restart (PM-170).
    const held = running && this.sessions.permissionRestartDue(session);
    const message = this.messages.record({
      projectKey,
      from,
      to: [session.member],
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
      body,
      actor: humanActor(from),
      sessionId: session.id,
      // A message in the first input of a starting session waits until that input is typed (PM-189).
      delivered: false,
    });
    if (held) this.delivery.holdAsWritten(session, message);
    else if (started && sentAsFirstInput)
      this.delivery.deliverWithFirstInput(session.member, [message], started.firstInput);
    else this.delivery.deliver(started?.session ?? session, message, body);
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
      { actor },
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
          .restartWithMessages(task.projectKey, session.id, [prefixed])
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
      { actor: event.actor, sessionId: event.sessionId },
    );
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
   * 3. on a closed card, the recipient's general chat, running or to be woken: no session starts
   *    on a closed card;
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
    if (!isOpenTask(task)) {
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

  /** A running recipient gets the message typed in; otherwise it waits for a wake-up. */
  private deliverOrWake(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    running: Session | null,
    message: TeamMessage,
  ): void {
    // A reviewer still in a turn of a round that is over gets it after its restart on the new commit,
    // and so does a session that waits for its restart into a new permission mode (PM-170).
    if (running && (this.sessions.reviewRoundDue(running) || this.sessions.permissionRestartDue(running)))
      return;
    if (running) this.delivery.deliver(running, message);
    else
      void this.ctx.events.emit('message_waiting', { projectKey, handle, workItem, messageId: message.id });
  }
}
