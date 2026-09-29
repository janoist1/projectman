import { QueryClient } from '@tanstack/react-query';
import type { BoardView, InboxView, MemberView, SessionDetail, TaskDetail } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import {
  chats,
  inbox,
  members,
  planUsage,
  projectSummary,
  sessions,
  tasks,
  timeline,
} from '../mocks/fixtures';
import { appendUnique, applyServerEvent, upsertBy } from './cache';
import { queryKeys } from './queryKeys';

const KEY = 'AC';

function seed(): QueryClient {
  const client = new QueryClient();
  const board: BoardView = {
    project: projectSummary,
    columns: [],
    stages: [],
    tasks: structuredClone(tasks),
    members: structuredClone(members),
    openInboxCount: 0,
    planUsage,
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

  it('keeps the inbox and the board count in sync', () => {
    const client = seed();
    const item = { ...inbox.find((entry) => entry.id === 'inb_perm_push')!, state: 'resolved' as const };
    applyServerEvent(client, { type: 'inbox_upserted', projectKey: KEY, item });
    const items = client.getQueryData<InboxView>(queryKeys.inbox(KEY))!.items;
    expect(items.find((entry) => entry.id === 'inb_perm_push')!.state).toBe('resolved');
    const open = items.filter((entry) => entry.state === 'open').length;
    expect(client.getQueryData<BoardView>(queryKeys.board(KEY))!.openInboxCount).toBe(open);
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

  it('refetches configuration-dependent data when the config changes', () => {
    const client = seed();
    applyServerEvent(client, { type: 'config_changed', projectKey: KEY, version: 'abc1234' });
    expect(client.getQueryState(queryKeys.board(KEY))!.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.members(KEY))!.isInvalidated).toBe(true);
  });
});
