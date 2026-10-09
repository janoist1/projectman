import type { QueryClient } from '@tanstack/react-query';
import type {
  BoardView,
  ChatItem,
  EngineStatusResponse,
  InboxView,
  Me,
  MemberProfile,
  MemberView,
  ServerEvent,
  Session,
  SessionDetail,
  Task,
  TaskDetail,
} from '@projectman/shared';
import { withSessionWork } from '@projectman/shared';
import { openItemsFor } from '../lib/inbox';
import { ApiError } from './client';
import { queryKeys } from './queryKeys';

/** Replaces the item with the same id, or appends it. Returns the same array when unchanged. */
export function upsertBy<T>(list: readonly T[], item: T, id: (value: T) => string): T[] {
  const key = id(item);
  const index = list.findIndex((entry) => id(entry) === key);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

/** Appends items whose id is not present yet. */
export function appendUnique<T extends { id: string }>(list: readonly T[], items: readonly T[]): T[] {
  const seen = new Set(list.map((entry) => entry.id));
  const fresh = items.filter((item) => !seen.has(item.id));
  return fresh.length === 0 ? (list as T[]) : [...list, ...fresh];
}

/**
 * The board's inbox badge counts the viewer's open items, as the server does. Patched from the
 * cached inbox when the viewer's handle is known; otherwise the board is fetched again.
 */
export function patchOpenInboxCount(client: QueryClient, key: string, inbox: InboxView | undefined): void {
  const myHandle = client.getQueryData<Me>(queryKeys.me)?.handles[key];
  if (!inbox || !myHandle) {
    void client.invalidateQueries({ queryKey: queryKeys.board(key) });
    return;
  }
  client.setQueryData<BoardView>(queryKeys.board(key), (board) =>
    board ? { ...board, openInboxCount: openItemsFor(inbox.items, myHandle).length } : board,
  );
}

function patchMembers(
  members: readonly MemberView[],
  handle: string,
  patch: Pick<MemberView, 'status' | 'activity'>,
): MemberView[] {
  return members.map((member) => (member.handle === handle ? { ...member, ...patch } : member));
}

/** The member's work on cards follows the session that changed (PM-207). */
function patchMemberWork(members: readonly MemberView[], session: Session): MemberView[] {
  return members.map((member) =>
    member.handle === session.member
      ? { ...member, taskWork: withSessionWork(member.taskWork ?? [], session) }
      : member,
  );
}

/** A changed task: on the board, in its detail and in the sessions that work on it. */
export function writeTask(client: QueryClient, key: string, task: Task): void {
  client.setQueryData<BoardView>(queryKeys.board(key), (board) =>
    board ? { ...board, tasks: upsertBy(board.tasks, task, (entry) => entry.key) } : board,
  );
  client.setQueryData<TaskDetail>(queryKeys.task(key, task.key), (detail) =>
    detail ? { ...detail, task } : detail,
  );
  client.setQueriesData<SessionDetail>({ queryKey: queryKeys.sessionDetails(key) }, (detail) =>
    detail && detail.task?.key === task.key ? { ...detail, task } : detail,
  );
}

/** A task detail the server returned from a mutation (labels, comments). */
export function writeTaskDetail(client: QueryClient, key: string, detail: TaskDetail): void {
  writeTask(client, key, detail.task);
  client.setQueryData<TaskDetail>(queryKeys.task(key, detail.task.key), detail);
}

/**
 * A task's attachments changed: read the list again, and the task detail too, because the
 * change is on the timeline (which a client sees as well).
 */
export function invalidateAttachments(client: QueryClient, key: string, taskKey: string): void {
  void client.invalidateQueries({ queryKey: queryKeys.attachments(key, taskKey) });
  void client.invalidateQueries({ queryKey: queryKeys.task(key, taskKey) });
}

/**
 * Applies a websocket event to the query cache so every screen updates live. Events for
 * data that is not in the cache are ignored; it is fetched fresh when a screen needs it.
 */
export function applyServerEvent(client: QueryClient, event: ServerEvent): void {
  if (
    'projectKey' in event &&
    [
      'task_upserted',
      'timeline_appended',
      'session_upserted',
      'inbox_upserted',
      'member_changed',
      'config_changed',
    ].includes(event.type)
  ) {
    void client.invalidateQueries({ queryKey: queryKeys.profiles(event.projectKey) });
  }
  switch (event.type) {
    case 'task_upserted': {
      const { projectKey: key, task } = event;
      // Who may see the files follows the task's visibility: read the list again when it changes.
      const before = client.getQueryData<TaskDetail>(queryKeys.task(key, task.key))?.task;
      if (before && before.visibility !== task.visibility) {
        void client.invalidateQueries({ queryKey: queryKeys.attachments(key, task.key) });
      }
      writeTask(client, key, task);
      if (task.status === 'done') void client.invalidateQueries({ queryKey: queryKeys.closedCardsAll(key) });
      if (task.links.some((link) => link.kind === 'pull_request')) {
        void client.invalidateQueries({ queryKey: queryKeys.task(key, task.key) });
      }
      return;
    }
    case 'timeline_appended': {
      const { projectKey: key, event: entry } = event;
      if (entry.type === 'session_started' || entry.type === 'session_ended')
        void client.invalidateQueries({ queryKey: ['involvements', key] });
      if (!entry.taskKey) return;
      client.setQueryData<TaskDetail>(queryKeys.task(key, entry.taskKey), (detail) =>
        detail ? { ...detail, timeline: appendUnique(detail.timeline, [entry]) } : detail,
      );
      // The card's rounds (PM-222) are counted by the server from the whole timeline.
      if (entry.type === 'task_stage_changed' || entry.type === 'task_labels_changed') {
        void client.invalidateQueries({ queryKey: queryKeys.task(key, entry.taskKey) });
      }
      return;
    }
    case 'session_upserted': {
      const { projectKey: key, session } = event;
      client.setQueryData<SessionDetail>(queryKeys.session(key, session.id), (detail) =>
        detail ? { ...detail, session } : detail,
      );
      client.setQueryData<BoardView>(queryKeys.board(key), (board) =>
        board ? { ...board, members: patchMemberWork(board.members, session) } : board,
      );
      client.setQueryData<MemberView[]>(queryKeys.members(key), (members) =>
        members ? patchMemberWork(members, session) : members,
      );
      if (session.workItem.type === 'task') {
        client.setQueryData<TaskDetail>(queryKeys.task(key, session.workItem.taskKey), (detail) =>
          detail ? { ...detail, sessions: upsertBy(detail.sessions, session, (entry) => entry.id) } : detail,
        );
      }
      return;
    }
    case 'task_attachments_changed':
      invalidateAttachments(client, event.projectKey, event.taskKey);
      return;
    case 'engine_changed': {
      // The status list of every internal member, then the owner's list (counts, hello data) where it is on screen.
      client.setQueryData<EngineStatusResponse>(queryKeys.engineStatus, (status) =>
        status ? { ...status, engines: upsertBy(status.engines, event.engine, (entry) => entry.id) } : status,
      );
      // The event does not say that an engine was revoked: the reload drops it from the status list.
      void client.invalidateQueries({ queryKey: queryKeys.engineStatus });
      void client.invalidateQueries({ queryKey: queryKeys.engines });
      // What failed because the engine was away (a machine view, a session's chat) loads again at connect.
      if (event.engine.online)
        void client.invalidateQueries({
          predicate: (query) =>
            query.state.status === 'error' &&
            query.state.error instanceof ApiError &&
            query.state.error.code === 'engine_offline',
        });
      return;
    }
    case 'plan_usage': {
      const { projectKey: key, provider, usage } = event;
      client.setQueryData<BoardView>(queryKeys.board(key), (board) =>
        board
          ? {
              ...board,
              planUsage: provider === 'claude' ? usage : board.planUsage,
              planUsageByProvider: { ...board.planUsageByProvider, [provider]: usage },
            }
          : board,
      );
      return;
    }
    case 'pause_changed': {
      const { projectKey: key, pause } = event;
      client.setQueryData<BoardView>(queryKeys.board(key), (board) => (board ? { ...board, pause } : board));
      // The instance's pause view is read again only where it is on screen (the right to resume comes with it).
      void client.invalidateQueries({ queryKey: queryKeys.instancePause });
      return;
    }
    case 'member_changed': {
      const { projectKey: key, handle, member } = event;
      const change = (members: readonly MemberView[]) =>
        member
          ? upsertBy(members, member, (entry) => entry.handle)
          : members.filter((entry) => entry.handle !== handle);
      client.setQueryData<BoardView>(queryKeys.board(key), (board) =>
        board ? { ...board, members: change(board.members) } : board,
      );
      client.setQueryData<MemberView[]>(queryKeys.members(key), (members) =>
        members ? change(members) : members,
      );
      void client.invalidateQueries({ queryKey: queryKeys.me });
      return;
    }
    case 'member_state': {
      const { projectKey: key, handle, status, activity } = event;
      client.setQueryData<BoardView>(queryKeys.board(key), (board) =>
        board ? { ...board, members: patchMembers(board.members, handle, { status, activity }) } : board,
      );
      client.setQueryData<MemberView[]>(queryKeys.members(key), (members) =>
        members ? patchMembers(members, handle, { status, activity }) : members,
      );
      // Activity ticks often: patch the member's profile instead of refetching every profile.
      client.setQueryData<MemberProfile>(queryKeys.profile(key, handle), (profile) =>
        profile ? { ...profile, member: { ...profile.member, status, activity } } : profile,
      );
      return;
    }
    case 'inbox_upserted': {
      const { projectKey: key, item } = event;
      const inbox = client.setQueryData<InboxView>(queryKeys.inbox(key), (view) =>
        view ? { items: upsertBy(view.items, item, (entry) => entry.id) } : view,
      );
      patchOpenInboxCount(client, key, inbox);
      return;
    }
    case 'team_message': {
      // The feed, its unread count, the threads and the unread list all change: refetch them.
      void client.invalidateQueries({ queryKey: queryKeys.messages(event.projectKey) });
      return;
    }
    case 'chat_appended': {
      const { projectKey: key, sessionId, items } = event;
      client.setQueryData<SessionDetail>(queryKeys.session(key, sessionId), (detail) =>
        detail ? { ...detail, chat: appendUnique<ChatItem>(detail.chat, items) } : detail,
      );
      return;
    }
    case 'config_changed': {
      const key = event.projectKey;
      void client.invalidateQueries({ queryKey: queryKeys.me });
      void client.invalidateQueries({ queryKey: queryKeys.roles(key) });
      void client.invalidateQueries({ queryKey: queryKeys.config(key) });
      void client.invalidateQueries({ queryKey: queryKeys.board(key) });
      void client.invalidateQueries({ queryKey: queryKeys.members(key) });
      void client.invalidateQueries({ queryKey: queryKeys.projects });
      return;
    }
    case 'error':
      console.warn('[ws] server error:', event.message);
      return;
    case 'hello':
    case 'terminal_data':
    case 'terminal_snapshot':
      return;
  }
}
