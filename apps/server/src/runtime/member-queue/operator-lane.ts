import type { TeamMessage } from '@projectman/shared';
import {
  memberOf,
  operatorOf,
  pendingRecipientsOf,
  questionPayloadOf,
  sessionWorkItemOf,
  SYSTEM_SENDER,
} from '@projectman/shared';
import { operatorQueueText } from '../../agent-text';
import type { StoredMemberQueueItem } from '../../db';
import type { DomainContext } from '../../core/base';
import type { MessageService } from '../../core/messages';
import type { OperatorQueueFinisher } from '../../core/member-queue';
import type { ProjectService } from '../../core/projects';
import type { SessionOrchestrator, SessionStartCause } from '../sessions';
import type { MemberQueueLane } from './lane';

/** The hold code while the owner talks to the Operator: its answer to a person comes before the queue. */
const OWNER_REQUEST_HOLD = 'hold_owner_request';

/** What the lane asks of the Operator's requests (the services' `OperatorRequests`): a queue request opens for the item. */
export interface OperatorQueueRequests {
  open(input: {
    projectKey: string;
    sessionId: string;
    source: 'queue';
    messageId: string | null;
    inboxItemId: string | null;
    queueItemId: string;
    from: string;
    text: string;
  }): unknown;
  openFor(sessionId: string): { source: string } | null;
}

/** What the Operator lane needs of the rest of the server. */
export interface OperatorLaneDeps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'cachedConfig'>;
  messages: Pick<MessageService, 'markRecipientDelivered'>;
  requests: OperatorQueueRequests;
  sessions: Pick<SessionOrchestrator, 'findRunning'>;
  finisher: Pick<OperatorQueueFinisher, 'handOffUnfinished'>;
}

/**
 * The lane of the Operator's work (PM-885): the integrator todos and held fix round decisions the system
 * opens, and the action messages an AI member or the system sends it. One item is worked at a time, in the
 * Operator's desk session, and it ends when the Operator calls `finish_queue_item` (`completion: finish`).
 * A person's own message to the Operator stays on the message lane.
 */
export function operatorLane(deps: OperatorLaneDeps): MemberQueueLane {
  const { ctx } = deps;

  const messageOf = (item: StoredMemberQueueItem): TeamMessage | null =>
    item.source.type === 'message' ? ctx.repos.messages.get(item.source.id) : null;

  return {
    kinds: ['todo', 'fix_limit', 'message'],
    completion: 'finish',
    oneAtATime: true,
    appliesTo: (item, config) => {
      if (item.member !== operatorOf(config)?.handle) return false;
      if (item.kind === 'message')
        return (
          item.source.type === 'message' &&
          item.wake &&
          (item.from === null || memberOf(config, item.from)?.kind === 'ai')
        );
      return item.source.type === 'inbox';
    },
    cause: (item): SessionStartCause => {
      const config = deps.projects.cachedConfig(item.projectKey);
      const kind = item.from && config ? (memberOf(config, item.from)?.kind ?? 'system') : 'system';
      return {
        kind: 'member_queue',
        by: { kind, handle: item.from },
        ...(item.source.type === 'message' ? { messageId: item.source.id } : {}),
        ...(item.source.type === 'inbox' ? { inboxItemId: item.source.id } : {}),
      };
    },
    render: (item) => {
      const reminded = ctx.repos.memberQueue.payload<{ reminded?: boolean }>(item.id)?.reminded === true;
      const frame = {
        itemId: item.id,
        kind: item.kind as 'todo' | 'fix_limit' | 'message',
        from: item.from,
        taskKey: item.taskKey,
        title: item.title,
        reminded,
      };
      if (item.kind === 'message')
        return operatorQueueText({ ...frame, body: messageOf(item)?.body ?? '', options: [] });
      const inbox = ctx.repos.inbox.get(item.source.id);
      const todo = (inbox && questionPayloadOf(inbox)?.screening?.todo) || null;
      const body = todo
        ? [`What: ${todo.what}`, `Where: ${todo.where}`, `Expected: ${todo.expected}`].join('\n')
        : (inbox?.body ?? inbox?.title ?? '');
      return operatorQueueText({
        ...frame,
        body,
        options:
          item.kind === 'fix_limit'
            ? (inbox?.options ?? []).map((option) => ({ id: option.id, label: option.label }))
            : [],
      });
    },
    stillOwed: (item) => {
      if (item.kind === 'message') {
        const message = messageOf(item);
        return !!message && pendingRecipientsOf(message).includes(item.member);
      }
      return ctx.repos.inbox.get(item.source.id)?.state === 'open';
    },
    // An owner's request in the Operator's session comes first: the queue waits for the turn to end.
    hold: async (item) => {
      const config = deps.projects.cachedConfig(item.projectKey);
      const operator = config && memberOf(config, item.member);
      if (!operator || operator.kind !== 'ai') return null;
      const session = deps.sessions.findRunning(
        item.projectKey,
        item.member,
        sessionWorkItemOf(operator, { type: 'general' }),
      );
      if (!session) return null;
      const open = deps.requests.openFor(session.id);
      return open && open.source !== 'queue' ? OWNER_REQUEST_HOLD : null;
    },
    delivered: (item, sessionId) => {
      if (item.source.type === 'message') deps.messages.markRecipientDelivered(item.source.id, item.member);
      deps.requests.open({
        projectKey: item.projectKey,
        sessionId,
        source: 'queue',
        messageId: item.source.type === 'message' ? item.source.id : null,
        inboxItemId: item.source.type === 'inbox' ? item.source.id : null,
        queueItemId: item.id,
        from: item.from ?? SYSTEM_SENDER,
        text: item.title,
      });
    },
    exhausted: (item) => deps.finisher.handOffUnfinished(item),
  };
}
