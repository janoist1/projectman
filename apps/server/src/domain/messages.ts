import type { Actor, TeamMessage } from '@projectman/shared';
import { isoNow } from './context';
import type { DomainContext } from './context';
import type { TimelineService } from './timeline';
import { forbidden, notFound } from './errors';
import { excerpt, newId } from './util';

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
}

/** Stored team messages (between any members, humans and AI), with timeline entries. */
export class MessageService {
  private readonly ctx: DomainContext;
  private readonly timeline: TimelineService;

  constructor(deps: { ctx: DomainContext; timeline: TimelineService }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
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
      })),
    };
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
  }

  markDelivered(id: string): TeamMessage | null {
    const before = this.ctx.repos.messages.get(id);
    if (!before || before.deliveredAt) return before;
    const at = isoNow(this.ctx);
    const message = before.receipts
      ? this.ctx.repos.messages.updateReceipts(
          id,
          before.receipts.map((r) => ({ ...r, deliveredAt: r.deliveredAt ?? at })),
          at,
        )
      : this.ctx.repos.messages.markDelivered(id, at);
    if (message) this.ctx.bus.publish({ type: 'team_message', projectKey: message.projectKey, message });
    return message;
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
      between?: [string, string];
      unreadFor?: string;
      limit?: number;
    } = {},
  ): TeamMessage[] {
    return this.ctx.repos.messages.list(projectKey, filter);
  }
}
