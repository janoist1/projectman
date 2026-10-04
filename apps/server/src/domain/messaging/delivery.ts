import { formatInjectedTeamMessage } from '@projectman/shared';
import type { Session, TeamMessage, WorkItemRef } from '@projectman/shared';
import { encodeWorkItem } from '../../db';
import type { DomainContext } from '../context';
import { MESSAGE_SEPARATOR } from '../sessions';
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
  private readonly sessions: Pick<SessionOrchestrator, 'typeInto' | 'isPaused'>;
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
  /**
   * Messages kept back because their recipient's running session is paused (PM-219), by message and
   * recipient, with the session they are for. Memory only: a restart leaves the session without a
   * process, and the messages wait like any that wait for a start (the resume starts it with them).
   */
  private readonly pauseHeld = new Map<string, { sessionId: string; messageId: string; member: string }>();
  /** Notices kept for idle sessions (PM-249), by session id: typed before the session's next input. */
  private readonly held = new Map<string, string[]>();

  constructor(deps: {
    ctx: DomainContext;
    sessions: Pick<SessionOrchestrator, 'typeInto' | 'isPaused'>;
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
          this.withHeld(
            session,
            text ??
              (plain ? message.body : formatInjectedTeamMessage(message.from, message.body, message.taskKey)),
          ),
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

  /**
   * The session is paused (PM-219): the message waits, stored, and goes in when the pause is over
   * (`deliverPauseHeld`). Not `deliverWaiting`'s business: that one would also type what other holds
   * keep back (the fix round limit, a refinement turn).
   */
  holdForPause(session: Session, message: TeamMessage): void {
    this.pauseHeld.set(`${message.id}:${session.member}`, {
      sessionId: session.id,
      messageId: message.id,
      member: session.member,
    });
  }

  /** The messages kept back for the session's pause go in now, in the order they came. */
  deliverPauseHeld(session: Session): void {
    for (const [claim, held] of [...this.pauseHeld]) {
      if (held.sessionId !== session.id) continue;
      this.pauseHeld.delete(claim);
      const message = this.messages.get(held.messageId);
      const receipt = message?.receipts?.find((r) => r.handle === held.member);
      // Taken in by another way meanwhile (a restart's first input): not typed twice.
      if (message && !receipt?.deliveredAt) this.deliver(session, message);
    }
  }

  /** The session's held messages are not typed in any more: its restart takes them as waiting ones. */
  dropPauseHeld(sessionId: string): void {
    for (const [claim, held] of [...this.pauseHeld])
      if (held.sessionId === sessionId) this.pauseHeld.delete(claim);
  }

  /** Types the messages waiting for the session's member and work item (after it started). */
  deliverWaiting(session: Session): void {
    // The start that is under way delivers them (`startAndDeliver`), in order.
    if (this.starting.has(recipientKey(session.projectKey, session.member, session.workItem))) return;
    const paused = this.sessions.isPaused(session);
    for (const message of this.messages.waiting(session.projectKey, session.member, session.workItem)) {
      if (paused) this.holdForPause(session, message);
      else if (!this.pauseHeld.has(`${message.id}:${session.member}`)) this.deliver(session, message);
    }
  }

  /** Types a notice with the team prefix that is not stored as a message. */
  notice(session: Session, from: string, text: string, taskKey: string | null): void {
    Promise.resolve()
      .then(() =>
        this.sessions.typeInto(
          session,
          this.withHeld(session, formatInjectedTeamMessage(from, text, taskKey)),
        ),
      )
      .catch((err: unknown) =>
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not deliver a message'),
      );
  }

  /**
   * A notice that must not start a turn (PM-249): a session that is not idle gets it typed now (the
   * runner queues it until the turn ends); an idle one keeps it, and it goes in front of the next text
   * typed into the session through `deliver` or `notice`, joined by `MESSAGE_SEPARATOR`. `session` is
   * read fresh by the caller: its state decides.
   */
  noticeOrHold(session: Session, from: string, text: string, taskKey: string | null): void {
    if (session.state !== 'idle') return this.notice(session, from, text, taskKey);
    const kept = this.held.get(session.id) ?? [];
    kept.push(formatInjectedTeamMessage(from, text, taskKey));
    this.held.set(session.id, kept);
  }

  /** Drops what was kept for a session that ended (`session_ended`). */
  dropHeld(sessionId: string): void {
    this.held.delete(sessionId);
  }

  /** `text` with the notices kept for the session in front of it; they are taken out. */
  private withHeld(session: Session, text: string): string {
    const kept = this.held.get(session.id);
    if (!kept) return text;
    this.held.delete(session.id);
    return [...kept, text].join(MESSAGE_SEPARATOR);
  }
}

function recipientKey(projectKey: string, handle: string, workItem: WorkItemRef): string {
  const wi = encodeWorkItem(workItem);
  return `${projectKey}:${handle}:${wi.type}:${wi.ref}`;
}
