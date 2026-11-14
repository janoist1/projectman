import { z } from 'zod';
import type { ConfigDiffItem } from '../config/diff';
import type { ClosedCardMeasure } from './card-measure';
import type { StageKind } from './pipeline';

/**
 * The weekly operations review (PM-1464): what the project manager tells the owners once a week about
 * the team's measures and the settings changed since the last review. The measures come from the closed
 * cards of the card measurement (PM-222) and the open cards; this file only counts, the server reads
 * the cards, the inbox and the configuration history.
 */

/** How many days pass between two reviews, and how old a project is before its first. */
export const OPERATIONS_REVIEW_INTERVAL_DAYS = 7;

/** How many days without activity in a work stage make an open card stuck. */
const OPERATIONS_STUCK_DAYS = 3;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface OperationsReviewInput {
  /** ISO time the review is made at. */
  now: string;
  closed: readonly ClosedCardMeasure[];
  /** When each closed card was created, by card key; a card without one is left out of the lead time. */
  createdAt: Readonly<Record<string, string>>;
  /** The open cards: the kind of the stage each is in and when it was last active. */
  open: readonly { taskKey: string; stageKind: StageKind; lastActivityAt: string }[];
  /** The open items that wait for a person: when each was created. */
  humanItems: readonly { createdAt: string }[];
}

export const OperationsReview = z.object({
  closedCards: z.number().int().nonnegative(),
  /** The median of the closed cards' lead time (created to closed) in hours, one decimal; null: none is known. */
  medianLeadHours: z.number().nonnegative().nullable(),
  /** The fix rounds (code and design review change requests) of the closed cards, and their send-backs. */
  fixRounds: z.number().int().nonnegative(),
  sendBacks: z.number().int().nonnegative(),
  /** What waits for a person: how many items and the age in hours of the oldest. */
  waitingForPeople: z.object({
    count: z.number().int().nonnegative(),
    oldestAgeHours: z.number().nonnegative().nullable(),
  }),
  /** Open cards in a work stage without activity for `OPERATIONS_STUCK_DAYS` days, the longest idle first. */
  stuckCards: z.array(z.object({ taskKey: z.string(), idleDays: z.number().int().nonnegative() })),
  /** The weighted tokens of the closed cards. */
  tokens: z.number().int().nonnegative(),
});
export type OperationsReview = z.infer<typeof OperationsReview>;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const oneDecimal = (value: number) => Math.round(value * 10) / 10;

/** The measures of the week: closed cards, lead time, rounds, waits for people, stuck cards, tokens. */
export function operationsReview(input: OperationsReviewInput): OperationsReview {
  const now = Date.parse(input.now);
  const leadHours = input.closed.flatMap((card) => {
    const created = Date.parse(input.createdAt[card.taskKey] ?? '');
    const closed = Date.parse(card.closedAt);
    return Number.isNaN(created) || Number.isNaN(closed) || closed < created
      ? []
      : [(closed - created) / HOUR_MS];
  });
  const lead = median(leadHours);
  const ages = input.humanItems
    .map((item) => Math.max(0, now - Date.parse(item.createdAt)) / HOUR_MS)
    .filter((age) => !Number.isNaN(age));
  const stuckCards = input.open
    .filter(
      (card) =>
        card.stageKind === 'work' && now - Date.parse(card.lastActivityAt) >= OPERATIONS_STUCK_DAYS * DAY_MS,
    )
    .map((card) => ({
      taskKey: card.taskKey,
      idleDays: Math.floor((now - Date.parse(card.lastActivityAt)) / DAY_MS),
    }))
    .sort((a, b) => b.idleDays - a.idleDays || (a.taskKey < b.taskKey ? -1 : 1));
  return {
    closedCards: input.closed.length,
    medianLeadHours: lead === null ? null : oneDecimal(lead),
    fixRounds: input.closed.reduce(
      (sum, card) => sum + card.rounds.changeRequests + card.rounds.designChangeRequests,
      0,
    ),
    sendBacks: input.closed.reduce((sum, card) => sum + card.rounds.sendBacks, 0),
    waitingForPeople: {
      count: ages.length,
      oldestAgeHours: ages.length === 0 ? null : oneDecimal(Math.max(...ages)),
    },
    stuckCards,
    tokens: input.closed.reduce((sum, card) => sum + card.tokens, 0),
  };
}

/**
 * Whether a review is due now: the project has a project manager and the setting is `weekly`, at least
 * `OPERATIONS_REVIEW_INTERVAL_DAYS` days passed since the last review (or, without one, since the project
 * was created), and something moved since (a card closed or changed its stage). A week without movement
 * tells the owners nothing.
 */
export function operationsReviewDue(input: {
  now: string;
  setting: 'weekly' | 'off';
  hasProjectManager: boolean;
  /** When the last review was raised, or null. */
  lastReviewAt: string | null;
  projectCreatedAt: string;
  moved: boolean;
}): boolean {
  if (input.setting !== 'weekly' || !input.hasProjectManager || !input.moved) return false;
  const since = Date.parse(input.lastReviewAt ?? input.projectCreatedAt);
  return !Number.isNaN(since) && Date.parse(input.now) - since >= OPERATIONS_REVIEW_INTERVAL_DAYS * DAY_MS;
}

/** The ISO week of an instant as `YYYY-Www` (UTC): the case key of one review per week. */
export function isoWeekKey(at: string): string {
  const date = new Date(Date.parse(at));
  const weekday = (date.getUTCDay() + 6) % 7;
  // The Thursday of the week decides which ISO year and week it is.
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - weekday + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** One configuration change as a short English phrase the review lists: the area it touched. */
export function configChangeArea(item: ConfigDiffItem): string {
  switch (item.kind) {
    case 'created':
    case 'other':
      return item.kind;
    case 'section_changed':
      return `section ${item.section}`;
    case 'stage_changed':
    case 'column_changed':
    case 'label_changed':
      return `${item.kind} ${item.id} (${item.fields.join(', ')})`;
    default:
      return `${item.kind} ${item.id}`;
  }
}

/** The settings changed since the last review: one entry per saved version, with the areas it touched. */
export const OperationsReviewSettingChange = z.object({
  version: z.string(),
  at: z.string(),
  areas: z.array(z.string()),
  /** The version restores an earlier one: its id (`config_revert` target), else null. */
  restores: z.string().nullable(),
});
export type OperationsReviewSettingChange = z.infer<typeof OperationsReviewSettingChange>;

/** What an `operations_review` signal carries (its `subject` holds it as JSON, read once when it is raised). */
export const OperationsReviewFacts = z.object({
  /** The period: the last review (or the project's start) up to now. */
  since: z.string(),
  until: z.string(),
  measures: OperationsReview,
  settingChanges: z.array(OperationsReviewSettingChange),
  /** The rules in force with the project's reason for each (null: the project gave none). */
  rules: z.array(z.object({ id: z.string(), reason: z.string().nullable() }).passthrough()),
});
export type OperationsReviewFacts = z.infer<typeof OperationsReviewFacts>;
