import {
  MemberHandle,
  TEAM_MESSAGE_PREFIX_RE,
  splitTeamMessageBatch,
  userTextOrigin,
  type ChatItem,
} from '@projectman/shared';
import { oneLine } from '../tools';
import { rec, str, type Json } from './json';

/**
 * Chat items that read the same whichever agent CLI recorded the transcript (Claude Code,
 * Codex): the user's turns (the kick-off brief, human text, injected team messages), team
 * messages the member sends with the team tools, and the tool names remembered to summarise
 * tool results.
 */

/** Sender used for outgoing team messages when the session's member is unknown. */
export const UNKNOWN_MEMBER = 'unknown';

export function isHandle(value: unknown): value is string {
  return MemberHandle.safeParse(value).success;
}

/** Valid member handles of a `to` value (one handle or a list). */
export function recipients(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.filter(isHandle);
}

/**
 * Text of message content: a string, or the texts of a list's items joined by blank lines.
 * `accept` limits which items count (default: every item with a text).
 */
export function textOf(content: unknown, accept: (item: Json) => boolean = () => true): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const i = rec(item);
      return i && accept(i) && typeof i.text === 'string' ? i.text : '';
    })
    .filter((t) => t.length > 0)
    .join('\n\n');
}

/**
 * The user's turns of one conversation. Only the first can be the system's kick-off brief;
 * an injected team message ("[team message from <handle> ...]") reads as an incoming team
 * message to the session's member.
 */
export class UserTurns {
  private readonly self: string | null;
  private nextOrigin: 'brief' | 'human';

  constructor(self: string | null, firstUserOrigin: 'brief' | 'human' = 'brief') {
    this.self = self;
    this.nextOrigin = firstUserOrigin;
  }

  item(text: string, id: string, ts: string): ChatItem {
    const origin = userTextOrigin(text, this.nextOrigin);
    this.nextOrigin = 'human';
    const team = TEAM_MESSAGE_PREFIX_RE.exec(text);
    const sender = team?.[1];
    if (team && isHandle(sender)) {
      return {
        kind: 'team_message',
        id,
        ts,
        direction: 'in',
        from: sender,
        to: this.self ? [this.self] : [],
        text: text.slice(team[0].length).trim(),
      };
    }
    return { kind: 'user_text', id, ts, text, origin };
  }

  items(text: string, id: string, ts: string): ChatItem[] {
    const batch = splitTeamMessageBatch(text);
    if (!batch) return [this.item(text, id, ts)];
    this.nextOrigin = 'human';
    return [
      { kind: 'system_note', id, ts, text: batch.header },
      ...batch.items.map((item, index): ChatItem => ({
        kind: 'team_message',
        id: `${id}#${index}`,
        ts,
        direction: 'in',
        from: item.from,
        to: this.self ? [this.self] : [],
        text: item.body,
      })),
    ];
  }
}

/** The handle of the session's member, when it is a valid one. */
export function selfHandle(self: string | null | undefined): string | null {
  return self && isHandle(self) ? self : null;
}

/** A team message the member sent: the arguments of a send_message tool call. */
export function sentTeamMessage(args: Json, id: string, ts: string, self: string | null): ChatItem {
  return {
    kind: 'team_message',
    id,
    ts,
    direction: 'out',
    from: self ?? UNKNOWN_MEMBER,
    to: recipients(args.to),
    text: str(args.text) ?? str(args.message) ?? '',
  };
}

/** A send_message call that failed, with the error it returned. */
export function undeliveredTeamMessage(error: string, id: string, ts: string): ChatItem {
  return { kind: 'system_note', id, ts, text: `Team message not delivered: ${oneLine(error, 200)}` };
}

const MAX_TOOL_MEMORY = 2000;

/** Tool names by call id, to summarise the matching results. The oldest are forgotten first. */
export class ToolNames {
  private readonly names = new Map<string, string>();
  private readonly max: number;

  constructor(max = MAX_TOOL_MEMORY) {
    this.max = max;
  }

  remember(callId: string, name: string): void {
    this.names.set(callId, name);
    if (this.names.size > this.max) {
      const oldest = this.names.keys().next().value;
      if (oldest !== undefined) this.names.delete(oldest);
    }
  }

  get(callId: string): string | null {
    return this.names.get(callId) ?? null;
  }
}
