import type { QueryClient } from '@tanstack/react-query';
import type {
  BoardView,
  ChatItem,
  InboxItem,
  InboxView,
  MemberView,
  ServerEvent,
  SessionDetail,
  TaskDetail,
  TeamMessagesView,
} from '@projectman/shared';
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

export function countOpenInbox(items: readonly InboxItem[], handle: string | null): number {
  return items.filter((item) => item.state === 'open' && (!handle || item.assignees.includes(handle))).length;
}

function patchMembers(
  members: readonly MemberView[],
  handle: string,
  patch: Pick<MemberView, 'status' | 'activity'>,
): MemberView[] {
  return members.map((member) => (member.handle === handle ? { ...member, ...patch } : member));
}

/**
 * Applies a websocket event to the query cache so every screen updates live. Events for
 * data that is not in the cache are ignored; it is fetched fresh when a screen needs it.
 */
export function applyServerEvent(client: QueryClient, event: ServerEvent): void {
  switch (event.type) {
    case 'task_upserted': {
      const { projectKey: key, task } = event;
      client.setQueryData<BoardView>(queryKeys.board(key), (board) =>
        board ? { ...board, tasks: upsertBy(board.tasks, task, (entry) => entry.key) } : board,
      );
      client.setQueryData<TaskDetail>(queryKeys.task(key, task.key), (detail) =>
        detail ? { ...detail, task } : detail,
      );
      client.setQueriesData<SessionDetail>({ queryKey: queryKeys.sessions(key) }, (detail) =>
        detail && detail.task?.key === task.key ? { ...detail, task } : detail,
      );
      return;
    }
    case 'timeline_appended': {
      const { projectKey: key, event: entry } = event;
      if (!entry.taskKey) return;
      client.setQueryData<TaskDetail>(queryKeys.task(key, entry.taskKey), (detail) =>
        detail ? { ...detail, timeline: appendUnique(detail.timeline, [entry]) } : detail,
      );
      return;
    }
    case 'session_upserted': {
      const { projectKey: key, session } = event;
      client.setQueryData<SessionDetail>(queryKeys.session(key, session.id), (detail) =>
        detail ? { ...detail, session } : detail,
      );
      if (session.workItem.type === 'task') {
        client.setQueryData<TaskDetail>(queryKeys.task(key, session.workItem.taskKey), (detail) =>
          detail ? { ...detail, sessions: upsertBy(detail.sessions, session, (entry) => entry.id) } : detail,
        );
      }
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
      return;
    }
    case 'inbox_upserted': {
      const { projectKey: key, item } = event;
      const inbox = client.setQueryData<InboxView>(queryKeys.inbox(key), (view) =>
        view ? { items: upsertBy(view.items, item, (entry) => entry.id) } : view,
      );
      if (inbox) {
        client.setQueryData<BoardView>(queryKeys.board(key), (board) =>
          board ? { ...board, openInboxCount: countOpenInbox(inbox.items, null) } : board,
        );
      } else {
        void client.invalidateQueries({ queryKey: queryKeys.board(key) });
      }
      return;
    }
    case 'team_message': {
      const { projectKey: key, message } = event;
      client.setQueryData<TeamMessagesView>(queryKeys.messages(key), (view) =>
        view ? { messages: upsertBy(view.messages, message, (entry) => entry.id) } : view,
      );
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
