import { dutyMembers, isOnLeave, SYSTEM_SENDER } from '@projectman/shared';
import type { MemberConfig, Session } from '@projectman/shared';
import type { FeedbackMarkRecord } from '../../db';
import type { DomainContext } from '../context';
import { isoNow } from '../context';
import type { DomainEventMap } from '../events';
import type { Messaging } from '../messaging';
import type { ProjectService } from '../projects';
import { KeyedMutex, SYSTEM_ACTOR } from '../util';

/**
 * Wakes the feedback processor (PM-512). A new mark, or a marker's comment on an open one, sends the
 * project's AI processor one stored `action` message from the system; marks that arrive while that
 * message is still undelivered share it. The mark remembers who was woken and with which message
 * (`handed_*`), which the app shows as "the project manager is working on it". The mark is cleared when
 * the processor decides it, or when the processor's general session has taken the message and its turn
 * ended. A mark is never woken for twice: what the processor leaves undecided stays a to-do for a person.
 */
export class FeedbackNotices {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly messaging: Messaging;
  private readonly projectLocks = new KeyedMutex();

  constructor(deps: { ctx: DomainContext; projects: ProjectService; messaging: Messaging }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.messaging = deps.messaging;
  }

  /** A mark waits for a decision: the processor is told, unless it already was for this mark. */
  async needsProcessor({ projectKey, markId }: DomainEventMap['feedback_needs_processor']): Promise<void> {
    await this.projectLocks.run(projectKey, async () => {
      const { feedback } = this.ctx.repos;
      const mark = feedback.getMark(markId);
      if (!mark || mark.projectKey !== projectKey || mark.status !== 'new' || mark.handedTo !== null) return;
      const config = await this.projects.config(projectKey);
      const processor = this.processorOf(config);
      if (!processor) return;
      // The processor was told about other marks and has not taken the message yet: this one rides on it.
      const waiting = feedback
        .listHanded(projectKey)
        .find(
          (handed) =>
            handed.handedTo === processor.handle &&
            handed.handedMessageId !== null &&
            !this.delivered(handed.handedMessageId, processor.handle),
        );
      let messageId = waiting?.handedMessageId ?? null;
      if (messageId === null) {
        const count = feedback.countNew(projectKey);
        const message = await this.messaging.send(
          projectKey,
          SYSTEM_SENDER,
          {
            to: [processor.handle],
            taskKey: null,
            text: `Feedback waits in project ${projectKey}: ${count} mark(s). Call get_feedback and decide each one.`,
          },
          { kind: 'action', actor: SYSTEM_ACTOR },
        );
        messageId = message.id;
      }
      // The mark may have been decided while the message was sent.
      const current = feedback.getMark(markId);
      if (!current || current.status !== 'new' || current.handedTo !== null) return;
      feedback.updateMark(markId, {
        handedTo: processor.handle,
        handedAt: isoNow(this.ctx),
        handedMessageId: messageId,
      });
      this.ctx.bus.publish({ type: 'feedback_changed', projectKey, markId });
    });
  }

  /**
   * A session's turn ended or the session did: the marks its member was woken for, whose message the
   * session has taken, are no longer "being worked on".
   */
  settle(session: Session): void {
    if (session.workItem.type !== 'general') return;
    const { feedback } = this.ctx.repos;
    const handed: FeedbackMarkRecord[] = feedback
      .listHanded(session.projectKey)
      .filter(
        (mark) =>
          mark.handedTo === session.member &&
          mark.handedMessageId !== null &&
          this.delivered(mark.handedMessageId, session.member),
      );
    for (const mark of handed) {
      feedback.updateMark(mark.id, { handedTo: null, handedAt: null, handedMessageId: null });
      this.ctx.bus.publish({ type: 'feedback_changed', projectKey: mark.projectKey, markId: mark.id });
    }
  }

  /** The first AI that holds the processing duty and can take work: not on leave and not a temporary worker. */
  private processorOf(config: Parameters<typeof dutyMembers>[0]): MemberConfig | null {
    return (
      dutyMembers(config, 'feedback_processing').find(
        (member) => member.kind === 'ai' && !isOnLeave(member) && !member.temp,
      ) ?? null
    );
  }

  /** Whether the member's session has taken the stored message. */
  private delivered(messageId: string, handle: string): boolean {
    const message = this.ctx.repos.messages.get(messageId);
    if (!message) return true;
    const receipt = message.receipts?.find((r) => r.handle === handle);
    return Boolean(receipt ? receipt.deliveredAt : message.deliveredAt);
  }
}
