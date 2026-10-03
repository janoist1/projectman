import { z } from 'zod';
import { isCodeReviewStage } from '../config/duties';
import type { ProjectConfig } from '../config/schema';
import type { TimelineEvent } from './event';
import { MemberHandle } from './member';
import type { Session } from './session';
import { TaskKey } from './task';
import type { Task } from './task';
import { limitTokens } from './token-usage';
import type { TokenUsage } from './token-usage';

/**
 * Measuring a card (PM-222): how many review rounds and send-backs it took and what it cost per
 * model, so that the closed cards of a period can be compared (does a cheaper model bring more
 * rounds?). The counts come from the card's timeline alone; the stage kinds come from the
 * configuration, not from the stage names.
 */

/** The label a code review sets when it asks for changes (the standard template's label id). */
export const CODE_REVIEW_CHANGES_LABEL = 'code-review-changes';

/** The label the UI/UX review sets when it asks for changes (PM-262): a fix round too. */
export const DESIGN_REVIEW_CHANGES_LABEL = 'design-review-changes';

/** How many days back the comparison of closed cards looks by default, and at most. */
export const DEFAULT_CLOSED_CARDS_DAYS = 14;
export const MAX_CLOSED_CARDS_DAYS = 365;

const Count = z.number().int().nonnegative();

export const CardRounds = z.object({
  /** How many times the card entered a code review stage. */
  reviewRounds: Count,
  /** How many times the `code-review-changes` label was put on it. */
  changeRequests: Count,
  /** How many times the `design-review-changes` label was put on it (PM-262). */
  designChangeRequests: Count.default(0),
  /** How many times it went back into a work stage from a later stage (also by hand or after a failed merge). */
  sendBacks: Count,
});
export type CardRounds = z.infer<typeof CardRounds>;

/** Counts one card's rounds from its timeline events (any order of other event types, old ones too). */
export function countCardRounds(
  events: readonly Pick<TimelineEvent, 'type' | 'data'>[],
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
): CardRounds {
  const stages = config.pipeline.stages;
  const indexOf = (id: unknown) => (typeof id === 'string' ? stages.findIndex((s) => s.id === id) : -1);
  const rounds: CardRounds = { reviewRounds: 0, changeRequests: 0, designChangeRequests: 0, sendBacks: 0 };
  for (const event of events) {
    if (event.type === 'task_stage_changed') {
      const from = indexOf(event.data.from);
      const to = indexOf(event.data.to);
      const target = stages[to];
      if (!target) continue;
      if (isCodeReviewStage(config, target)) rounds.reviewRounds += 1;
      if (target.kind === 'work' && from > to) rounds.sendBacks += 1;
    } else if (event.type === 'task_labels_changed') {
      const added = event.data.added;
      if (!Array.isArray(added)) continue;
      if (added.includes(CODE_REVIEW_CHANGES_LABEL)) rounds.changeRequests += 1;
      if (added.includes(DESIGN_REVIEW_CHANGES_LABEL)) rounds.designChangeRequests += 1;
    }
  }
  return rounds;
}

/** Weighted tokens (`limitTokens`) one model used. */
export const ModelTokens = z.object({ model: z.string(), tokens: Count });
export type ModelTokens = z.infer<typeof ModelTokens>;

/**
 * The weighted tokens per model, subagents' included, the largest first. Weighted as the session
 * warning limit counts them: cache reads at `CACHE_READ_WEIGHT`.
 */
export function weightedTokensByModel(rows: readonly TokenUsage[]): ModelTokens[] {
  const byModel = new Map<string, number>();
  for (const row of rows) byModel.set(row.model, (byModel.get(row.model) ?? 0) + limitTokens(row));
  return [...byModel]
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

/** One closed card of the comparison. */
export const ClosedCardMeasure = z.object({
  taskKey: TaskKey,
  title: z.string(),
  closedAt: z.string(),
  /** Who carried the card when it closed; without an assignee, the member that used the most tokens. */
  implementer: MemberHandle.nullable(),
  /** The models of the implementer's own conversations on this card, as the sessions' usage rows name them. */
  implementerModels: z.array(z.string()),
  /** Weighted tokens of all the card's measured sessions, and the same per model. */
  tokens: Count,
  byModel: z.array(ModelTokens),
  rounds: CardRounds,
  /** Sessions of the card without measured usage (from before the measurement, PM-178). */
  unmeasuredSessions: Count,
});
export type ClosedCardMeasure = z.infer<typeof ClosedCardMeasure>;

/** The cards closed in a period, most recently closed first. */
export const ClosedCardsMeasure = z.object({
  since: z.string(),
  days: z.number().int().positive(),
  cards: z.array(ClosedCardMeasure),
});
export type ClosedCardsMeasure = z.infer<typeof ClosedCardsMeasure>;

/** The start of the period the comparison looks at: `days` days before `now` (ISO time). */
export function closedCardsSince(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 3_600_000).toISOString();
}

/** Whether the card counts as closed in the period starting at `since`: done (not cancelled) by then. */
export function isClosedSince(task: Pick<Task, 'status' | 'closedAt'>, since: string): boolean {
  return task.status === 'done' && task.closedAt !== null && task.closedAt >= since;
}

/**
 * One closed card's measure from its sessions (the model comes from their usage rows, not from the
 * member's setting today) and its rounds. The implementer is who carried it when it closed, or
 * without an assignee the member that used the most tokens.
 */
export function measureClosedCard(
  task: Pick<Task, 'key' | 'title' | 'closedAt' | 'assignee'>,
  sessions: readonly Pick<Session, 'member' | 'usage'>[],
  rounds: CardRounds,
): ClosedCardMeasure {
  const measured = sessions.filter((session) => session.usage);
  const byMember = new Map<string, number>();
  for (const session of measured) {
    const tokens = session.usage!.rows.reduce((sum, row) => sum + limitTokens(row), 0);
    byMember.set(session.member, (byMember.get(session.member) ?? 0) + tokens);
  }
  const implementer = task.assignee ?? [...byMember].sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;
  const byModel = weightedTokensByModel(measured.flatMap((session) => session.usage!.rows));
  const own = measured
    .filter((session) => session.member === implementer)
    .flatMap((session) => session.usage!.rows.filter((row) => row.scope === 'main'));
  return {
    taskKey: task.key,
    title: task.title,
    closedAt: task.closedAt ?? '',
    implementer,
    implementerModels: weightedTokensByModel(own).map((entry) => entry.model),
    tokens: byModel.reduce((sum, entry) => sum + entry.tokens, 0),
    byModel,
    rounds,
    unmeasuredSessions: sessions.length - measured.length,
  };
}

/** Sorts of the comparison list. */
export type ClosedCardsSort = 'closedAt' | 'tokens' | 'reviewRounds';

/** The cards ordered by the column, the largest first; ties by the most recent close. */
export function sortClosedCards(
  cards: readonly ClosedCardMeasure[],
  sort: ClosedCardsSort,
): ClosedCardMeasure[] {
  const value = (card: ClosedCardMeasure) =>
    sort === 'tokens' ? card.tokens : sort === 'reviewRounds' ? card.rounds.reviewRounds : 0;
  return [...cards].sort(
    (a, b) => value(b) - value(a) || (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : 0),
  );
}
