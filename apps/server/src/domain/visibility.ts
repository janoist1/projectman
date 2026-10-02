import { canSeeTask, isCardLink } from '@projectman/shared';
import type {
  InboxItem,
  ServerEvent,
  Task,
  TaskDetail,
  TeamMessage,
  TimelineEvent,
} from '@projectman/shared';
import type { ProjectAccess } from './access';

/**
 * What a member sees of their project. Client members (access "client") see only what is
 * shared with them; every other access level sees the whole project. The REST routes and the
 * websocket both decide here.
 *
 * The two paths do not agree everywhere yet (an open question for the owner, kept as it was):
 * - timeline: the task detail shows a client the milestones below, while live timeline
 *   events never reach them (and label changes, e.g. "client accepted", are no milestone);
 * - member state: the board shows a client every member's status and activity, while live
 *   member_state events never reach them (member_changed snapshots do).
 */
export type Viewer = Pick<ProjectAccess, 'access' | 'handle'>;

/** Events of a subscribed project (everything but the connection and terminal events). */
export type ProjectEvent = Exclude<
  ServerEvent,
  { type: 'hello' | 'error' | 'terminal_data' | 'terminal_snapshot' }
>;

export function isClient(viewer: Viewer): boolean {
  return viewer.access === 'client';
}

/** Internal tasks are hidden from client members (the rule lives in `packages/shared`). */
export { canSeeTask };

/** A client sees only the inbox items assigned to them. */
export function canSeeInboxItem(viewer: Viewer, item: InboxItem): boolean {
  return !isClient(viewer) || item.assignees.includes(viewer.handle);
}

/** A client sees only the team messages they sent or received. */
export function canSeeTeamMessage(viewer: Viewer, message: TeamMessage): boolean {
  return !isClient(viewer) || message.from === viewer.handle || message.to.includes(viewer.handle);
}

/** The member whose messages a listing may show (sent or received): a client only their own. */
export function teamMessageMember(viewer: Viewer, requested: string | undefined): string | undefined {
  return isClient(viewer) ? viewer.handle : requested;
}

/**
 * A task as the viewer sees it: a client gets a task's links to other cards (relations, PM-192) and its
 * theme only when the other card is shared with them. `canSeeKey` says whether the viewer sees a card.
 */
export function withVisibleCardLinks(viewer: Viewer, task: Task, canSeeKey: (key: string) => boolean): Task {
  if (!isClient(viewer)) return task;
  const hideTheme = !!task.themeKey && !canSeeKey(task.themeKey);
  if (!hideTheme && !task.links.some(isCardLink)) return task;
  const { themeKey: _theme, ...shown } = task;
  return {
    ...(hideTheme ? shown : task),
    links: task.links.filter((link) => !isCardLink(link) || canSeeKey(link.ref)),
  };
}

/** The tasks the viewer sees, each as they see it: a client's links to other cards lead only to cards they see. */
export function visibleTasks(viewer: Viewer, tasks: readonly Task[]): Task[] {
  const visible = tasks.filter((task) => canSeeTask(viewer, task));
  if (!isClient(viewer)) return visible;
  const keys = new Set(visible.map((task) => task.key));
  return visible.map((task) => withVisibleCardLinks(viewer, task, (key) => keys.has(key)));
}

const CLIENT_TASK_TIMELINE = new Set<TimelineEvent['type']>([
  'task_created',
  'task_stage_changed',
  'task_check_changed',
  'attachment_added',
  'attachment_deleted',
]);

/** The main milestones of a task, the part of its timeline a client sees in the task detail. */
export function clientCanSeeTimelineEvent(event: TimelineEvent): boolean {
  return CLIENT_TASK_TIMELINE.has(event.type);
}

/**
 * What the viewer may see of a task detail; the task itself must be visible (canSeeTask).
 * `canSeeKey` says whether the viewer sees a card by its key (for the links to other cards).
 */
export function visibleTaskDetail(
  viewer: Viewer,
  detail: TaskDetail,
  canSeeKey: (key: string) => boolean = () => true,
): TaskDetail {
  if (!isClient(viewer)) return detail;
  return {
    task: withVisibleCardLinks(viewer, detail.task, canSeeKey),
    parent: detail.parent && canSeeTask(viewer, detail.parent) ? detail.parent : null,
    subtasks: detail.subtasks
      ?.filter((task) => canSeeTask(viewer, task))
      .map((task) => withVisibleCardLinks(viewer, task, canSeeKey)),
    pullRequests: detail.pullRequests,
    timeline: detail.timeline.filter(clientCanSeeTimelineEvent),
    sessions: [],
  };
}

/**
 * The event as the viewer sees it, once `canSeeProjectEvent` let it through: a client's task
 * snapshot keeps only its links to cards they see.
 */
export function visibleProjectEvent(
  viewer: Viewer,
  event: ProjectEvent,
  taskOf: (taskKey: string) => Task | null | undefined,
): ProjectEvent {
  if (!isClient(viewer) || event.type !== 'task_upserted') return event;
  return {
    ...event,
    task: withVisibleCardLinks(viewer, event.task, (key) => {
      const other = taskOf(key);
      return !!other && canSeeTask(viewer, other);
    }),
  };
}

/**
 * Whether a live event of the viewer's project reaches them (websocket). `taskOf` reads a task as
 * it is now: an event that names only a task (attachments changed) reaches a client only while
 * that task is shared with them at delivery.
 */
export function canSeeProjectEvent(
  viewer: Viewer,
  event: ProjectEvent,
  taskOf?: (taskKey: string) => Task | null | undefined,
): boolean {
  if (!isClient(viewer)) return true;
  switch (event.type) {
    case 'task_upserted':
      return canSeeTask(viewer, event.task);
    case 'task_attachments_changed': {
      const task = taskOf?.(event.taskKey);
      return task ? canSeeTask(viewer, task) : false;
    }
    case 'inbox_upserted':
      return canSeeInboxItem(viewer, event.item);
    case 'team_message':
      return canSeeTeamMessage(viewer, event.message);
    case 'config_changed':
    case 'member_changed':
      return true;
    default:
      // Live timeline events, member state, sessions, chat and plan usage are internal.
      return false;
  }
}
