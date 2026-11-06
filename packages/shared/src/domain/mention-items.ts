import { teamMessageRecipientRefusal } from '../config/communication';
import { memberOf } from '../config/lookup';
import type { ProjectConfig } from '../config/schema';
import type { Actor } from './event';
import { mentionPayloadOf } from './inbox';
import type { InboxItem } from './inbox';
import { mentionTokens } from './mentions';

/** The longest excerpt a mention item carries, and where a late mention makes it start earlier (PM-1307). */
const EXCERPT_MAX = 600;
const EXCERPT_LATE_FROM = 500;
const EXCERPT_LEAD = 100;

/**
 * The humans a note opens a `mention` item for (PM-1307): the mentioned human members, never the author.
 * A system author and an import open none; neither does a mention the author may not send as a team message
 * (a client reaches only the contacts). `mentions` are the handles the note mentions (`commentMentions`).
 */
export function mentionItemTargets(input: {
  config: Pick<ProjectConfig, 'team'>;
  author: Pick<Actor, 'kind' | 'handle'>;
  mentions: readonly string[];
  imported: boolean;
}): string[] {
  const { config, author, imported } = input;
  if (imported || author.kind === 'system' || !author.handle) return [];
  const from = author.handle;
  return [...new Set(input.mentions)].filter(
    (handle) =>
      handle !== from &&
      memberOf(config, handle)?.kind === 'human' &&
      teamMessageRecipientRefusal(config, from, [handle]) === null,
  );
}

/**
 * The body of a mention item: the note's text up to 600 characters. A mention late in a long text moves the
 * start about 100 characters before it; a cut at either end is marked with `…`.
 */
export function mentionExcerpt(text: string, handle: string): string {
  if (text.length <= EXCERPT_MAX) return text;
  const first = mentionTokens(text).find((token) => token.handle === handle.toLowerCase());
  const start = first && first.start > EXCERPT_LATE_FROM ? Math.max(0, first.start - EXCERPT_LEAD) : 0;
  const lead = start > 0 ? '…' : '';
  const room = EXCERPT_MAX - lead.length;
  if (start + room >= text.length) return lead + text.slice(start);
  return lead + text.slice(start, start + room - 1) + '…';
}

/**
 * The open mention items a human's reply closes (PM-1307): their own, on the same card, in the thread the
 * reply goes to, raised before the reply. An item of another thread, another person or a standalone comment
 * (no thread) stays open.
 */
export function mentionsClosedByReply(
  items: readonly InboxItem[],
  reply: { author: string; taskKey: string; threadId: string; at: string },
): InboxItem[] {
  return items.filter((item) => {
    if (item.state !== 'open' || !item.assignees.includes(reply.author)) return false;
    if (item.taskKey !== reply.taskKey || item.createdAt >= reply.at) return false;
    return mentionPayloadOf(item)?.threadId === reply.threadId;
  });
}
