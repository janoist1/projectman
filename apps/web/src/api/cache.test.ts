import { QueryClient } from '@tanstack/react-query';
import type {
  BoardView,
  InboxView,
  Me,
  MemberProfile,
  MemberView,
  SessionDetail,
  TaskDetail,
} from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import {
  chats,
  inbox,
  members,
  mockUser,
  planUsage,
  projectSummary,
  sessions,
  tasks,
  timeline,
} from '../mocks/fixtures';
import { MockBackend } from '../mocks/backend';
import { appendUnique, applyServerEvent, upsertBy, writeTaskDetail } from './cache';
import { queryKeys } from './queryKeys';

const KEY = 'AC';

function seed(): QueryClient {
  const client = new QueryClient();
  const board: BoardView = {
    project: projectSummary,
    columns: [],
    stages: [],
    labels: [],
    tasks: structuredClone(tasks),
    members: structuredClone(members),
    openInboxCount: 0,
    planUsage,
    planUsageByProvider: { claude: planUsage },
  };
  client.setQueryData(queryKeys.board(KEY), board);
  client.setQueryData<InboxView>(queryKeys.inbox(KEY), { items: structuredClone(inbox) });
  client.setQueryData<MemberView[]>(queryKeys.members(KEY), structuredClone(members));
  const session = sessions.find((entry) => entry.id === 'ses_ac21_fe1')!;
  client.setQueryData<SessionDetail>(queryKeys.session(KEY, session.id), {
    session,
    chat: structuredClone(chats[session.id] ?? []),
    task: tasks.find((task) => task.key === 'AC-21')!,
  });
  client.setQueryData<TaskDetail>(queryKeys.task(KEY, 'AC-21'), {
    pullRequests: [],
    task: tasks.find((task) => task.key === 'AC-21')!,
    timeline: timeline.filter((event) => event.taskKey === 'AC-21'),
    sessions: sessions.filter(
      (entry) => entry.workItem.type === 'task' && entry.workItem.taskKey === 'AC-21',
    ),
  });
  return client;
}

describe('cache helpers', () => {
  it('upserts by id and appends unique items', () => {
    expect(upsertBy([{ id: 'a', v: 1 }], { id: 'a', v: 2 }, (item) => item.id)).toEqual([{ id: 'a', v: 2 }]);
    expect(upsertBy([{ id: 'a', v: 1 }], { id: 'b', v: 2 }, (item) => item.id)).toHaveLength(2);
    const list = [{ id: 'a' }];
    expect(appendUnique(list, [{ id: 'a' }])).toBe(list);
    expect(appendUnique(list, [{ id: 'a' }, { id: 'b' }])).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});

describe('applyServerEvent', () => {
  it('updates a task on the board, in its detail and in its sessions', () => {
    const client = seed();
    const task = { ...tasks.find((entry) => entry.key === 'AC-21')!, stageId: 'code_review' };
    applyServerEvent(client, { type: 'task_upserted', projectKey: KEY, task });
    expect(
      client.getQueryData<BoardView>(queryKeys.board(KEY))!.tasks.find((entry) => entry.key === 'AC-21')!
        .stageId,
    ).toBe('code_review');
    expect(client.getQueryData<TaskDetail>(queryKeys.task(KEY, 'AC-21'))!.task.stageId).toBe('code_review');
    expect(client.getQueryData<SessionDetail>(queryKeys.session(KEY, 'ses_ac21_fe1'))!.task!.stageId).toBe(
      'code_review',
    );
  });

  it('appends chat items once', () => {
    const client = seed();
    const item = {
      id: 'new-1',
      ts: new Date().toISOString(),
      kind: 'assistant_text' as const,
      text: 'Kész.',
    };
    applyServerEvent(client, {
      type: 'chat_appended',
      projectKey: KEY,
      sessionId: 'ses_ac21_fe1',
      items: [item],
    });
    applyServerEvent(client, {
      type: 'chat_appended',
      projectKey: KEY,
      sessionId: 'ses_ac21_fe1',
      items: [item],
    });
    const chat = client.getQueryData<SessionDetail>(queryKeys.session(KEY, 'ses_ac21_fe1'))!.chat;
    expect(chat.filter((entry) => entry.id === 'new-1')).toHaveLength(1);
  });

  it("keeps the inbox and the board's count of the viewer's open items in sync", () => {
    const client = seed();
    client.setQueryData<Me>(queryKeys.me, { ...mockUser, handles: { [KEY]: 'owner' }, projects: [] });
    const item = { ...inbox.find((entry) => entry.id === 'inb_perm_push')!, state: 'resolved' as const };
    applyServerEvent(client, { type: 'inbox_upserted', projectKey: KEY, item });
    const items = client.getQueryData<InboxView>(queryKeys.inbox(KEY))!.items;
    expect(items.find((entry) => entry.id === 'inb_perm_push')!.state).toBe('resolved');
    const mine = items.filter((entry) => entry.state === 'open' && entry.assignees.includes('owner'));
    // Another member's open question does not count for the viewer, as on the server.
    expect(items.some((entry) => entry.state === 'open' && !entry.assignees.includes('owner'))).toBe(true);
    expect(client.getQueryData<BoardView>(queryKeys.board(KEY))!.openInboxCount).toBe(mine.length);
    expect(client.getQueryState(queryKeys.board(KEY))!.isInvalidated).toBe(false);
  });

  it('refetches the board count when the viewer is unknown', () => {
    const client = seed();
    const item = { ...inbox.find((entry) => entry.id === 'inb_perm_push')!, state: 'resolved' as const };
    applyServerEvent(client, { type: 'inbox_upserted', projectKey: KEY, item });
    expect(client.getQueryState(queryKeys.board(KEY))!.isInvalidated).toBe(true);
  });

  it('updates member state everywhere', () => {
    const client = seed();
    applyServerEvent(client, {
      type: 'member_state',
      projectKey: KEY,
      handle: 'qa',
      status: 'idle',
      activity: null,
    });
    expect(
      client.getQueryData<BoardView>(queryKeys.board(KEY))!.members.find((m) => m.handle === 'qa'),
    ).toMatchObject({ status: 'idle', activity: null });
    expect(
      client.getQueryData<MemberView[]>(queryKeys.members(KEY))!.find((m) => m.handle === 'qa')!.status,
    ).toBe('idle');
  });

  it("patches the member's profile on activity ticks instead of refetching every profile", () => {
    const client = seed();
    const profile = new MockBackend().handle('GET', `/api/projects/${KEY}/members/qa/profile`, undefined)
      .body as MemberProfile;
    client.setQueryData(queryKeys.profile(KEY, 'qa'), profile);
    client.setQueryData(queryKeys.profile(KEY, 'fe-1'), { ...profile, member: { ...profile.member } });
    applyServerEvent(client, {
      type: 'member_state',
      projectKey: KEY,
      handle: 'qa',
      status: 'working',
      activity: 'Fictional check',
    });
    expect(client.getQueryData<MemberProfile>(queryKeys.profile(KEY, 'qa'))!.member).toMatchObject({
      status: 'working',
      activity: 'Fictional check',
    });
    expect(client.getQueryState(queryKeys.profile(KEY, 'qa'))!.isInvalidated).toBe(false);
    expect(client.getQueryState(queryKeys.profile(KEY, 'fe-1'))!.isInvalidated).toBe(false);
  });

  it('refetches the message feed, threads and unread list on a team message', () => {
    const client = seed();
    const view = { messages: [], unreadCount: 0 };
    client.setQueryData(queryKeys.messages(KEY), view);
    client.setQueryData(queryKeys.messageThread(KEY, 'qa'), view);
    client.setQueryData(queryKeys.unreadMessages(KEY), view);
    const message = new MockBackend().messages[0]!;
    applyServerEvent(client, { type: 'team_message', projectKey: KEY, message });
    for (const key of [
      queryKeys.messages(KEY),
      queryKeys.messageThread(KEY, 'qa'),
      queryKeys.unreadMessages(KEY),
    ])
      expect(client.getQueryState(key)!.isInvalidated).toBe(true);
  });

  it('writes a task detail returned by a mutation to the board, the detail and its sessions', () => {
    const client = seed();
    const detail = client.getQueryData<TaskDetail>(queryKeys.task(KEY, 'AC-21'))!;
    const task = { ...detail.task, labels: [...detail.task.labels, 'fictional-tag'] };
    writeTaskDetail(client, KEY, { ...detail, task, timeline: [] });
    expect(
      client.getQueryData<BoardView>(queryKeys.board(KEY))!.tasks.find((entry) => entry.key === 'AC-21')!
        .labels,
    ).toContain('fictional-tag');
    expect(client.getQueryData<TaskDetail>(queryKeys.task(KEY, 'AC-21'))).toMatchObject({
      task,
      timeline: [],
    });
    expect(client.getQueryData<SessionDetail>(queryKeys.session(KEY, 'ses_ac21_fe1'))!.task).toEqual(task);
    expect(client.getQueryState(queryKeys.board(KEY))!.isInvalidated).toBe(false);
  });

  it('appends timeline events and upserts sessions of the task', () => {
    const client = seed();
    const event = { ...timeline[0]!, id: 'evt_new', taskKey: 'AC-21' };
    applyServerEvent(client, { type: 'timeline_appended', projectKey: KEY, event });
    const session = { ...sessions.find((entry) => entry.id === 'ses_ac21_fe1')!, state: 'working' as const };
    applyServerEvent(client, { type: 'session_upserted', projectKey: KEY, session });
    const detail = client.getQueryData<TaskDetail>(queryKeys.task(KEY, 'AC-21'))!;
    expect(detail.timeline.at(-1)!.id).toBe('evt_new');
    expect(detail.sessions.find((entry) => entry.id === 'ses_ac21_fe1')!.state).toBe('working');
    expect(client.getQueryData<SessionDetail>(queryKeys.session(KEY, 'ses_ac21_fe1'))!.session.state).toBe(
      'working',
    );
  });

  it('keeps the member work on cards in step with the sessions (PM-207)', () => {
    const client = seed();
    const workOf = () =>
      client.getQueryData<BoardView>(queryKeys.board(KEY))!.members.find((m) => m.handle === 'be-1')!
        .taskWork;
    const session = sessions.find((entry) => entry.id === 'ses_ac20_be1')!;
    applyServerEvent(client, {
      type: 'session_upserted',
      projectKey: KEY,
      session: { ...session, state: 'working', activity: 'Bash: ls', stateSince: '2026-10-01T10:00:00.000Z' },
    });
    expect(workOf()).toEqual([
      {
        sessionId: 'ses_ac20_be1',
        taskKey: 'AC-20',
        activity: 'Bash: ls',
        since: '2026-10-01T10:00:00.000Z',
      },
    ]);
    applyServerEvent(client, {
      type: 'session_upserted',
      projectKey: KEY,
      session: { ...session, state: 'idle' },
    });
    expect(workOf()).toEqual([]);
  });

  it('refetches configuration-dependent data when the config changes', () => {
    const client = seed();
    applyServerEvent(client, { type: 'config_changed', projectKey: KEY, version: 'abc1234' });
    expect(client.getQueryState(queryKeys.board(KEY))!.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.members(KEY))!.isInvalidated).toBe(true);
  });
});

describe('contract follow-up events', () => {
  it('keeps provider usage separate and preserves the legacy Claude value', () => {
    const client = seed();
    const codex = { ...planUsage, fiveHourPercent: 23 };
    applyServerEvent(client, { type: 'plan_usage', projectKey: KEY, provider: 'codex', usage: codex });
    expect(client.getQueryData<BoardView>(queryKeys.board(KEY))).toMatchObject({
      planUsage,
      planUsageByProvider: { claude: planUsage, codex },
    });
    applyServerEvent(client, { type: 'plan_usage', projectKey: KEY, provider: 'claude', usage: null });
    expect(client.getQueryData<BoardView>(queryKeys.board(KEY))).toMatchObject({
      planUsage: null,
      planUsageByProvider: { claude: null, codex },
    });
  });

  it('adds, updates and removes members in board and roster caches', () => {
    const client = seed();
    const member: MemberView = {
      ...members.find((m) => m.kind === 'ai')!,
      handle: 'fictional-ai',
      model: 'fictional-model',
    };
    applyServerEvent(client, { type: 'member_changed', projectKey: KEY, handle: member.handle, member });
    const updated = { ...member, model: 'fictional-new-model' };
    applyServerEvent(client, {
      type: 'member_changed',
      projectKey: KEY,
      handle: member.handle,
      member: updated,
    });
    expect(
      client.getQueryData<BoardView>(queryKeys.board(KEY))!.members.find((m) => m.handle === member.handle),
    ).toEqual(updated);
    expect(
      client.getQueryData<MemberView[]>(queryKeys.members(KEY))!.filter((m) => m.handle === member.handle),
    ).toEqual([updated]);
    applyServerEvent(client, {
      type: 'member_changed',
      projectKey: KEY,
      handle: member.handle,
      member: null,
    });
    expect(
      client.getQueryData<BoardView>(queryKeys.board(KEY))!.members.some((m) => m.handle === member.handle),
    ).toBe(false);
    expect(
      client.getQueryData<MemberView[]>(queryKeys.members(KEY))!.some((m) => m.handle === member.handle),
    ).toBe(false);
  });

  it('reads the attachment list and the task detail again when the attachments change', () => {
    const client = seed();
    client.setQueryData(queryKeys.attachments(KEY, 'AC-21'), { attachments: [] });
    client.setQueryData(queryKeys.attachments(KEY, 'AC-20'), { attachments: [] });
    applyServerEvent(client, { type: 'task_attachments_changed', projectKey: KEY, taskKey: 'AC-21' });
    expect(client.getQueryState(queryKeys.attachments(KEY, 'AC-21'))!.isInvalidated).toBe(true);
    // The timeline of the task shows the change.
    expect(client.getQueryState(queryKeys.task(KEY, 'AC-21'))!.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.attachments(KEY, 'AC-20'))!.isInvalidated).toBe(false);
  });

  it('keeps the attachment list of a task apart from the task detail queries', () => {
    expect(queryKeys.attachments(KEY, 'AC-21').slice(0, 3)).not.toEqual(queryKeys.taskDetails(KEY));
  });

  it('reads the attachment list again when the visibility of its task changes, and only then', () => {
    const client = seed();
    client.setQueryData(queryKeys.attachments(KEY, 'AC-21'), { attachments: [] });
    const task = tasks.find((entry) => entry.key === 'AC-21')!;
    applyServerEvent(client, {
      type: 'task_upserted',
      projectKey: KEY,
      task: { ...task, title: 'New title' },
    });
    expect(client.getQueryState(queryKeys.attachments(KEY, 'AC-21'))!.isInvalidated).toBe(false);
    applyServerEvent(client, {
      type: 'task_upserted',
      projectKey: KEY,
      task: { ...task, visibility: task.visibility === 'shared' ? 'internal' : 'shared' },
    });
    expect(client.getQueryState(queryKeys.attachments(KEY, 'AC-21'))!.isInvalidated).toBe(true);
  });

  it('refreshes PR details when a linked task is published', () => {
    const client = seed();
    const task = {
      ...tasks.find((entry) => entry.key === 'AC-21')!,
      links: [{ kind: 'pull_request' as const, repo: 'acme/web', ref: '7' }],
    };
    applyServerEvent(client, { type: 'task_upserted', projectKey: KEY, task });
    expect(client.getQueryState(queryKeys.task(KEY, task.key))!.isInvalidated).toBe(true);
  });
});
