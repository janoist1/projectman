import { hashKey } from '@tanstack/react-query';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
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
import {
  hasBoundOrigin,
  operatorApprovalOf,
  operatorKnowledgeApprovalOf,
  PROJECT_MANAGER_ROLE,
  withSessionWork,
} from '@projectman/shared';
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

/** The keys invalidated in the current macrotask, per client; the events of one burst read a key once. */
const invalidatedNow = new WeakMap<QueryClient, Set<string>>();

/**
 * Marks the queries of a key stale and refetches the ones on screen, once per macrotask: a second
 * invalidation would cancel the refetch that is already under way and send it again (PM-1109).
 */
function invalidateOnce(client: QueryClient, queryKey: QueryKey): void {
  const hash = hashKey(queryKey);
  let seen = invalidatedNow.get(client);
  if (!seen) {
    const fresh = new Set<string>();
    seen = fresh;
    invalidatedNow.set(client, fresh);
    setTimeout(() => invalidatedNow.delete(client), 0);
  }
  if (seen.has(hash)) return;
  seen.add(hash);
  void client.invalidateQueries({ queryKey });
}

/**
 * Whether one of the handles is a project manager of the project, by the cached member list. Without
 * a cached list it is assumed, so that nothing is left stale.
 */
function involvesManager(client: QueryClient, key: string, handles: readonly string[]): boolean {
  const members =
    client.getQueryData<BoardView>(queryKeys.board(key))?.members ??
    client.getQueryData<MemberView[]>(queryKeys.members(key));
  if (!members) return true;
  return members.some(
    (member) =>
      handles.includes(member.handle) &&
      member.kind === 'ai' &&
      member.role === PROJECT_MANAGER_ROLE &&
      !member.temp,
  );
}

/**
 * The board's inbox badge counts the viewer's open items, as the server does. Patched from the
 * cached inbox when the viewer's handle is known; otherwise the board is fetched again.
 */
export function patchOpenInboxCount(client: QueryClient, key: string, inbox: InboxView | undefined): void {
  const myHandle = client.getQueryData<Me>(queryKeys.me)?.handles[key];
  if (!inbox || !myHandle) {
    invalidateOnce(client, queryKeys.board(key));
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
  // System feedback (PM-472) is the installation's, not a project's: its screen reads it fresh.
  if (event.type === 'system_feedback_changed') return;
  const invalidate = (queryKey: QueryKey) => invalidateOnce(client, queryKey);
  if (
    'projectKey' in event &&
    event.projectKey !== undefined &&
    ['task_upserted', 'timeline_appended', 'inbox_upserted', 'member_changed', 'config_changed'].includes(
      event.type,
    )
  ) {
    invalidate(queryKeys.profiles(event.projectKey));
  }
  // A session changes its own member's profile (PM-1109); the others stay as they are.
  if (event.type === 'session_upserted') {
    invalidate(queryKeys.profile(event.projectKey, event.session.member));
  }
  // The project manager's channel state follows these (PM-434 adds no event of its own). Activity ticks and
  // plan usage are not part of it (PM-1109), and a session or a message only when the manager is in it.
  // The Operator's channel adds the Operator's steps, which an approval in the inbox settles (`inbox_upserted`).
  if ('projectKey' in event && event.projectKey !== undefined) {
    const key = event.projectKey;
    const cornerChanged =
      event.type === 'member_changed' ||
      event.type === 'pause_changed' ||
      event.type === 'config_changed' ||
      (event.type === 'session_upserted' && involvesManager(client, key, [event.session.member])) ||
      ((event.type === 'team_message' || event.type === 'team_message_updated') &&
        involvesManager(client, key, [event.message.from, ...event.message.to])) ||
      (event.type === 'inbox_upserted' &&
        Boolean(operatorApprovalOf(event.item) || operatorKnowledgeApprovalOf(event.item)));
    if (cornerChanged) invalidate(queryKeys.projectManager(key));
  }
  switch (event.type) {
    case 'task_upserted': {
      const { projectKey: key, task } = event;
      writeTask(client, key, task);
      if (task.status === 'done') invalidate(queryKeys.closedCardsAll(key));
      if (task.links.some((link) => link.kind === 'pull_request')) invalidate(queryKeys.task(key, task.key));
      return;
    }
    case 'timeline_appended': {
      const { projectKey: key, event: entry } = event;
      if (
        hasBoundOrigin(entry.actor) ||
        entry.type === 'super_handoff_changed' ||
        entry.type === 'super_operation_changed'
      ) {
        invalidate(['project', key, 'super-audit']);
        invalidate(['project', key, 'super-handoffs']);
        invalidate(['project', key, 'super-operation']);
      }
      if (entry.type === 'operator_knowledge_changed') invalidate(queryKeys.operatorKnowledge(key));
      if (entry.type === 'session_started' || entry.type === 'session_ended')
        invalidate(queryKeys.involvements(key));
      if (!entry.taskKey) return;
      client.setQueryData<TaskDetail>(queryKeys.task(key, entry.taskKey), (detail) =>
        detail ? { ...detail, timeline: appendUnique(detail.timeline, [entry]) } : detail,
      );
      // The card's rounds (PM-222) are counted by the server from the whole timeline.
      if (entry.type === 'task_stage_changed' || entry.type === 'task_labels_changed') {
        invalidate(queryKeys.task(key, entry.taskKey));
      }
      return;
    }
    case 'session_upserted': {
      const { projectKey: key, session } = event;
      client.setQueriesData<SessionDetail>({ queryKey: queryKeys.session(key, session.id) }, (detail) =>
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
    case 'documents_changed':
      // The list and the open document (every version of it, its history too): the prefix covers all.
      void client.invalidateQueries({ queryKey: queryKeys.documents(event.projectKey) });
      return;
    case 'engine_changed': {
      invalidate(queryKeys.ownerAccounts);
      // The status list of every internal member, then the owner's list (counts, hello data) where it is on screen.
      client.setQueryData<EngineStatusResponse>(queryKeys.engineStatus, (status) =>
        status ? { ...status, engines: upsertBy(status.engines, event.engine, (entry) => entry.id) } : status,
      );
      // The event does not say that an engine was revoked: the reload drops it from the status list.
      invalidate(queryKeys.engineStatus);
      invalidate(queryKeys.engines);
      // A project's engines carry `holdsProject`, which changes when the engine connects with a new hello.
      invalidate(queryKeys.projectEnginesAll);
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
      invalidate(queryKeys.instancePause);
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
      // A closed item joins the history that is on screen; an open one is not part of it.
      client.setQueryData<InboxView>(queryKeys.inboxHistory(key), (view) =>
        view
          ? {
              items:
                item.state === 'open' || item.state === 'screening'
                  ? view.items.filter((entry) => entry.id !== item.id)
                  : upsertBy(view.items, item, (entry) => entry.id),
            }
          : view,
      );
      // The Operator's trail follows a question that moves through screening (PM-561).
      if (item.kind === 'question') invalidate(queryKeys.screenedQuestionsAll(key));
      return;
    }
    case 'team_message':
    case 'team_message_updated': {
      // The feed, its unread count, the threads and the unread list all change: refetch them.
      // An updated message (a file of it deleted, PM-516) shows in the same places.
      invalidate(queryKeys.messages(event.projectKey));
      invalidate(queryKeys.operatorPreferenceMeAll(event.projectKey));
      invalidate(queryKeys.operatorPreferences(event.projectKey));
      return;
    }
    case 'feedback_changed': {
      // A mark came, was answered or decided: the list, the badge, the open mark and the cards' rows read again.
      invalidate(queryKeys.feedback(event.projectKey));
      return;
    }
    case 'project_checklist_changed': {
      invalidate(queryKeys.checklist(event.projectKey));
      return;
    }
    case 'email_changed': {
      // The channel, a contact or a mail changed: the settings section and the log read again, and the
      // member views (their `email` field) with them.
      invalidate(queryKeys.emailChannel(event.projectKey));
      invalidate(queryKeys.emailLog(event.projectKey));
      invalidate(queryKeys.members(event.projectKey));
      return;
    }
    case 'member_queue_changed': {
      // An item came, was taken or was closed: the corner shows the count (PM-894), its panel the list.
      invalidate(queryKeys.projectManager(event.projectKey));
      invalidate(queryKeys.operatorQueueAll(event.projectKey));
      return;
    }
    case 'operator_signal': {
      // A signal opened or was decided or resolved: the corner's channel carries it (PM-476).
      invalidate(queryKeys.projectManager(event.projectKey));
      return;
    }
    case 'chat_appended': {
      const { projectKey: key, sessionId, items } = event;
      client.setQueriesData<SessionDetail>({ queryKey: queryKeys.session(key, sessionId) }, (detail) =>
        detail ? { ...detail, chat: appendUnique<ChatItem>(detail.chat, items) } : detail,
      );
      return;
    }
    case 'config_changed': {
      const key = event.projectKey;
      invalidate(queryKeys.me);
      invalidate(queryKeys.roles(key));
      invalidate(queryKeys.config(key));
      invalidate(queryKeys.board(key));
      invalidate(queryKeys.members(key));
      invalidate(queryKeys.projects);
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
