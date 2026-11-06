import { memberOf, mentionPayloadOf, messageProcessingOf } from '@projectman/shared';
import type {
  MessageProcessing,
  MessageProcessingFacts,
  ProcessingSession,
  ProjectConfig,
  Session,
  TeamMessage,
  TimelineEvent,
} from '@projectman/shared';
import type { EngineDirectory } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { MessageTurn } from '../../db';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { engineIdOf } from '../sessions';
import type { MessageRouter } from './routing';

type Reply = NonNullable<MessageProcessingFacts['reply']>;

/** What one projection pass reads once, however many messages and recipients it covers. */
interface Pass {
  now: number;
  turns: Map<string, MessageTurn[]>;
  /** The earliest delivery in the pass: the sent messages of a recipient are read from there. */
  since: string;
  /** `project\0handle` → the messages the recipient sent since `since`. */
  sent: Map<string, TeamMessage[]>;
  /** `project\0task` → the card's notes. */
  notes: Map<string, TimelineEvent[]>;
}

/**
 * What became of a message for each of its recipients (PM-1290, `messageProcessingOf`): the facts come from the
 * receipts, the turn the message was typed into, that turn's session, the router's hold and the answers. It
 * returns the state as it is now; who may see it is `visibleProcessing`'s rule.
 */
export class MessageProcessingReader {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: Pick<TaskService, 'find'>;
  private readonly router: Pick<MessageRouter, 'holdNameOf'>;
  private readonly engines: Pick<EngineDirectory, 'get'> | undefined;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: MessageProcessingReader['tasks'];
    router: MessageProcessingReader['router'];
    /** A session whose engine is not connected cannot report (PM-315). */
    engines?: Pick<EngineDirectory, 'get'>;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.router = deps.router;
    this.engines = deps.engines;
  }

  /** The processing of these messages for each recipient, in one batch: message id → one item per recipient. */
  ofMessages(messages: readonly TeamMessage[]): Map<string, MessageProcessing[]> {
    const result = new Map<string, MessageProcessing[]>();
    if (messages.length === 0) return result;
    const pass = this.pass(messages);
    for (const message of messages) result.set(message.id, this.ofMessage(message, pass));
    return result;
  }

  /**
   * The processing of the comments' mentions, one item per mentioned member: the notice message the comment
   * sent them, else (a person) the mention item that notified them, else `not_sent`. Comment event id → items.
   */
  ofComments(
    projectKey: string,
    taskKey: string,
    comments: readonly TimelineEvent[],
  ): Map<string, MessageProcessing[]> {
    const result = new Map<string, MessageProcessing[]>();
    if (comments.length === 0) return result;
    const notices = this.ctx.repos.messages.noticesOfNotes(comments.map((comment) => comment.id));
    const items = this.ctx.repos.inbox.list(projectKey, { kind: 'mention', taskKey });
    const pass = this.pass(
      notices,
      items.map((item) => item.createdAt),
    );
    for (const comment of comments) {
      const mentions = Array.isArray(comment.data.mentions) ? (comment.data.mentions as string[]) : [];
      const processing: MessageProcessing[] = [];
      for (const handle of new Set(mentions)) {
        if (handle === comment.actor.handle) continue;
        const notice = notices.find(
          (message) =>
            message.origin?.kind === 'note' &&
            message.origin.eventId === comment.id &&
            message.to.includes(handle),
        );
        if (notice) {
          processing.push(this.ofRecipient(notice, handle, pass));
          continue;
        }
        const item = items.find(
          (candidate) =>
            mentionPayloadOf(candidate)?.eventId === comment.id && candidate.assignees.includes(handle),
        );
        const reply = item && this.commentReply(projectKey, taskKey, comment, handle, item.createdAt, pass);
        processing.push(
          messageProcessingOf({
            handle,
            now: pass.now,
            notSent: !item,
            deliveredAt: item?.createdAt,
            reply,
          }),
        );
      }
      result.set(comment.id, processing);
    }
    return result;
  }

  private pass(messages: readonly TeamMessage[], noticedAt: readonly string[] = []): Pass {
    const deliveries = [
      ...noticedAt,
      ...messages.flatMap((message) =>
        (message.receipts ?? []).flatMap((receipt) => (receipt.deliveredAt ? [receipt.deliveredAt] : [])),
      ),
    ];
    return {
      now: this.ctx.now().getTime(),
      turns: this.ctx.repos.messageTurns.ofMessages(messages.map((message) => message.id)),
      since: deliveries.reduce((earliest, at) => (at < earliest ? at : earliest), '9999'),
      sent: new Map(),
      notes: new Map(),
    };
  }

  private ofMessage(message: TeamMessage, pass: Pass): MessageProcessing[] {
    return message.to.map((handle) => this.ofRecipient(message, handle, pass));
  }

  private ofRecipient(message: TeamMessage, handle: string, pass: Pass): MessageProcessing {
    const receipt = message.receipts?.find((candidate) => candidate.handle === handle);
    const deliveredAt = receipt?.deliveredAt ?? null;
    const turn = pass.turns.get(message.id)?.find((candidate) => candidate.handle === handle) ?? null;
    const facts: MessageProcessingFacts = {
      handle,
      now: pass.now,
      deliveredAt,
      readAt: receipt?.readAt ?? null,
      handedOffTo: receipt?.handedOffTo ?? null,
      reply: deliveredAt ? this.messageReply(message, handle, deliveredAt, pass) : null,
    };
    if (turn) {
      facts.turn = { typedAt: turn.typedAt, endedAt: turn.endedAt };
      facts.session = this.sessionOf(turn.sessionId);
    }
    const config = this.projects.cachedConfig(message.projectKey);
    if (!deliveredAt && config && memberOf(config, handle)?.kind === 'ai') {
      const hold = this.holdOf(config, message, handle);
      if (hold) facts.hold = hold;
      else facts.startingSince = this.startingSince(message, handle);
    }
    return messageProcessingOf(facts);
  }

  private holdOf(
    config: ProjectConfig,
    message: TeamMessage,
    handle: string,
  ): MessageProcessingFacts['hold'] {
    const task = message.taskKey ? this.tasks.find(message.projectKey, message.taskKey) : null;
    const name = this.router.holdNameOf(config, task, message.from, handle);
    return name ? { name, since: message.createdAt } : null;
  }

  /** A session of the recipient that is starting because of this very message. */
  private startingSince(message: TeamMessage, handle: string): string | null {
    const starting = this.ctx.repos.sessions
      .list(message.projectKey, { member: handle })
      .find((session) => session.state === 'starting' && session.startCause?.messageId === message.id);
    return starting?.stateSince ?? null;
  }

  private sessionOf(sessionId: string): ProcessingSession | null {
    const session: Session | null = this.ctx.repos.sessions.get(sessionId);
    if (!session) return null;
    return {
      state: session.state,
      stateSince: session.stateSince ?? session.lastActivityAt,
      pausedSince: session.pause?.since,
      lastActivityAt: session.lastActivityAt,
      engineConnected: this.engines ? this.engines.get(engineIdOf(session)) !== null : true,
    };
  }

  /**
   * The recipient's first answer to the message: for a comment's notice the answer in the comment's thread, else
   * a message to the comment's author about the same card; for another message the one that relays the
   * session's final text, else the first message to the sender in the same conversation.
   */
  private messageReply(message: TeamMessage, handle: string, deliveredAt: string, pass: Pass): Reply | null {
    if (message.origin?.kind === 'note' && message.taskKey) {
      const eventId = message.origin.eventId;
      const origin = this.notesOf(message.projectKey, message.taskKey, pass).find(
        (note) => note.id === eventId,
      );
      const byNote = origin
        ? this.commentReply(message.projectKey, message.taskKey, origin, handle, deliveredAt, pass)
        : null;
      if (byNote) return byNote;
    }
    const answer = this.sentBy(message.projectKey, handle, pass).find(
      (sent) =>
        sent.to.includes(message.from) &&
        sent.createdAt >= deliveredAt &&
        (sent.relayed?.inReplyTo === message.id ||
          (sent.conversation === message.conversation && sent.taskKey === message.taskKey)),
    );
    return answer ? { at: answer.createdAt, reply: { messageId: answer.id } } : null;
  }

  /**
   * The recipient's answer to a comment after it reached them: a comment in the thread, else a message to the
   * author about the same card.
   */
  private commentReply(
    projectKey: string,
    taskKey: string,
    comment: TimelineEvent,
    handle: string,
    deliveredAt: string,
    pass: Pass,
  ): Reply | null {
    const thread =
      typeof comment.data.replyTo === 'string' && comment.data.replyTo ? comment.data.replyTo : comment.id;
    const note = this.notesOf(projectKey, taskKey, pass).find(
      (candidate) =>
        candidate.actor.handle === handle &&
        candidate.createdAt >= deliveredAt &&
        candidate.data.replyTo === thread,
    );
    if (note) return { at: note.createdAt, reply: { eventId: note.id } };
    const author = comment.actor.handle;
    const answer = author
      ? this.sentBy(projectKey, handle, pass).find(
          (sent) =>
            sent.conversation === 'direct' &&
            sent.taskKey === taskKey &&
            sent.to.includes(author) &&
            sent.createdAt >= deliveredAt,
        )
      : undefined;
    return answer ? { at: answer.createdAt, reply: { messageId: answer.id } } : null;
  }

  private notesOf(projectKey: string, taskKey: string, pass: Pass): TimelineEvent[] {
    const key = `${projectKey}\0${taskKey}`;
    let notes = pass.notes.get(key);
    if (!notes) {
      notes = this.ctx.repos.timeline.notesOfCard(projectKey, taskKey);
      pass.notes.set(key, notes);
    }
    return notes;
  }

  private sentBy(projectKey: string, handle: string, pass: Pass): TeamMessage[] {
    const key = `${projectKey}\0${handle}`;
    let sent = pass.sent.get(key);
    if (!sent) {
      sent = this.ctx.repos.messages
        .listWindow(projectKey, handle, pass.since)
        .filter((message) => message.from === handle);
      pass.sent.set(key, sent);
    }
    return sent;
  }
}
