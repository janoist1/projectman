import { formatInjectedTeamMessage } from '@projectman/shared';
import type { Session, TeamMessage } from '@projectman/shared';
import type { DomainContext } from '../context';
import type { SessionOrchestrator } from '../sessions';
import type { MessageService } from './messages';

/**
 * Types messages into running AI sessions (the runner queues them until the session is idle).
 * A stored message is typed once per recipient and then counts as delivered to it; when typing
 * fails it stays waiting for the recipient's next session.
 */
export class MessageDelivery {
  private readonly ctx: DomainContext;
  private readonly sessions: Pick<SessionOrchestrator, 'typeInto'>;
  private readonly messages: MessageService;
  /** Messages being typed, by message and recipient. */
  private readonly claims = new Set<string>();

  constructor(deps: {
    ctx: DomainContext;
    sessions: Pick<SessionOrchestrator, 'typeInto'>;
    messages: MessageService;
  }) {
    this.ctx = deps.ctx;
    this.sessions = deps.sessions;
    this.messages = deps.messages;
  }

  /**
   * Types a stored message into its recipient's session, once. `text` is what is typed: by
   * default the message with its team prefix, `[team message from <handle> about <KEY>]`.
   */
  deliver(session: Session, message: TeamMessage, text?: string): void {
    const claim = `${message.id}:${session.member}`;
    if (this.claims.has(claim)) return;
    this.claims.add(claim);
    Promise.resolve()
      .then(() =>
        this.sessions.typeInto(
          session,
          text ?? formatInjectedTeamMessage(message.from, message.body, message.taskKey),
        ),
      )
      .then(() => this.messages.markRecipientDelivered(message.id, session.member))
      .catch((err: unknown) =>
        this.ctx.logger.warn({ err, messageId: message.id }, 'team message delivery failed'),
      )
      .finally(() => this.claims.delete(claim));
  }

  /** Types the messages waiting for the session's member and work item (after it started). */
  deliverWaiting(session: Session): void {
    for (const message of this.messages.waiting(session.projectKey, session.member, session.workItem))
      this.deliver(session, message);
  }

  /** Types a notice with the team prefix that is not stored as a message. */
  notice(session: Session, from: string, text: string, taskKey: string | null): void {
    Promise.resolve()
      .then(() => this.sessions.typeInto(session, formatInjectedTeamMessage(from, text, taskKey)))
      .catch((err: unknown) =>
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not deliver a message'),
      );
  }
}
