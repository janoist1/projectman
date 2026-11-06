import type { TimelineEvent } from './event';

/**
 * Whether a timeline event is a comment on the card (PM-1290): the Comments column, as opposed to a
 * Process note. The stored `comment` mark decides; an event written before the mark existed is
 * classified by who wrote it. The server, the web and the web's test fake all use this one rule.
 */
export function isCardComment(event: Pick<TimelineEvent, 'type' | 'data' | 'actor'>): boolean {
  if (event.type !== 'task_note') return false;
  if (typeof event.data.comment === 'boolean') return event.data.comment;
  // An old event: a reply or an import, and a person's own note, is a comment; an AI's or the
  // integrator's note is Process.
  if (event.data.replyTo || event.data.importedAuthor) return true;
  return event.actor.kind === 'human' && !event.actor.via;
}

/**
 * Whether a timeline event belongs in the card's Process story (PM-1290): not a comment (the Comments
 * column has it) and not a person's direct message (their conversation, not the card's). The web's
 * Process story filters the card's timeline with this one rule.
 */
export function isProcessTimelineEvent(event: Pick<TimelineEvent, 'type' | 'data' | 'actor'>): boolean {
  if (isCardComment(event)) return false;
  return !(event.type === 'team_message' && event.data.conversation === 'direct');
}

/** The id of the top-level comment a reply answers, or undefined for a top-level comment. */
function commentReplyTo(event: Pick<TimelineEvent, 'data'>): string | undefined {
  const replyTo = event.data.replyTo;
  return typeof replyTo === 'string' && replyTo ? replyTo : undefined;
}

/**
 * The comment id a reply to `target` lands on (PM-1290): the target itself, or its parent when it is a
 * reply (one level, as on GitHub). Null when the target is not a comment of the card at all.
 */
export function replyParentOf(
  target: Pick<TimelineEvent, 'type' | 'data' | 'actor' | 'id' | 'taskKey'> | null,
  taskKey: string,
): string | null {
  if (!target || target.taskKey !== taskKey || !isCardComment(target)) return null;
  return commentReplyTo(target) ?? target.id;
}

export interface CommentThreadsPage {
  threads: { comment: TimelineEvent; replies: TimelineEvent[] }[];
  nextBefore: string | null;
}

/**
 * One page of a card's comment threads (PM-1290) from all the card's notes, oldest first. The page holds
 * `limit` top-level comments with every reply of theirs, so no reply is cut off from its comment. `before`
 * pages back from a top-level comment, `around` centres the page on the thread of a comment or a reply, and
 * neither gives the newest threads. Null when `before` or `around` names no comment of the card.
 */
export function pageCommentThreads(
  notes: readonly TimelineEvent[],
  query: { before?: string | undefined; around?: string | undefined; limit: number },
): CommentThreadsPage | null {
  const comments = notes.filter(isCardComment);
  const tops = comments.filter((event) => commentReplyTo(event) === undefined);
  const repliesByParent = new Map<string, TimelineEvent[]>();
  for (const reply of comments) {
    const parent = commentReplyTo(reply);
    if (parent === undefined) continue;
    repliesByParent.set(parent, [...(repliesByParent.get(parent) ?? []), reply]);
  }
  const indexOfThread = (id: string): number => {
    const own = tops.findIndex((event) => event.id === id);
    if (own >= 0) return own;
    const reply = comments.find((event) => event.id === id);
    const parent = reply && commentReplyTo(reply);
    return parent === undefined ? -1 : tops.findIndex((event) => event.id === parent);
  };
  let start: number;
  let end: number;
  if (query.around !== undefined) {
    const at = indexOfThread(query.around);
    if (at < 0) return null;
    start = Math.max(0, at - Math.floor(query.limit / 2));
    end = Math.min(tops.length, start + query.limit);
    start = Math.max(0, end - query.limit);
  } else if (query.before !== undefined) {
    end = tops.findIndex((event) => event.id === query.before);
    if (end < 0) return null;
    start = Math.max(0, end - query.limit);
  } else {
    end = tops.length;
    start = Math.max(0, end - query.limit);
  }
  return {
    threads: tops
      .slice(start, end)
      .map((comment) => ({ comment, replies: repliesByParent.get(comment.id) ?? [] })),
    nextBefore: start > 0 ? tops[start]!.id : null,
  };
}
