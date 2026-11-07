import type { Session, TeamMessage } from '@projectman/shared';
import type { DomainContext } from '../base';
import type { MessageTurn, MessageTurnEnd } from '../../db';

/**
 * The turns messages were typed into (PM-1290): a row per message and AI recipient that ties the message to the
 * session that processes it. A row is written when the typing succeeds and closed by the end of that session's
 * turn, so the feedback of an old message never follows the session's later work.
 */
export class MessageTurns {
  private readonly ctx: DomainContext;

  constructor(deps: { ctx: DomainContext }) {
    this.ctx = deps.ctx;
  }

  /** Writes the turn once: typing the same message again (PM-1205) adds none. */
  open(message: TeamMessage, handle: string, sessionId: string, typedAt: string): void {
    const inserted = this.ctx.repos.messageTurns.insert({
      projectKey: message.projectKey,
      messageId: message.id,
      handle,
      sessionId,
      typedAt,
    });
    if (inserted) this.announce([message]);
  }

  /**
   * The session's turn is over (it went idle, or it ended): closes its open turns typed at or before `at`. The
   * event's own time guards a late or repeated event, which only ever closes an open turn.
   */
  close(session: Pick<Session, 'id'>, at: string, endState: MessageTurnEnd): void {
    this.announceTurns(this.ctx.repos.messageTurns.closeOpen(session.id, at, endState));
  }

  /** The session's state changed: the open turns of it show the new state. */
  stateChanged(session: Pick<Session, 'id'>): void {
    this.announceTurns(this.ctx.repos.messageTurns.openOfSession(session.id));
  }

  /** The recipients of these messages may have a reply now: their processing is read again. */
  announce(messages: readonly TeamMessage[]): void {
    for (const message of messages)
      this.ctx.bus.publish({
        type: 'message_processing_changed',
        projectKey: message.projectKey,
        messageId: message.id,
        taskKey: message.taskKey,
        from: message.from,
      });
  }

  private announceTurns(turns: readonly MessageTurn[]): void {
    if (turns.length === 0) return;
    const messages = this.ctx.repos.messages.getMany([...new Set(turns.map((turn) => turn.messageId))]);
    this.announce([...messages.values()]);
  }
}
