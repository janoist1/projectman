import type { InboxItem, TeamMessage, TeamThread } from '@projectman/shared';
import { formatDayHeading } from '../../i18n/format';
import type { MemberIndex } from '../../lib/members';

/** One row of the conversation list. */
export interface ConversationRow {
  peer: string;
  /** Null when the member only has an open question for me and no message yet. */
  lastMessage: TeamMessage | null;
  /** The newest thing in the conversation: the last message or the open question. */
  lastAt: string;
  unreadCount: number;
  /** Open questions of the member that wait for me. */
  asks: number;
}

/** The open questions (`ask_human`) a member raised that wait for me. */
export function openQuestionsFrom(
  items: readonly InboxItem[] | undefined,
  peer: string,
  myHandle: string | null,
): InboxItem[] {
  if (!items || !myHandle) return [];
  return items.filter(
    (item) =>
      item.kind === 'question' &&
      item.state === 'open' &&
      item.source === peer &&
      item.assignees.includes(myHandle),
  );
}

/** The questions of a member that I have answered, for the "you answered" rows of the thread. */
export function answeredQuestionsFrom(
  items: readonly InboxItem[] | undefined,
  peer: string,
  myHandle: string | null,
): InboxItem[] {
  if (!items || !myHandle) return [];
  return items.filter(
    (item) =>
      item.kind === 'question' &&
      item.state === 'resolved' &&
      item.source === peer &&
      item.resolution?.by === myHandle,
  );
}

/**
 * The list's rows, the most recently active first: the threads the server counted, plus a row for
 * every member who only asked me something. `rest` are the other members, for a first message.
 */
export function conversationRows(
  threads: readonly TeamThread[],
  openItems: readonly InboxItem[],
  members: MemberIndex,
  myHandle: string | null,
): { rows: ConversationRow[]; rest: string[] } {
  const asksBy = new Map<string, InboxItem[]>();
  for (const item of openItems) {
    if (item.kind !== 'question' || item.state !== 'open') continue;
    asksBy.set(item.source, [...(asksBy.get(item.source) ?? []), item]);
  }
  const rows = new Map<string, ConversationRow>();
  for (const thread of threads) {
    const asks = asksBy.get(thread.peer) ?? [];
    rows.set(thread.peer, {
      peer: thread.peer,
      lastMessage: thread.lastMessage,
      lastAt: [thread.lastMessage.createdAt, ...asks.map((a) => a.createdAt)].sort().reverse()[0]!,
      unreadCount: thread.unreadCount,
      asks: asks.length,
    });
  }
  for (const [peer, asks] of asksBy) {
    if (rows.has(peer) || peer === myHandle) continue;
    rows.set(peer, {
      peer,
      lastMessage: null,
      lastAt: asks
        .map((a) => a.createdAt)
        .sort()
        .reverse()[0]!,
      unreadCount: 0,
      asks: asks.length,
    });
  }
  const ordered = [...rows.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const rest = [...members.values()]
    .filter((member) => member.handle !== myHandle && member.status !== 'retired' && !rows.has(member.handle))
    .map((member) => member.handle);
  return { rows: ordered, rest };
}

/** What the thread shows, oldest first. */
export type ThreadItem =
  | { type: 'message'; at: string; id: string; message: TeamMessage }
  | { type: 'question'; at: string; id: string; item: InboxItem }
  | { type: 'answered'; at: string; id: string; item: InboxItem };

export function threadItems(
  messages: readonly TeamMessage[],
  open: readonly InboxItem[],
  answered: readonly InboxItem[],
): ThreadItem[] {
  return [
    ...messages.map((message): ThreadItem => ({
      type: 'message',
      at: message.createdAt,
      id: message.id,
      message,
    })),
    ...open.map((item): ThreadItem => ({ type: 'question', at: item.createdAt, id: item.id, item })),
    ...answered.map((item): ThreadItem => ({
      type: 'answered',
      at: item.resolution?.at ?? item.createdAt,
      id: item.id,
      item,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** A thread entry with what the layout decides around it. */
export interface ThreadEntry {
  item: ThreadItem;
  /** Heading of a new day before this entry. */
  day: string | null;
  /** The "new messages" line goes before this entry. */
  newLine: boolean;
  /** First message of a run by one sender: the sender shows. */
  firstOfRun: boolean;
  /** The task chip shows: first message, a change of task, or the first one after a day heading. */
  showTask: boolean;
}

/** Messages of one sender closer than this form a run. */
const RUN_GAP_MS = 5 * 60_000;

function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Lays the thread out: day headings, the "new messages" line before `newFromId`, runs of one
 * sender, and where the task chip shows (the first message, every change of task, and the first
 * message after a day heading).
 */
export function layoutThread(items: readonly ThreadItem[], newFromId: string | null): ThreadEntry[] {
  let lastDay = '';
  let lastTask: string | null = null;
  let previous: TeamMessage | null = null;
  return items.map((item) => {
    const key = dayKey(item.at);
    const newDay = key !== lastDay;
    const day = newDay ? formatDayHeading(item.at) : null;
    if (newDay) {
      lastDay = key;
      lastTask = null;
      previous = null;
    }
    if (item.type !== 'message') {
      previous = null;
      return { item, day, newLine: false, firstOfRun: false, showTask: false };
    }
    const { message } = item;
    const firstOfRun =
      !previous ||
      previous.from !== message.from ||
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() > RUN_GAP_MS;
    const showTask = message.taskKey !== null && message.taskKey !== lastTask;
    previous = message;
    // A message without a task counts as a change too: the task shows again after it.
    lastTask = message.taskKey;
    return { item, day, newLine: newFromId === message.id, firstOfRun, showTask };
  });
}

/** The lines of a markdown body that have content, the code fence marks left out. */
function contentLines(markdown: string): string[] {
  return markdown
    .replace(/```[^\n]*/g, '')
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text !== '');
}

/**
 * A message body as plain one-line text, for a list row: the first line with content, without the
 * markdown marks (headings, list markers, quotes, emphasis, code, links and images).
 */
export function plainPreview(markdown: string): string {
  return plainLine(contentLines(markdown)[0] ?? '');
}

/** The whole body as plain text on one line, its lines joined by a space (the row clamps it). */
export function plainText(markdown: string): string {
  return contentLines(markdown).map(plainLine).join(' ');
}

function plainLine(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .trim();
}

/** The tasks of a thread, the latest first: what the composer offers first. */
export function recentTasksOf(messages: readonly TeamMessage[]): string[] {
  const keys: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.taskKey && !keys.includes(message.taskKey)) keys.push(message.taskKey);
  }
  return keys;
}
