import {
  formatInjectedTeamMessage,
  isOpenTask,
  memberOf,
  QuestionCloseRule,
  questionPayloadOf,
  quoteOf,
  stageHandsOverForReview,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type { Actor, InboxItem, Session, TeamMessage } from '@projectman/shared';
import {
  ANSWER_NOTICE_LIMIT,
  QUESTION_NOTICE_LIMIT,
  QUESTION_CLOSE_REASONS,
  reaskHint,
  roleLabel,
  startReason,
  truncate,
} from '../../agent-text';
import type { DomainContext, DomainEventMap } from '../../core/base';
import { answerText } from '../../core/inbox';
import type { Messaging } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { actorHandle, humanActor, newId } from '../../kernel';
import type { SessionOrchestrator } from '../sessions';
import type { MessageDelivery } from './delivery';

/** Direct session chat and transient notices for running card sessions. */
export class SessionMessages {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly messaging: Pick<Messaging, 'prepareSessionChat' | 'recordSessionChat'>;
  private readonly sessions: Pick<
    SessionOrchestrator,
    | 'get'
    | 'find'
    | 'list'
    | 'isRunning'
    | 'isPaused'
    | 'ensureSession'
    | 'restartWithMessages'
    | 'permissionRestartDue'
    | 'cardWorkers'
  >;
  private readonly delivery: MessageDelivery;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    messaging: Pick<Messaging, 'prepareSessionChat' | 'recordSessionChat'>;
    sessions: SessionMessages['sessions'];
    delivery: MessageDelivery;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.messaging = deps.messaging;
    this.sessions = deps.sessions;
    this.delivery = deps.delivery;
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
    const { body, input } = await this.messaging.prepareSessionChat({
      projectKey,
      session,
      text,
      from,
      actor,
    });
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
    const message = this.messaging.recordSessionChat({
      projectKey,
      session,
      id: messageId,
      body,
      from,
      actor,
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
    // An obligation todo (PM-806) is the system's own; no member on the card asked it.
    if (questionPayloadOf(item)?.obligation) return;
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
}
