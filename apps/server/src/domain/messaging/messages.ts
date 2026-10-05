import { isUnreadBy, messageRoute, sameWorkItem, threadPeersOf } from '@projectman/shared';
import type { Actor, TeamMessage, TeamMessageAnswer, TeamThread, WorkItemRef } from '@projectman/shared';
import { isoNow } from '../context';
import type { DomainContext } from '../context';
import type { TimelineService } from '../timeline';
import { forbidden, notFound } from '../errors';
import { excerpt, newId } from '../util';

export interface RecordMessageInput {
  projectKey: string;
  from: string;
  to: string[];
  taskKey: string | null;
  body: string;
  actor: Actor;
  sessionId?: string | null;
  /** Set when the message is delivered at once (e.g. to humans only). */
  delivered?: boolean;
  humanRecipients?: string[];
  /** Recipients that get the message somewhere else than its default place (`routeFor`), by handle. */
  routes?: Record<string, WorkItemRef>;
  /** Set on the message that carries a person's answer to an AI member's question (PM-249). */
  answer?: TeamMessageAnswer;
}

/**
 * Stored team messages (between any members, humans and AI) with their timeline entries, and
 * their receipts: delivered (typed into an AI recipient's session, or at once for a human) and
 * read (by a human recipient).
 */
export class MessageService {
  private readonly ctx: DomainContext;
  private readonly timeline: TimelineService;

  constructor(deps: { ctx: DomainContext; timeline: TimelineService }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
  }

  get(id: string): TeamMessage | null {
    return this.ctx.repos.messages.get(id);
  }

  record(input: RecordMessageInput): TeamMessage {
    const at = isoNow(this.ctx);
    const message: TeamMessage = {
      id: newId('msg'),
      projectKey: input.projectKey,
      from: input.from,
      to: [...new Set(input.to)],
      taskKey: input.taskKey,
      body: input.body,
      createdAt: at,
      deliveredAt: input.delivered ? at : null,
      receipts: [...new Set(input.to)].map((handle) => ({
        handle,
        kind: input.humanRecipients?.includes(handle) ? 'human' : 'ai',
        deliveredAt: input.humanRecipients?.includes(handle) || input.delivered ? at : null,
        readAt: null,
        ...(input.routes?.[handle] ? { route: input.routes[handle] } : {}),
      })),
      ...(input.answer ? { answer: input.answer } : {}),
    };
    return this.ctx.unitOfWork(() => {
      this.ctx.repos.messages.insert(message);
      this.ctx.bus.publish({ type: 'team_message', projectKey: message.projectKey, message });
      this.timeline.append({
        projectKey: message.projectKey,
        taskKey: message.taskKey,
        sessionId: input.sessionId ?? null,
        actor: input.actor,
        type: 'team_message',
        data: { messageId: message.id, from: message.from, to: message.to, excerpt: excerpt(message.body) },
      });
      return message;
    });
  }

  /** Messages an AI recipient has not received yet for a work item (where `messageRoute` puts them), oldest first. */
  waiting(projectKey: string, handle: string, workItem: WorkItemRef): TeamMessage[] {
    // A task's session takes the messages routed to that task; any other chat takes everything not
    // routed to a task (general ones, and answers routed to a schedule run or meeting whose session ended).
    return this.ctx.repos.messages.pending(projectKey, handle).filter((m) => {
      const route = messageRoute(m, handle);
      return workItem.type === 'task' ? sameWorkItem(route, workItem) : route.type !== 'task';
    });
  }

  markRecipientDelivered(id: string, handle: string): TeamMessage | null {
    const before = this.ctx.repos.messages.get(id);
    if (!before) return null;
    const at = isoNow(this.ctx);
    const receipts = (
      before.receipts ??
      before.to.map((h) => ({
        handle: h,
        kind: 'ai' as const,
        deliveredAt: before.deliveredAt,
        readAt: null,
      }))
    ).map((r) => (r.handle === handle && !r.deliveredAt ? { ...r, deliveredAt: at } : r));
    const deliveredAt = receipts.every((r) => r.deliveredAt) ? (before.deliveredAt ?? at) : null;
    const message = this.ctx.repos.messages.updateReceipts(id, receipts, deliveredAt);
    if (message) this.ctx.bus.publish({ type: 'team_message', projectKey: message.projectKey, message });
    return message;
  }

  markRead(
    projectKey: string,
    id: string,
    handle: string,
    humanRecipients: string[] = [handle],
  ): TeamMessage {
    const before = this.ctx.repos.messages.get(id);
    if (!before || before.projectKey !== projectKey) throw notFound('message', id);
    if (!before.to.includes(handle))
      throw forbidden('not_a_recipient', 'Only a recipient may mark a message read');
    return this.applyRead(before, handle, humanRecipients);
  }

  /**
   * Marks the messages among `ids` read that were sent to `handle` and that they have not read yet
   * (an unknown, foreign, not-addressed or already read one is left out), as one unit with one
   * `team_message` event each. Returns the messages that changed, oldest first.
   */
  markReadMany(
    projectKey: string,
    ids: readonly string[],
    handle: string,
    humanRecipients: string[] = [handle],
  ): TeamMessage[] {
    return this.ctx.unitOfWork(() => {
      const changed: TeamMessage[] = [];
      for (const id of new Set(ids)) {
        const before = this.ctx.repos.messages.get(id);
        if (!before || before.projectKey !== projectKey || !isUnreadBy(before, handle)) continue;
        changed.push(this.applyRead(before, handle, humanRecipients));
      }
      return changed;
    });
  }

  /**
   * The member's conversations with the other members, the most recently active first: the peers
   * each message falls to by `threadPeersOf`, each with its latest message and unread count. It
   * counts over every message of the member, not over a page of them.
   */
  threads(projectKey: string, handle: string): TeamThread[] {
    const threads = new Map<string, { lastId: string; unreadCount: number }>();
    for (const summary of this.ctx.repos.messages.involving(projectKey, handle)) {
      const unread = isUnreadBy(summary, handle) ? 1 : 0;
      for (const peer of threadPeersOf(summary, handle)) {
        const thread = threads.get(peer);
        // Most recent last: re-inserting moves a conversation to the end of the iteration order.
        threads.delete(peer);
        threads.set(peer, { lastId: summary.id, unreadCount: (thread?.unreadCount ?? 0) + unread });
      }
    }
    return [...threads].reverse().map(([peer, { lastId, unreadCount }]) => ({
      peer,
      lastMessage: this.ctx.repos.messages.get(lastId)!,
      unreadCount,
    }));
  }

  private applyRead(before: TeamMessage, handle: string, humanRecipients: string[]): TeamMessage {
    const projectKey = before.projectKey;
    const id = before.id;
    const at = isoNow(this.ctx);
    const receipts = (
      before.receipts ??
      before.to.map((h) => ({
        handle: h,
        kind: humanRecipients.includes(h) ? ('human' as const) : ('ai' as const),
        deliveredAt: before.deliveredAt,
        readAt: null,
      }))
    ).map((r) =>
      r.handle === handle
        ? { ...r, kind: 'human' as const, deliveredAt: r.deliveredAt ?? at, readAt: r.readAt ?? at }
        : r,
    );
    const message = this.ctx.repos.messages.updateReceipts(id, receipts, before.deliveredAt)!;
    this.ctx.bus.publish({ type: 'team_message', projectKey, message });
    return message;
  }

  list(
    projectKey: string,
    filter: {
      taskKey?: string;
      member?: string;
      participant?: string;
      between?: [string, string];
      unreadFor?: string;
      limit?: number;
    } = {},
  ): TeamMessage[] {
    return this.ctx.repos.messages.list(projectKey, filter);
  }

  /** Messages to the member that they have not read. */
  countUnread(projectKey: string, handle: string): number {
    return this.ctx.repos.messages.countUnread(projectKey, handle);
  }
}
