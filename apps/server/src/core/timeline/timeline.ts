export function createTimelineService(
  ctx: ConstructorParameters<typeof TimelineService>[0],
): TimelineService {
  return new TimelineService(ctx);
}

import { isLoopWork, withCommentEdits } from '@projectman/shared';
import type { Actor, TimelineEvent, TimelineEventData, TimelineEventType } from '@projectman/shared';
import { isoNow } from '../base';
import type { DomainContext } from '../base';
import { newId } from '../../kernel';

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
    // The conversation on a card is watched for message storms (PM-186): the listeners hear of the entry
    // once the unit of work that records it has committed.
    if (event.taskKey && (event.type === 'team_message' || event.type === 'task_note'))
      this.ctx.afterCommit(() => void this.ctx.events.emit('task_talk_recorded', { event }));
    // A note, an attachment and a new description are the work of a team that does not write code (PM-431).
    if (event.taskKey && isLoopWork(event))
      this.ctx.afterCommit(() => void this.ctx.events.emit('task_work_recorded', { event }));
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

  /** The most recent work on a card (see `isLoopWork`), or null. */
  latestWork(projectKey: string, taskKey: string): TimelineEvent | null {
    return this.ctx.repos.timeline.latestWork(projectKey, taskKey);
  }

  /** All the notes of a card, oldest first (PM-1290). */
  notesOfCard(projectKey: string, taskKey: string): TimelineEvent[] {
    return this.ctx.repos.timeline.notesOfCard(projectKey, taskKey);
  }

  /** The edits of the given comments, oldest first (PM-1277). */
  editsOfNotes(projectKey: string, noteIds: readonly string[]): TimelineEvent[] {
    return this.ctx.repos.timeline.editsOfNotes(projectKey, noteIds);
  }

  /** The events with every comment's latest text and its `edited` mark (PM-1277); the stored notes stay as written. */
  withCommentEdits(projectKey: string, events: readonly TimelineEvent[]): TimelineEvent[] {
    const noteIds = events.filter((event) => event.type === 'task_note').map((event) => event.id);
    // An edit event itself still shrinks to its `noteId`, so no earlier text leaves in it.
    if (noteIds.length === 0 && !events.some((event) => event.type === 'task_note_edited'))
      return [...events];
    return withCommentEdits(events, this.editsOfNotes(projectKey, noteIds));
  }

  /** The note this author already submitted on the card with this client request id, or null (PM-1290). */
  noteByClientRequest(
    projectKey: string,
    taskKey: string,
    actor: Actor,
    clientRequestId: string,
  ): TimelineEvent | null {
    return this.ctx.repos.timeline.noteByClientRequest(projectKey, taskKey, actor, clientRequestId);
  }

  /** Most recent events, oldest first. */
  list(
    projectKey: string,
    opts: { taskKey?: string; limit?: number; excludeTypes?: readonly TimelineEventType[] } = {},
  ): TimelineEvent[] {
    return this.ctx.repos.timeline.list(projectKey, opts);
  }

  count(
    projectKey: string,
    opts: { taskKey?: string; excludeTypes?: readonly TimelineEventType[] } = {},
  ): number {
    return this.ctx.repos.timeline.count(projectKey, opts);
  }
}
