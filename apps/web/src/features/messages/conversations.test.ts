import { describe, expect, it } from 'vitest';
import type { InboxItem, MessageReceipt, TeamMessage, TeamThread } from '@projectman/shared';
import type { MemberIndex } from '../../lib/members';
import {
  answeredQuestionsFrom,
  conversationRows,
  layoutThread,
  openQuestionsFrom,
  recentTasksOf,
  threadItems,
} from './conversations';
import { deliveryState } from './receipts';

const DAY = 24 * 60 * 60_000;
const base = Date.parse('2026-03-10T09:00:00.000Z');
const at = (ms: number) => new Date(base + ms).toISOString();

function message(id: string, from: string, to: string[], taskKey: string | null, ms: number): TeamMessage {
  return {
    id,
    projectKey: 'AC',
    from,
    to,
    taskKey,
    body: id,
    createdAt: at(ms),
    deliveredAt: at(ms),
    receipts: [],
  };
}

function question(id: string, source: string, patch: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    projectKey: 'AC',
    kind: 'question',
    assignees: ['owner'],
    source,
    sessionId: null,
    taskKey: null,
    title: id,
    body: null,
    payload: {},
    options: [],
    state: 'open',
    resolution: null,
    createdAt: at(0),
    ...patch,
  } as InboxItem;
}

const members = new Map([
  ['owner', { handle: 'owner', status: 'active' }],
  ['fe-1', { handle: 'fe-1', status: 'active' }],
  ['qa', { handle: 'qa', status: 'active' }],
  ['old', { handle: 'old', status: 'retired' }],
]) as unknown as MemberIndex;

describe('layoutThread', () => {
  it('shows the task at the first message, at every change of task and after a day heading', () => {
    const items = threadItems(
      [
        message('m1', 'owner', ['fe-1'], 'AC-1', 0),
        message('m2', 'fe-1', ['owner'], 'AC-1', 1000),
        message('m3', 'owner', ['fe-1'], 'AC-2', 2000),
        message('m4', 'owner', ['fe-1'], 'AC-2', 3000),
        message('m5', 'owner', ['fe-1'], 'AC-2', DAY),
      ],
      [],
      [],
    );
    expect(layoutThread(items, null).map((entry) => entry.showTask)).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('does not count a message without a task as a change of task', () => {
    const items = threadItems(
      [
        message('m1', 'owner', ['fe-1'], 'AC-1', 0),
        message('m2', 'owner', ['fe-1'], null, 1000),
        message('m3', 'owner', ['fe-1'], 'AC-1', 2000),
      ],
      [],
      [],
    );
    expect(layoutThread(items, null).map((entry) => entry.showTask)).toEqual([true, false, false]);
  });

  it('puts the day heading and the new-messages line where they belong and groups runs of a sender', () => {
    const items = threadItems(
      [
        message('m1', 'fe-1', ['owner'], null, 0),
        message('m2', 'fe-1', ['owner'], null, 60_000),
        message('m3', 'fe-1', ['owner'], null, 20 * 60_000),
        message('m4', 'owner', ['fe-1'], null, DAY),
      ],
      [],
      [],
    );
    const entries = layoutThread(items, 'm3');
    expect(entries.map((entry) => entry.firstOfRun)).toEqual([true, false, true, true]);
    expect(entries.map((entry) => entry.newLine)).toEqual([false, false, true, false]);
    expect(entries.map((entry) => entry.day !== null)).toEqual([true, false, false, true]);
  });

  it('orders questions and answers among the messages by time', () => {
    const items = threadItems(
      [message('m1', 'fe-1', ['owner'], null, 0), message('m3', 'owner', ['fe-1'], null, 5000)],
      [question('q1', 'fe-1', { createdAt: at(1000) })],
      [
        question('q0', 'fe-1', {
          state: 'resolved',
          resolution: { by: 'owner', at: at(3000), optionId: 'a', note: null },
        }),
      ],
    );
    expect(items.map((item) => item.id)).toEqual(['m1', 'q1', 'q0', 'm3']);
    expect(layoutThread(items, null).map((entry) => entry.showTask)).toEqual([false, false, false, false]);
  });
});

describe('conversationRows', () => {
  const thread = (peer: string, last: TeamMessage, unreadCount = 0): TeamThread => ({
    peer,
    lastMessage: last,
    unreadCount,
  });

  it('orders the rows by the latest activity and keeps a question asker without messages', () => {
    const { rows, rest } = conversationRows(
      [
        thread('fe-1', message('a', 'fe-1', ['owner'], null, 1000), 1),
        thread('qa', message('b', 'owner', ['qa'], null, 5000)),
      ],
      [question('q1', 'ghost', { createdAt: at(9000) })],
      members,
      'owner',
    );
    expect(rows.map((row) => row.peer)).toEqual(['ghost', 'qa', 'fe-1']);
    expect(rows[0]).toMatchObject({ lastMessage: null, asks: 1, unreadCount: 0 });
    expect(rows[2]).toMatchObject({ unreadCount: 1, asks: 0 });
    expect(rest).toEqual([]);
  });

  it('moves a thread up for an open question and leaves the viewer and retired members out of the rest', () => {
    const { rows, rest } = conversationRows(
      [thread('fe-1', message('a', 'fe-1', ['owner'], null, 1000))],
      [question('q1', 'fe-1', { createdAt: at(8000) })],
      members,
      'owner',
    );
    expect(rows[0]).toMatchObject({ peer: 'fe-1', asks: 1, lastAt: at(8000) });
    expect(rest).toEqual(['qa']);
  });
});

describe('questions of a member', () => {
  const items = [
    question('open', 'fe-1'),
    question('other', 'qa'),
    question('not-mine', 'fe-1', { assignees: ['kata'] }),
    question('permission', 'fe-1', { kind: 'permission' }),
    question('done', 'fe-1', {
      state: 'resolved',
      resolution: { by: 'owner', at: at(1), optionId: 'a', note: null },
    }),
  ];

  it('takes only open questions of that member that wait for me', () => {
    expect(openQuestionsFrom(items, 'fe-1', 'owner').map((item) => item.id)).toEqual(['open']);
  });

  it('takes only the questions I answered', () => {
    expect(answeredQuestionsFrom(items, 'fe-1', 'owner').map((item) => item.id)).toEqual(['done']);
    expect(answeredQuestionsFrom(items, 'fe-1', 'kata')).toEqual([]);
  });
});

describe('recentTasksOf', () => {
  it('lists the tasks of a thread, the latest first and each once', () => {
    expect(
      recentTasksOf([
        message('1', 'owner', ['fe-1'], 'AC-1', 0),
        message('2', 'owner', ['fe-1'], 'AC-2', 1),
        message('3', 'owner', ['fe-1'], null, 2),
        message('4', 'owner', ['fe-1'], 'AC-1', 3),
      ]),
    ).toEqual(['AC-1', 'AC-2']);
  });
});

describe('deliveryState', () => {
  const ai = (deliveredAt: string | null): MessageReceipt => ({
    handle: 'fe-1',
    kind: 'ai',
    deliveredAt,
    readAt: null,
  });
  const human = (readAt: string | null): MessageReceipt => ({
    handle: 'kata',
    kind: 'human',
    deliveredAt: at(0),
    readAt,
  });

  it('is queued while an AI recipient has not received it', () => {
    expect(deliveryState([ai(null), human(at(1))])).toBe('queued');
  });
  it('is read only when every recipient is a human who read it', () => {
    expect(deliveryState([human(at(1))])).toBe('read');
    expect(deliveryState([human(at(1)), ai(at(0))])).toBe('delivered');
  });
  it('is unread while a human recipient has not read it', () => {
    expect(deliveryState([human(null)])).toBe('unread');
  });
  it('is delivered for AI recipients that have it', () => {
    expect(deliveryState([ai(at(0))])).toBe('delivered');
  });
});
