import type { Actor, TeamMessage } from '@projectman/shared';
import { isoNow } from './context';
import type { DomainContext } from './context';
import type { TimelineService } from './timeline';
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
    const message = this.ctx.repos.messages.markDelivered(id, isoNow(this.ctx));
    if (message) this.ctx.bus.publish({ type: 'team_message', projectKey: message.projectKey, message });
    return message;
  }

  list(
    projectKey: string,
    filter: { taskKey?: string; member?: string; limit?: number } = {},
  ): TeamMessage[] {
    return this.ctx.repos.messages.list(projectKey, filter);
  }
}
