import { canSeeAllTeamMessages, canSeeTask, canSeeTeamMessage, isCardLink } from '@projectman/shared';
import type {
  InboxItem,
  MemberView,
  ServerEvent,
  Session,
  Task,
  TaskDetail,
  TimelineEvent,
} from '@projectman/shared';
import type { ProjectAccess } from './access';

/**
 * What a member sees of their project. Client members (access "client") see only what is
 * shared with them; every other access level sees the whole project. The REST routes and the
 * websocket both decide here.
 *
 * Team messages are the exception to the second half (PM-78): an owner and an admin see every
 * message, every other member (a developer and a read-only member too) only what they sent or got.
 *
 * The two paths do not agree everywhere yet (an open question for the owner, kept as it was):
 * - timeline: the task detail shows a client the milestones below, while live timeline
 *   events never reach them (and label changes, e.g. "client accepted", are no milestone);
 * - member state: the board shows a client every member's status and activity, while live
 *   member_state events never reach them (member_changed snapshots do). Whatever the path, a
 *   client gets the keys of the cards they see only (`memberForViewer`); a member's activity text
 *   is not filtered (open question for the owner).
 */
export type Viewer = Pick<ProjectAccess, 'access' | 'handle'>;

export function visibleTimelineEvent(
  viewer: Viewer,
  event: TimelineEvent,
  messageParticipants: (id: string) => { from: string; to: string[] } | null,
): TimelineEvent {
  if (event.type !== 'session_started') return event;
  if (canSeeAllTeamMessages(viewer)) return event;
  const cause = event.data?.cause as { messageId?: string; quote?: string } | undefined;
  if (!cause?.quote || !cause.messageId) return event;
  const message = messageParticipants(cause.messageId);
  if (message && canSeeTeamMessage(viewer, message)) return event;
  const { quote: _quote, ...visible } = cause;
  return { ...event, data: { ...event.data, cause: visible } };
}

export function visibleSession(
  viewer: Viewer,
  session: Session,
  messageParticipants: (id: string) => { from: string; to: string[] } | null,
): Session {
  if (canSeeAllTeamMessages(viewer)) return session;
  const cause = session.startCause;
  if (!cause?.messageId || !cause.quote) return session;
  const message = messageParticipants(cause.messageId);
  if (message && canSeeTeamMessage(viewer, message)) return session;
  const { quote: _quote, ...visible } = cause;
  return { ...session, startCause: visible };
}

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

/** Team messages: an owner and an admin see all of them, everyone else only their own (the rule lives in `packages/shared`). */
export { canSeeTeamMessage };

/**
 * The member a message listing is narrowed to (sent or received) whatever else it filters by:
 * the viewer for everyone but an owner and an admin, who may see every message.
 */
export function teamMessageParticipant(viewer: Viewer): string | undefined {
  return canSeeAllTeamMessages(viewer) ? undefined : viewer.handle;
}

/**
 * A task as the viewer sees it: a client gets a task's links to other cards (relations, PM-192) and its
 * theme only when the other card is shared with them. `canSeeKey` says whether the viewer sees a card.
 */
export function withVisibleCardLinks(viewer: Viewer, task: Task, canSeeKey: (key: string) => boolean): Task {
  if (!isClient(viewer)) return task;
  // The loop mark (PM-261) and the fix round limit hold (PM-262) are the team's, as the rounds of a card
  // are: a client never sees them.
  const { loop: _loop, fixLimit: _fixLimit, ...visible } = task;
  const hideTheme = !!visible.themeKey && !canSeeKey(visible.themeKey);
  if (!hideTheme && !visible.links.some(isCardLink)) return visible;
  const { themeKey: _theme, ...shown } = visible;
  return {
    ...(hideTheme ? shown : visible),
    links: visible.links.filter((link) => !isCardLink(link) || canSeeKey(link.ref)),
  };
}

/** The tasks the viewer sees, each as they see it: a client's links to other cards lead only to cards they see. */
export function visibleTasks(viewer: Viewer, tasks: readonly Task[]): Task[] {
  const visible = tasks.filter((task) => canSeeTask(viewer, task));
  if (!isClient(viewer)) return visible;
  const keys = new Set(visible.map((task) => task.key));
  return visible.map((task) => withVisibleCardLinks(viewer, task, (key) => keys.has(key)));
}

/**
 * A member as the viewer sees them: the cards they work on or carry are only those the viewer
 * sees (a client gets no key of an internal card). The one rule for the board, the member list,
 * the profile and the live `member_changed` event; `canSeeKey` says whether the viewer sees a card.
 */
export function memberForViewer(
  viewer: Viewer,
  member: MemberView,
  canSeeKey: (key: string) => boolean,
): MemberView {
  if (!isClient(viewer)) return member;
  return {
    ...member,
    currentTaskKeys: member.currentTaskKeys.filter(canSeeKey),
    ...(member.taskWork ? { taskWork: member.taskWork.filter((work) => canSeeKey(work.taskKey)) } : {}),
  };
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
  messageParticipants: (id: string) => { from: string; to: string[] } | null = () => null,
): TaskDetail {
  const timeline = detail.timeline.map((event) => visibleTimelineEvent(viewer, event, messageParticipants));
  const sessions = detail.sessions.map((session) => visibleSession(viewer, session, messageParticipants));
  if (
    timeline.some((event, index) => event !== detail.timeline[index]) ||
    sessions.some((session, index) => session !== detail.sessions[index])
  )
    detail = { ...detail, timeline, sessions };
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
  messageParticipants: (id: string) => { from: string; to: string[] } | null = () => null,
): ProjectEvent {
  if (event.type === 'timeline_appended')
    return { ...event, event: visibleTimelineEvent(viewer, event.event, messageParticipants) };
  if (event.type === 'session_upserted')
    return { ...event, session: visibleSession(viewer, event.session, messageParticipants) };
  if (!isClient(viewer)) return event;
  const canSeeKey = (key: string) => {
    const other = taskOf(key);
    return !!other && canSeeTask(viewer, other);
  };
  if (event.type === 'member_changed' && event.member)
    return { ...event, member: memberForViewer(viewer, event.member, canSeeKey) };
  if (event.type !== 'task_upserted') return event;
  return { ...event, task: withVisibleCardLinks(viewer, event.task, canSeeKey) };
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
  // A team message reaches only those it concerns (and an owner and an admin), whatever their access.
  if (event.type === 'team_message') return canSeeTeamMessage(viewer, event.message);
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
    case 'config_changed':
    case 'member_changed':
      return true;
    default:
      // Live timeline events, member state, sessions, chat and plan usage are internal.
      return false;
  }
}
