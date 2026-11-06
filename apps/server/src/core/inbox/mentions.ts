import { MENTION_SEEN_OPTION, mentionExcerpt, mentionsClosedByReply } from '@projectman/shared';
import type { Actor, InboxItem, MentionPayload } from '@projectman/shared';
import { isoNow } from '../base';
import type { DomainContext } from '../base';
import type { InboxService } from './inbox';

/** The note that mentions humans, as the inbox needs to know it (PM-1307). */
export interface OpenMentionsInput {
  projectKey: string;
  taskKey: string;
  /** The card's title: the item's fallback title; the web names the place itself. */
  taskTitle: string;
  /** The author's handle: the item's `source`. */
  source: string;
  sessionId: string | null;
  text: string;
  /** The humans to open an item for (`mentionItemTargets`). */
  targets: readonly string[];
  payload: MentionPayload;
}

/** The reply that may close mention items (PM-1307). */
export interface CloseMentionsInput {
  projectKey: string;
  taskKey: string;
  author: Pick<Actor, 'handle' | 'via'>;
  threadId: string;
  /** The reply's time. */
  at: string;
}

/**
 * The `mention` items of Rád vár (PM-1307): one per mentioned human and note, opened and closed inside the
 * unit of work that records the note, so a failed note leaves no item and a repeated request none twice. The
 * item sends no push (the note does) and puts nothing on the card's timeline.
 */
export class InboxMentions {
  private readonly ctx: DomainContext;
  private readonly create: InboxService['create'];
  private readonly publish: (item: InboxItem) => void;

  constructor(deps: {
    ctx: DomainContext;
    create: InboxService['create'];
    publish: (item: InboxItem) => void;
  }) {
    this.ctx = deps.ctx;
    this.create = deps.create;
    this.publish = deps.publish;
  }

  open(input: OpenMentionsInput): InboxItem[] {
    return input.targets.map((handle) =>
      this.create({
        projectKey: input.projectKey,
        kind: 'mention',
        assignees: [handle],
        source: input.source,
        sessionId: input.sessionId,
        taskKey: input.taskKey,
        title: input.taskTitle,
        body: mentionExcerpt(input.text, handle),
        payload: input.payload,
        options: [MENTION_SEEN_OPTION],
      }),
    );
  }

  /** Closes the author's own open mentions of the thread; the system rule says why, so nothing is emitted. */
  closeByReply(input: CloseMentionsInput): InboxItem[] {
    const { author } = input;
    if (!author.handle) return [];
    const open = this.ctx.repos.inbox.list(input.projectKey, {
      state: 'open',
      kind: 'mention',
      taskKey: input.taskKey,
    });
    const closing = mentionsClosedByReply(open, {
      author: author.handle,
      taskKey: input.taskKey,
      threadId: input.threadId,
      at: input.at,
    });
    const resolution = {
      optionId: 'replied',
      by: author.handle,
      at: input.at,
      note: null,
      rule: 'mention_replied' as const,
      ...(author.via ? { via: author.via } : {}),
    };
    const closed: InboxItem[] = [];
    for (const item of closing) {
      const resolved = this.ctx.repos.inbox.close(item.id, 'resolved', resolution, isoNow(this.ctx));
      if (!resolved) continue;
      this.publish(resolved);
      closed.push(resolved);
    }
    return closed;
  }
}
