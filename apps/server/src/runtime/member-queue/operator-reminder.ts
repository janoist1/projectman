import type { Session } from '@projectman/shared';
import { isOperator, memberOf, SYSTEM_SENDER } from '@projectman/shared';
import { operatorQueueReminderText } from '../../agent-text';
import type { DomainContext } from '../../core/base';
import type { OperatorQueueFinisher } from '../../core/member-queue';
import type { ProjectService } from '../../core/projects';
import type { MessageDelivery } from '../delivery';
import type { OperatorQueueRequests } from './operator-lane';

/** The kinds of queue item the Operator ends itself (`finish_queue_item`). */
const OPERATOR_KINDS = ['todo', 'fix_limit', 'message'] as const;

/** What the reminder needs of the rest of the server. */
interface OperatorQueueReminderDeps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'cachedConfig'>;
  requests: Pick<OperatorQueueRequests, 'open'>;
  delivery: Pick<MessageDelivery, 'notice'>;
  finisher: Pick<OperatorQueueFinisher, 'handOffUnfinished'>;
}

/**
 * The Operator's turn ended with an item of its queue still open (PM-885): once it is reminded in the same
 * session, with a new queue request for the item; when the turn ends again without closing it, the item goes
 * to the owner (`processing_failed`). The remembering lives on the item (`payload.reminded`).
 */
export class OperatorQueueReminder {
  private readonly deps: OperatorQueueReminderDeps;

  constructor(deps: OperatorQueueReminderDeps) {
    this.deps = deps;
  }

  /** The session's turn ended (its requests have just been closed). */
  async turnEnded(session: Session): Promise<void> {
    const { ctx, projects } = this.deps;
    const config = projects.cachedConfig(session.projectKey);
    if (!config || !isOperator(memberOf(config, session.member))) return;
    const repo = ctx.repos.memberQueue;
    for (const item of repo.listOpen(session.projectKey, session.member)) {
      if (
        item.state !== 'processing' ||
        item.sessionId !== session.id ||
        !OPERATOR_KINDS.includes(item.kind as (typeof OPERATOR_KINDS)[number])
      )
        continue;
      const payload = repo.payload<Record<string, unknown>>(item.id) ?? {};
      if (payload.reminded === true) {
        await this.deps.finisher.handOffUnfinished(item);
        continue;
      }
      repo.setPayload(item.id, { ...payload, reminded: true });
      this.deps.requests.open({
        projectKey: item.projectKey,
        sessionId: session.id,
        source: 'queue',
        messageId: item.source.type === 'message' ? item.source.id : null,
        inboxItemId: item.source.type === 'inbox' ? item.source.id : null,
        queueItemId: item.id,
        from: item.from ?? SYSTEM_SENDER,
        text: item.title,
      });
      await this.deps.delivery.notice(
        session,
        SYSTEM_SENDER,
        operatorQueueReminderText(item.id),
        item.taskKey,
      );
    }
  }
}
