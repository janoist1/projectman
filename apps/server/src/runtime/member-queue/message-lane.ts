import type { ProjectConfig, TaskStartWaiting, TeamMessage, WorkItemRef } from '@projectman/shared';
import {
  hasSuperOrigin,
  isOpenTask,
  isTheme,
  memberOf,
  messageWakes,
  pendingRecipientsOf,
  quoteOf,
} from '@projectman/shared';
import type { StoredMemberQueueItem } from '../../db';
import type { DomainContext } from '../../core/base';
import type { MessageService } from '../../core/messages';
import { wakeFactsFor, wakesFor } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { MessageDelivery, MessageRouter } from '../delivery';
import type { SessionStartCause } from '../sessions';
import type { MemberQueueLane } from './lane';

/** The hold code of a message the fix round limit held for an assignee who has been replaced meanwhile. */
const STAYS_WITH_FORMER_ASSIGNEE = 'hold_fix_limit_reassigned';

/** What the message lane needs of the rest of the server. */
interface MessageLaneDeps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'cachedConfig'>;
  tasks: Pick<TaskService, 'find'>;
  messages: Pick<MessageService, 'recordAnswerDelivery' | 'rerouteRecipient'>;
  messageRouter: Pick<MessageRouter, 'holdNameOf'>;
  delivery: Pick<MessageDelivery, 'deliverWaiting' | 'startAndDeliver'>;
}

/**
 * The lane of the team messages (PM-925). The messages are delivered the way they always were: typed into the
 * session at their place at its turn boundary, or in the first input of the session they wake (`start`), where
 * the receipt and the item close together (`markRecipientDelivered`). The lane only says which messages are
 * owed, held back, and what starts the session; the driver decides when.
 */
export function messageLane(deps: MessageLaneDeps): MemberQueueLane {
  const { ctx } = deps;
  const messageOf = (item: StoredMemberQueueItem): TeamMessage | null =>
    ctx.repos.messages.get(item.source.id);

  const causeOf = (item: StoredMemberQueueItem): SessionStartCause => {
    const first = messageOf(item);
    const config = deps.projects.cachedConfig(item.projectKey);
    if (!first || !config) return { kind: 'message', by: { kind: 'system', handle: null } };
    const origin = first.origin;
    const mergeEvent =
      origin?.kind === 'note' && first.from === 'system'
        ? ctx.repos.timeline.get(item.projectKey, origin.eventId)
        : null;
    return {
      kind: mergeEvent?.type.startsWith('task_merge_')
        ? 'merge'
        : origin?.kind === 'note'
          ? 'mention'
          : origin?.kind === 'label'
            ? 'sent_back'
            : origin?.kind === 'answer'
              ? 'answer'
              : 'message',
      by:
        hasSuperOrigin(first.actor) && first.actor.handle === first.from
          ? first.actor
          : {
              kind: memberOf(config, first.from)?.kind ?? 'system',
              handle: first.from,
              ...(first.via ? { via: first.via } : {}),
            },
      messageId: first.id,
      ...(origin?.kind === 'note' ? { eventId: origin.eventId } : {}),
      ...(origin?.kind === 'label'
        ? { labels: origin.labels, eventId: origin.eventId }
        : { quote: quoteOf(first.answer?.answer ?? first.body) }),
      ...(origin?.kind === 'answer' ? { inboxItemId: origin.inboxItemId } : {}),
    };
  };

  /** Whether the message would wake its recipient were it not stale: what a closed card's message is kept for. */
  const wakesDespiteStale = (message: TeamMessage, config: ProjectConfig, member: string): boolean =>
    messageWakes(message, wakeFactsFor(ctx, config, message, member), null);

  return {
    kinds: ['message'],
    completion: 'delivery',
    oneAtATime: false,
    cause: causeOf,
    render: () => null,
    stillOwed: (item) => {
      const message = messageOf(item);
      return !!message && pendingRecipientsOf(message).includes(item.member);
    },
    hold: async (item) => {
      const message = messageOf(item);
      const config = deps.projects.cachedConfig(item.projectKey);
      if (!message || !config) return null;
      const task = item.taskKey ? deps.tasks.find(item.projectKey, item.taskKey) : null;
      const held = deps.messageRouter.holdNameOf(config, task, message.from, item.member);
      // The answer to a member's own question is never held back by the refinement line.
      const answers = message.origin?.kind === 'answer' || message.origin?.kind === 'question_forward';
      const name = held === 'refinement_turn' && answers ? null : held;
      // What the fix round limit held for the assignee stays with them when the card is given to someone else
      // (PM-262), through the handoff that follows: it does not wake a member on a card it no longer has.
      const heldForLimit =
        item.wait?.code === 'hold_fix_limit' || item.wait?.code === STAYS_WITH_FORMER_ASSIGNEE;
      if (name) return heldForLimit && name === 'handoff' ? STAYS_WITH_FORMER_ASSIGNEE : `hold_${name}`;
      return heldForLimit && task && task.assignee !== item.member ? STAYS_WITH_FORMER_ASSIGNEE : null;
    },
    wakes: (item, config) => {
      const message = messageOf(item);
      return !!message && wakesFor(ctx, config, message, item.member);
    },
    // No session starts on a closed card, and a theme has none: what a person wrote or answered goes to the
    // member's desk, the rest ends with the card.
    relocate: (item) => {
      if (item.place.type !== 'task') return null;
      const task = deps.tasks.find(item.projectKey, item.place.taskKey);
      if (!task || (isOpenTask(task) && !isTheme(task))) return null;
      const message = messageOf(item);
      const config = deps.projects.cachedConfig(item.projectKey);
      if (!message || !config) return 'closed';
      return wakesDespiteStale(message, config, item.member)
        ? ({ type: 'general' } satisfies WorkItemRef)
        : 'closed';
    },
    moved: (item, place) => {
      deps.messages.rerouteRecipient(item.source.id, item.member, place);
    },
    deliverLive: (session) => deps.delivery.deliverWaiting(session),
    start: ({ member, place, items, run }) =>
      deps.delivery.startAndDeliver(items[0]!.projectKey, member, place, run),
    deferred: (item, code, at) => {
      const message = messageOf(item);
      if (message)
        deps.messages.recordAnswerDelivery(message, item.member, {
          state: 'waiting',
          reason: code as TaskStartWaiting['reason'],
          since: at,
        });
    },
  };
}
