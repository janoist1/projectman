import { isOpenTask, memberOf } from '@projectman/shared';
import type { Session, TimelineEvent } from '@projectman/shared';
import { cardChangeNoticeText } from '../../agent-text';
import type { CardChangeNoticeItem } from '../../agent-text';
import type {
  CardChangeNotice,
  CardChangeNotices as CardChangeNoticesContract,
  ToolContext,
} from '../../contracts';
import type { DomainContext } from '../../core/base';
import { staleReasonFor } from '../../core/messages';
import type { ProjectService } from '../../core/projects';

/** The events one call reads at most; the rest waits for the next call. */
const READ_LIMIT = 500;

/** The acceptance operations that change what the card asks for; `done`, `confirm` and `not_needed` only report a state. */
const SCOPE_CHANGES: ReadonlySet<string> = new Set(['add', 'edit', 'remove', 'reopen', 'move', 'moved_in']);

interface CardChangeNoticeDeps {
  readonly ctx: DomainContext;
  readonly projects: Pick<ProjectService, 'cachedConfig'>;
}

/**
 * Tells a running card session, in the result of its next team tool call, what changed on its card since it
 * last heard of it (PM-1512): the description, the acceptance items, a message for the member and an answer to
 * the member's question, when somebody else made the change. The source is the card's timeline; per session one
 * durable cursor stores how far it has been looked through, so an event is told once.
 *
 * The notice is only a pointer: it does not deliver the message or mark it delivered.
 */
export class CardChangeNotices implements CardChangeNoticesContract {
  private readonly ctx: DomainContext;
  private readonly projects: CardChangeNoticeDeps['projects'];

  constructor(deps: CardChangeNoticeDeps) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
  }

  /** A session starts: what happened before is in its first input, so only later changes are news. */
  sessionStarted(session: Session): void {
    try {
      this.ctx.repos.cardNoticeCursors.raise(
        session.id,
        session.projectKey,
        this.ctx.repos.timeline.maxSeq(),
        this.ctx.now().toISOString(),
      );
    } catch (err) {
      this.ctx.logger.warn({ err, sessionId: session.id }, 'could not set the card notice cursor');
    }
  }

  take(tool: ToolContext): CardChangeNotice | null {
    if (!tool.taskKey) return null;
    try {
      return this.ctx.unitOfWork(() => this.collect(tool, tool.taskKey!));
    } catch (err) {
      this.ctx.logger.warn({ err, sessionId: tool.sessionId }, 'could not collect the card change notice');
      return null;
    }
  }

  rollback(sessionId: string, grants: readonly string[]): void {
    try {
      const at = this.ctx.now().toISOString();
      for (const grant of [...grants].reverse()) {
        const [from, to] = grant.split('-').map(Number);
        if (from === undefined || to === undefined || !Number.isInteger(from) || !Number.isInteger(to))
          continue;
        this.ctx.repos.cardNoticeCursors.rollback(sessionId, from, to, at);
      }
    } catch (err) {
      this.ctx.logger.warn({ err, sessionId }, 'could not take the card notice back');
    }
  }

  private collect(tool: ToolContext, taskKey: string): CardChangeNotice | null {
    const { cardNoticeCursors, timeline, tasks } = this.ctx.repos;
    const at = this.ctx.now().toISOString();
    const cursor = cardNoticeCursors.get(tool.sessionId);
    // A session already running when this was installed: nothing back in time.
    if (cursor === null) {
      cardNoticeCursors.raise(tool.sessionId, tool.projectKey, timeline.maxSeq(), at);
      return null;
    }
    const rows = timeline.taskEventsAfter(taskKey, cursor, READ_LIMIT);
    if (rows.length === 0) return null;
    const last = rows[rows.length - 1]!.seq;
    if (!cardNoticeCursors.advance(tool.sessionId, cursor, last, at)) return null;
    const task = tasks.get(taskKey);
    if (!task || !isOpenTask(task)) return null;
    const items = rows.flatMap(({ event }) => this.itemOf(event, tool.member));
    if (items.length === 0) return null;
    return { text: cardChangeNoticeText(taskKey, items), grant: `${cursor}-${last}` };
  }

  /** The news in one timeline event for `member`: none for their own change, the system's, or a change that is no news. */
  private itemOf(event: TimelineEvent, member: string): CardChangeNoticeItem[] {
    if (event.actor.kind === 'system' || event.actor.handle === member) return [];
    const base = { actor: event.actor.handle ?? 'someone', eventId: event.id };
    switch (event.type) {
      case 'task_updated':
        return Array.isArray(event.data.fields) && event.data.fields.includes('description')
          ? [{ ...base, kind: 'description' }]
          : [];
      case 'acceptance_item_changed': {
        const change = String(event.data.change);
        return SCOPE_CHANGES.has(change) ? [{ ...base, kind: 'acceptance', change }] : [];
      }
      case 'team_message':
        return this.messageItem(event, member, base);
      default:
        return [];
    }
  }

  private messageItem(
    event: TimelineEvent,
    member: string,
    base: Pick<CardChangeNoticeItem, 'actor' | 'eventId'>,
  ): CardChangeNoticeItem[] {
    const { data } = event;
    if (!Array.isArray(data.to) || !data.to.includes(member)) return [];
    if (data.kind === 'info' || data.from === 'system') return [];
    const message = typeof data.messageId === 'string' ? this.ctx.repos.messages.get(data.messageId) : null;
    if (!message) return [];
    const config = this.projects.cachedConfig(message.projectKey);
    // A person's message is typed into the session at once, so "delivered" only means it stands in the input
    // queue, behind the turn that is running: the notice is the news. An AI member's waiting message is typed
    // at idle, so its delivery is the member having it: the notice would only repeat it.
    const fromHuman = !!config && memberOf(config, message.from)?.kind === 'human';
    if (!fromHuman && message.receipts?.some((r) => r.handle === member && r.deliveredAt !== null)) return [];
    // No longer valid for the member (replaced, answered by a result, the card moved on): the notice would only mislead.
    if (config && staleReasonFor(this.ctx, config, message, member) !== null) return [];
    return [{ ...base, kind: message.answer ? 'answer' : 'message' }];
  }
}
