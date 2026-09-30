import { formatInjectedTeamMessage } from '@projectman/shared';
import type { Session, TeamMessage, WorkItemRef } from '@projectman/shared';
import { encodeWorkItem } from '../../db';
import type { DomainContext } from '../context';
import type { EnsureSessionResult, SessionOrchestrator } from '../sessions';
import type { MessageService } from './messages';

/**
 * Types messages into running AI sessions (the runner queues them until the session is idle).
 * A stored message is typed once per recipient and then counts as delivered to it; when typing
 * fails it stays waiting for the recipient's next session. A session that resumes its
 * conversation for a waiting message takes the first one as its first input instead
 * (`startAndDeliver`).
 */
export class MessageDelivery {
  private readonly ctx: DomainContext;
  private readonly sessions: Pick<SessionOrchestrator, 'typeInto'>;
  private readonly messages: MessageService;
  /** Messages being typed, by message and recipient. */
  private readonly claims = new Set<string>();
  /** Recipients whose session is starting for their waiting messages: nothing is typed before it runs. */
  private readonly starting = new Set<string>();

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

  /**
   * Starts the session of an AI recipient of waiting messages, then types them in. A session that
   * resumes its conversation takes the first message as its first input instead: `start` gets its
   * text, as it is typed in, and hands it to the session start (`SessionOrchestrator.ensureSession`).
   * Nothing is typed into the session while it starts, so the messages keep their order; the one
   * the session took counts as delivered, the others are typed once it runs. A failing start
   * throws and leaves the messages waiting.
   */
  async startAndDeliver(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    start: (firstMessage: string | undefined) => Promise<EnsureSessionResult>,
  ): Promise<void> {
    const recipient = recipientKey(projectKey, handle, workItem);
    const [first] = this.messages.waiting(projectKey, handle, workItem);
    let result: EnsureSessionResult;
    this.starting.add(recipient);
    try {
      result = await start(first && formatInjectedTeamMessage(first.from, first.body, first.taskKey));
      if (first && result.messageSent) this.messages.markRecipientDelivered(first.id, handle);
    } finally {
      this.starting.delete(recipient);
    }
    this.deliverWaiting(result.session);
  }

  /** Types the messages waiting for the session's member and work item (after it started). */
  deliverWaiting(session: Session): void {
    // The start that is under way delivers them (`startAndDeliver`), in order.
    if (this.starting.has(recipientKey(session.projectKey, session.member, session.workItem))) return;
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

function recipientKey(projectKey: string, handle: string, workItem: WorkItemRef): string {
  const wi = encodeWorkItem(workItem);
  return `${projectKey}:${handle}:${wi.type}:${wi.ref}`;
}
