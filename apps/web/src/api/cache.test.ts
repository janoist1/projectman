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
import { describe, expect, it, vi } from 'vitest';
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
it('refreshes super DTOs when their timeline changes without executing an operation', () => {
  const client = new QueryClient();
  const keys = [
    ['project', KEY, 'super-audit'],
    ['project', KEY, 'super-handoffs'],
    ['project', KEY, 'super-operation', 'op'],
  ];
  for (const queryKey of keys) client.setQueryData(queryKey, { fixture: true });
  applyServerEvent(client, {
    type: 'timeline_appended',
    projectKey: KEY,
    event: {
      id: 'changed',
      projectKey: KEY,
      taskKey: null,
      sessionId: null,
      actor: { kind: 'ai', handle: 'operator' },
      type: 'super_handoff_changed',
      data: { handoffId: 'h', state: 'pending' },
      createdAt: new Date().toISOString(),
    },
  });
  expect(keys.every((queryKey) => client.getQueryState(queryKey)?.isInvalidated)).toBe(true);
});

function seed(): QueryClient {
  const client = new QueryClient();
  const board: BoardView = {
    aiEnabled: true,
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
    client.setQueryData<Me>(queryKeys.me, {
      ...mockUser,
      language: 'hu',
      instanceOwner: true,
      handles: { [KEY]: 'owner' },
      projects: [],
    });
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

  it('reads the status lines again when a message changes its processing, the comments only for a card (PM-1305)', () => {
    const client = seed();
    client.setQueryData(queryKeys.messages(KEY), { messages: [], unreadCount: 0 });
    client.setQueryData(queryKeys.taskComments(KEY, 'AC-20'), { threads: [] });
    client.setQueryData(queryKeys.taskComments(KEY, 'AC-21'), { threads: [] });
    applyServerEvent(client, {
      type: 'message_processing_changed',
      projectKey: KEY,
      messageId: 'msg_1',
      taskKey: null,
      from: 'owner',
    });
    expect(client.getQueryState(queryKeys.messages(KEY))!.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.taskComments(KEY, 'AC-20'))!.isInvalidated).toBe(false);
    applyServerEvent(client, {
      type: 'message_processing_changed',
      projectKey: KEY,
      messageId: 'msg_2',
      taskKey: 'AC-20',
      from: 'owner',
    });
    expect(client.getQueryState(queryKeys.taskComments(KEY, 'AC-20'))!.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.taskComments(KEY, 'AC-21'))!.isInvalidated).toBe(false);
  });

  it('leaves the project manager corner alone for the ticks and messages of other members (PM-1109)', () => {
    const client = seed();
    const corner = queryKeys.projectManager(KEY);
    client.setQueryData(corner, {});
    const session = sessions.find((entry) => entry.id === 'ses_ac21_fe1')!;
    for (let tick = 0; tick < 50; tick++) {
      applyServerEvent(client, {
        type: 'member_state',
        projectKey: KEY,
        handle: 'fe-1',
        status: 'working',
        activity: `Tick ${tick}`,
      });
      applyServerEvent(client, { type: 'session_upserted', projectKey: KEY, session });
    }
    applyServerEvent(client, { type: 'plan_usage', projectKey: KEY, provider: 'claude', usage: planUsage });
    const message = { ...new MockBackend().messages[0]!, from: 'fe-1', to: ['qa'] };
    applyServerEvent(client, { type: 'team_message', projectKey: KEY, message });
    expect(client.getQueryState(corner)!.isInvalidated).toBe(false);
  });

  it('reads the project manager corner again for the manager own session and messages', () => {
    const message = { ...new MockBackend().messages[0]!, from: 'fe-1', to: ['pm'] };
    const session = { ...sessions.find((entry) => entry.id === 'ses_ac21_fe1')!, member: 'pm' };
    for (const event of [
      { type: 'team_message', projectKey: KEY, message },
      { type: 'session_upserted', projectKey: KEY, session },
    ] as const) {
      const client = seed();
      client.setQueryData(queryKeys.projectManager(KEY), {});
      applyServerEvent(client, event);
      expect(client.getQueryState(queryKeys.projectManager(KEY))!.isInvalidated).toBe(true);
    }
  });

  it('reads a key once for the events of one burst (PM-1109)', () => {
    const client = seed();
    client.setQueryData(queryKeys.screenedQuestionsAll(KEY), {});
    const read = vi.spyOn(client, 'invalidateQueries');
    const question = inbox.find((item) => item.kind === 'question')!;
    applyServerEvent(client, { type: 'inbox_upserted', projectKey: KEY, item: question });
    applyServerEvent(client, { type: 'inbox_upserted', projectKey: KEY, item: question });
    const screened = read.mock.calls.filter(([filters]) =>
      JSON.stringify(filters?.queryKey).includes('inbox-screened'),
    );
    expect(screened).toHaveLength(1);
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

  it('starts the settings history again from its first page when the config changes', () => {
    const client = seed();
    const page = (offset: number) => ({ entries: [], total: 60 + offset });
    client.setQueryData(queryKeys.configHistory(KEY), { pages: [page(0), page(5)], pageParams: [0, 5] });
    applyServerEvent(client, { type: 'config_changed', projectKey: KEY, version: 'abc1234' });
    expect(client.getQueryData<{ pages: unknown[] }>(queryKeys.configHistory(KEY))!.pages).toEqual([page(0)]);
    expect(client.getQueryState(queryKeys.configHistory(KEY))!.isInvalidated).toBe(true);
  });
});

describe('the work queue events', () => {
  const pm = 'member:operator';
  const seed = (client: QueryClient) => {
    const keys = [
      queryKeys.projectManager(KEY),
      queryKeys.workQueues(KEY),
      queryKeys.workQueue(KEY, pm, '2026-10-22T00:00:00.000Z'),
    ];
    keys.forEach((key) => client.setQueryData(key, {}));
    return keys;
  };

  it('reads the queue views and the corner when a member queue changes', () => {
    const client = new QueryClient();
    const keys = seed(client);
    applyServerEvent(client, { type: 'member_queue_changed', projectKey: KEY, member: 'operator' });
    keys.forEach((key) => expect(client.getQueryState(key)!.isInvalidated).toBe(true));
  });

  it('reads the queue views when the connected Claude connects or leaves', () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.workQueues(KEY), {});
    applyServerEvent(client, { type: 'integrator_connections_changed', projectKey: KEY });
    expect(client.getQueryState(queryKeys.workQueues(KEY))!.isInvalidated).toBe(true);
  });

  it('reads the queue views when an item of the connected Claude changes, and only then', () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.workQueues(KEY), {});
    const plain = inbox.find((entry) => entry.id === 'inb_perm_push')!;
    applyServerEvent(client, { type: 'inbox_upserted', projectKey: KEY, item: plain });
    expect(client.getQueryState(queryKeys.workQueues(KEY))!.isInvalidated).toBe(false);
    const integrator = {
      ...plain,
      kind: 'decision' as const,
      payload: { integratorOpenedAt: '2026-10-22T10:00:00.000Z' },
    };
    applyServerEvent(client, { type: 'inbox_upserted', projectKey: KEY, item: integrator });
    expect(client.getQueryState(queryKeys.workQueues(KEY))!.isInvalidated).toBe(true);
  });
});

describe('contract follow-up events', () => {
  it('keeps provider usage separate and preserves the legacy Claude value', () => {
    const client = seed();
    const codex = { ...planUsage, weeklyPercent: 23 };
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
