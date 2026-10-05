import type { InboxItem } from '@projectman/shared';
import type { CardQuestion } from '../contracts';
import type { DomainContext } from './context';
import { answerText } from './inbox';

/** How many questions of a card a brief, a resumed session's first message and get_task list. */
export const QUESTION_LIMIT = 6;

/** The timeline events of the card's questions that are looked at for their ids. */
const EVENT_WINDOW = 500;

/**
 * The questions AI members asked people on a card with ask_human (PM-249), so that a member who
 * joins the card, or returns to it, does not ask again what was answered or is still open.
 */
export class CardQuestions {
  private readonly ctx: DomainContext;

  constructor(deps: { ctx: DomainContext }) {
    this.ctx = deps.ctx;
  }

  /**
   * The card's questions, oldest first: every open one, then the latest answered ones, `limit` in all.
   * Expired and cancelled questions are left out. With `since` (an ISO time), only those asked or
   * answered after it.
   */
  list(projectKey: string, taskKey: string, opts: { limit: number; since?: string }): CardQuestion[] {
    const { limit, since } = opts;
    const items = this.ctx.repos.inbox
      .list(projectKey, { kind: 'question', taskKey })
      .filter((item) => item.state === 'open' || item.state === 'resolved')
      .filter((item) => !since || item.createdAt > since || (item.resolution?.at ?? '') > since);
    const latest = (list: InboxItem[], count: number) => list.slice(Math.max(0, list.length - count));
    const open = latest(
      items.filter((item) => item.state === 'open'),
      limit,
    );
    const answered = latest(
      items.filter((item) => item.state === 'resolved'),
      limit - open.length,
    );
    // The repository lists oldest first (by its sequence): filtering keeps that order, also for items
    // asked in the same millisecond.
    const keep = new Set([...open, ...answered].map((item) => item.id));
    const chosen = items.filter((item) => keep.has(item.id));
    if (chosen.length === 0) return [];
    // The events carry the ids get_task reads the whole texts with; a later event of an item wins.
    const asked = new Map<string, string>();
    const answers = new Map<string, string>();
    for (const event of this.ctx.repos.timeline.listOfTypes(
      projectKey,
      taskKey,
      ['question_asked', 'question_answered'],
      EVENT_WINDOW,
    )) {
      const id = event.data.inboxItemId;
      if (typeof id === 'string') (event.type === 'question_asked' ? asked : answers).set(id, event.id);
    }
    return chosen.map((item) =>
      toCardQuestion(item, asked.get(item.id) ?? null, answers.get(item.id) ?? null),
    );
  }
}

function toCardQuestion(
  item: InboxItem,
  askedEventId: string | null,
  answerEventId: string | null,
): CardQuestion {
  const payload = item.payload as { question?: unknown } | null;
  const question =
    typeof payload?.question === 'string' && payload.question.trim() ? payload.question : item.title;
  const base = { inboxItemId: item.id, asker: item.source, question, askedAt: item.createdAt, askedEventId };
  const resolution = item.resolution;
  if (item.state !== 'resolved' || !resolution) return { ...base, state: 'open' };
  return {
    ...base,
    state: 'answered',
    answer: { by: resolution.by, text: answerText(item), at: resolution.at, eventId: answerEventId },
  };
}
