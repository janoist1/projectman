import type { Actor, TimelineEvent, TimelineEventData, TimelineEventType } from '@projectman/shared';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { newId } from './util';

/** An event to append; `data` has the shape its type documents in `TimelineEventData`. */
export type AppendTimelineInput = {
  [Type in TimelineEventType]: {
    projectKey: string;
    taskKey?: string | null;
    sessionId?: string | null;
    actor: Actor;
    type: Type;
    data: TimelineEventData[Type];
    createdAt?: string;
  };
}[TimelineEventType];

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
    // The conversation on a card is watched for message storms (PM-186): the listeners run here, in
    // the unit of work that records the entry.
    if (event.taskKey && (event.type === 'team_message' || event.type === 'task_note'))
      void this.ctx.events.emit('task_talk_recorded', { event });
    return event;
  }

  /** One event of a project, or null. */
  get(projectKey: string, id: string): TimelineEvent | null {
    return this.ctx.repos.timeline.get(projectKey, id);
  }

  /** The most recent event of a type on a card, or null. */
  latest(projectKey: string, taskKey: string, type: TimelineEventType): TimelineEvent | null {
    return this.ctx.repos.timeline.latestOfType(projectKey, taskKey, type);
  }

  /** Most recent events, oldest first. */
  list(projectKey: string, opts: { taskKey?: string; limit?: number } = {}): TimelineEvent[] {
    return this.ctx.repos.timeline.list(projectKey, opts);
  }
}
