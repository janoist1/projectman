import type { QueryClient } from '@tanstack/react-query';
import type {
  BoardView,
  ChatItem,
  InboxView,
  Me,
  MemberView,
  ServerEvent,
  SessionDetail,
  TaskDetail,
  TeamMessagesView,
} from '@projectman/shared';
import { openItemsFor } from '../lib/inbox';
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
      'member_state',
      'config_changed',
    ].includes(event.type)
  ) {
    void client.invalidateQueries({ queryKey: queryKeys.profiles(event.projectKey) });
  }
  switch (event.type) {
    case 'task_upserted': {
      const { projectKey: key, task } = event;
      client.setQueryData<BoardView>(queryKeys.board(key), (board) =>
        board ? { ...board, tasks: upsertBy(board.tasks, task, (entry) => entry.key) } : board,
      );
      client.setQueryData<TaskDetail>(queryKeys.task(key, task.key), (detail) =>
        detail ? { ...detail, task } : detail,
      );
      if (task.links.some((link) => link.kind === 'pull_request')) {
        void client.invalidateQueries({ queryKey: queryKeys.task(key, task.key) });
      }
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
      const { projectKey: key, message } = event;
      void client.invalidateQueries({ queryKey: queryKeys.messages(key) });
      client.setQueryData<TeamMessagesView>(queryKeys.messages(key), (view) =>
        view ? { ...view, messages: upsertBy(view.messages, message, (entry) => entry.id) } : view,
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
