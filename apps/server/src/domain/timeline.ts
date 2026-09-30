import type { Actor, TimelineEvent, TimelineEventType } from '@projectman/shared';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { newId } from './util';

export interface AppendTimelineInput {
  projectKey: string;
  taskKey?: string | null;
  sessionId?: string | null;
  actor: Actor;
  type: TimelineEventType;
  data: Record<string, unknown>;
  createdAt?: string;
}

/** Append-only, attributed audit trail ("who did what"), per task and project. */
export class TimelineService {
  private readonly ctx: DomainContext;

  constructor(ctx: DomainContext) {
    this.ctx = ctx;
  }

  append(input: AppendTimelineInput): TimelineEvent {
    const event: TimelineEvent = {
      id: newId('evt'),
      projectKey: input.projectKey,
      taskKey: input.taskKey ?? null,
      sessionId: input.sessionId ?? null,
      actor: input.actor,
      type: input.type,
      data: input.data,
      createdAt: input.createdAt ?? isoNow(this.ctx),
    };
    this.ctx.repos.timeline.insert(event);
    this.ctx.bus.publish({ type: 'timeline_appended', projectKey: event.projectKey, event });
    return event;
  }

  /** Most recent events, oldest first. */
  list(projectKey: string, opts: { taskKey?: string; limit?: number } = {}): TimelineEvent[] {
    return this.ctx.repos.timeline.list(projectKey, opts);
  }
}
