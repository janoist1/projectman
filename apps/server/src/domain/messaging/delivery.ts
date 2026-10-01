import { formatInjectedTeamMessage } from '@projectman/shared';
import type { Session, TeamMessage, WorkItemRef } from '@projectman/shared';
import { encodeWorkItem } from '../../db';
import type { DomainContext } from '../context';
import type { EnsureSessionResult, SessionOrchestrator } from '../sessions';
import type { MessageService } from './messages';

/**
 * Types messages into running AI sessions (the runner queues them until the session is idle).
 * A stored message is typed once per recipient and then counts as delivered to it; when typing
 * fails it stays waiting for the recipient's next session. A session that starts for waiting
 * messages takes them in its first input instead (`startAndDeliver`); they count as delivered once
 * that input was typed.
 */
export class MessageDelivery {
  private readonly ctx: DomainContext;
  private readonly sessions: Pick<SessionOrchestrator, 'typeInto'>;
  private readonly messages: MessageService;
  /** Messages being typed, by message and recipient. */
  private readonly claims = new Set<string>();
  /** Recipients whose session is starting for their waiting messages: nothing is typed before it runs. */
  private readonly starting = new Set<string>();
  /**
   * Messages a person wrote into a session that waited for its restart (PM-170), by message and
   * recipient: typed as they were written once it runs, like the ones that reach it at once.
   */
  private readonly asWritten = new Set<string>();

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
    const plain = this.asWritten.has(claim);
    Promise.resolve()
      .then(() =>
        this.sessions.typeInto(
          session,
          text ??
            (plain ? message.body : formatInjectedTeamMessage(message.from, message.body, message.taskKey)),
        ),
      )
      .then(() => {
        this.asWritten.delete(claim);
        return this.messages.markRecipientDelivered(message.id, session.member);
      })
      .catch((err: unknown) =>
        this.ctx.logger.warn({ err, messageId: message.id }, 'team message delivery failed'),
      )
      .finally(() => this.claims.delete(claim));
  }

  /**
   * Starts the session of an AI recipient of waiting messages, then types them in. The session
   * takes the waiting messages in its first input instead, in order and in full, so that it does not
   * work from the excerpts until its first turn ends (PM-180): `start` gets their text, as it is
   * typed in, and hands it to the session start (`SessionOrchestrator.ensureSession`). Nothing is
   * typed into the session while it starts, so the messages keep their order; the ones the session
   * took count as delivered, the rest (what did not fit its first input) is typed once it runs. A
   * failing start throws and leaves the messages waiting.
   */
  async startAndDeliver(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    start: (messages: string[]) => Promise<EnsureSessionResult>,
  ): Promise<void> {
    const recipient = recipientKey(projectKey, handle, workItem);
    const waiting = this.messages.waiting(projectKey, handle, workItem);
    let result: EnsureSessionResult;
    this.starting.add(recipient);
    try {
      result = await start(
        waiting.map((message) => formatInjectedTeamMessage(message.from, message.body, message.taskKey)),
      );
      this.deliverWithFirstInput(handle, waiting.slice(0, result.messagesSent), result.firstInput);
    } finally {
      this.starting.delete(recipient);
    }
    this.deliverWaiting(result.session);
  }

  /**
   * Messages a session took in its first input count as delivered to `handle` once that input was
   * typed (`EnsureSessionResult.firstInput`), not when the process started: one that ends first
   * (a lost login, a start-up dialog, a crash) never got them, so they stay waiting for the next
   * session (PM-189). Until then nothing types them again.
   */
  deliverWithFirstInput(handle: string, messages: TeamMessage[], firstInput: Promise<boolean>): void {
    const claims = messages.map((message) => `${message.id}:${handle}`);
    for (const claim of claims) this.claims.add(claim);
    firstInput
      .then((typed) => {
        if (typed) for (const message of messages) this.messages.markRecipientDelivered(message.id, handle);
      })
      .catch((err: unknown) => this.ctx.logger.warn({ err }, 'team message delivery failed'))
      .finally(() => {
        for (const claim of claims) this.claims.delete(claim);
      });
  }

  /**
   * A person wrote into a session that waits for its restart (PM-170): the message waits with the
   * others and is typed as it was written, without the team prefix, once the session runs again.
   */
  holdAsWritten(session: Session, message: TeamMessage): void {
    this.asWritten.add(`${message.id}:${session.member}`);
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
