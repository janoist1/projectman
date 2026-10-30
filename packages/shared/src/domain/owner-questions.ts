import { z } from 'zod';
import { questionPayloadOf } from './inbox';
import type { InboxItem } from './inbox';

/**
 * The weekly owner question measure (PM-1192): how many questions reached the owners, by which way and under
 * which owner topic (PM-1190), and how many of them the integrator answered for them. One rule for the server
 * and the web's fake backend.
 */

/** The way a question reached the owners. */
export const OwnerQuestionRoute = z.enum([
  /** The screening let it through as an owner decision. */
  'decision',
  /** The screening made it a todo for the owners. */
  'owner_todo',
  /** The screening made it an integrator todo the integrator could not take (`recipientRefusal`). */
  'integrator_fallback',
  /** The integrator passed its todo on to the owners. */
  'integrator_escalated',
  /** The screening did not decide in time, or its member was not there (`fallback`). */
  'screening_fallback',
  /** The project manager's own question: the coordinating member is not screened. */
  'project_manager',
  /** A member asked again without screening (`unscreened`). */
  'reask',
  /** Asked with no screening at all, for example while the screening is off. */
  'unscreened',
]);
export type OwnerQuestionRoute = z.infer<typeof OwnerQuestionRoute>;

/** The topic a question without an owner topic counts under: older questions and system releases. */
export const UNKNOWN_OWNER_TOPIC = 'unknown';

export const OWNER_QUESTION_WEEKS_DEFAULT = 8;

export const OwnerQuestionsQuery = z.strictObject({
  weeks: z.coerce.number().int().min(1).max(26).default(OWNER_QUESTION_WEEKS_DEFAULT),
});
export type OwnerQuestionsQuery = z.infer<typeof OwnerQuestionsQuery>;

const count = z.number().int().min(0);

export const OwnerQuestionWeek = z.object({
  /** The week's Monday and Sunday as local dates (YYYY-MM-DD) in the project's time zone. */
  weekStart: z.string(),
  weekEnd: z.string(),
  /** The ISO week number of the week. */
  isoWeek: z.number().int().min(1).max(53),
  /** Questions that reached the owners in the week. */
  total: count,
  /** `total` by way: every way, zero included. */
  byRoute: z.record(OwnerQuestionRoute, count),
  /** `total` by owner topic id: only the topics that occur; `unknown` for a question without one. */
  byTopic: z.record(z.string(), count),
  /** Of `total`: answered by a person's own login. */
  answeredByOwner: count,
  /** Of `total`: answered through the integrator (`resolution.via`). */
  answeredByIntegrator: count,
  /** Todos that went to the integrator in the week: a separate measure, not part of `total`. */
  integratorTodos: count,
  /** Of `total`: still waiting for an answer. */
  open: count,
});
export type OwnerQuestionWeek = z.infer<typeof OwnerQuestionWeek>;

export const OwnerQuestionsReport = z.object({
  /** The time zone the weeks were cut in (the project's, or UTC when it is not a valid zone). */
  timezone: z.string(),
  /** Newest first; the first one is the week in progress. */
  weeks: z.array(OwnerQuestionWeek),
});
export type OwnerQuestionsReport = z.infer<typeof OwnerQuestionsReport>;

type MeasuredItem = Pick<InboxItem, 'kind' | 'source' | 'state' | 'payload' | 'resolution' | 'createdAt'>;

/**
 * The way a question reached the owners, or null when it did not: still in screening, settled by the
 * screening (answered, forwarded, moot), with the integrator, or not a readable question.
 */
export function ownerQuestionRoute(
  item: Pick<MeasuredItem, 'kind' | 'source' | 'state' | 'payload'>,
  coordinatorHandle: string | null,
): OwnerQuestionRoute | null {
  if (item.kind !== 'question' || item.state === 'screening') return null;
  const payload = questionPayloadOf(item);
  if (!payload) return null;
  if (payload.integratorEscalatedAt) return 'integrator_escalated';
  const screening = payload.screening;
  if (screening) {
    if (screening.forwardedTo) return null;
    if (screening.fallback) return 'screening_fallback';
    if (screening.outcome === 'decision') return 'decision';
    if (screening.outcome !== 'todo' || payload.recipient === 'integrator') return null;
    return screening.recipientRefusal ? 'integrator_fallback' : 'owner_todo';
  }
  if (payload.unscreened) return 'reask';
  return coordinatorHandle !== null && item.source === coordinatorHandle ? 'project_manager' : 'unscreened';
}

const DAY_MS = 86_400_000;

/** A formatter of local dates in `timezone`, and the zone it uses: UTC when the given one is not valid. */
function localDates(timezone: string): { zone: string; format: Intl.DateTimeFormat } {
  const make = (zone: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' });
  try {
    return { zone: timezone, format: make(timezone) };
  } catch {
    return { zone: 'UTC', format: make('UTC') };
  }
}

/** The local day of an instant as days since 1970-01-01. */
function localDay(format: Intl.DateTimeFormat, at: Date): number {
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / DAY_MS;
}

/** The Monday of a day's week; 1970-01-01 was a Thursday. */
const mondayOf = (day: number) => day - ((day + 3) % 7);
const isoDate = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** ISO 8601 week number: the week of the year that holds its Thursday. */
function isoWeekOf(monday: number): number {
  const thursday = new Date((monday + 3) * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1) / DAY_MS;
  return Math.floor((monday + 3 - yearStart) / 7) + 1;
}

/**
 * The earliest moment a question of the last `weeks` weeks can have: a day before the oldest Monday in UTC,
 * which no time zone's Monday starts earlier than. The reader asks for the items since then and
 * `weeklyOwnerQuestions` cuts them exactly.
 */
export function ownerQuestionsSince(input: { timezone: string; now: Date; weeks: number }): string {
  const { format } = localDates(input.timezone);
  const oldest = mondayOf(localDay(format, input.now)) - 7 * (input.weeks - 1);
  return new Date((oldest - 1) * DAY_MS).toISOString();
}

/** The moment a question counts at: when it was screened, else when it was asked. */
function measuredAt(item: MeasuredItem): Date {
  const screening = item.payload.screening;
  const at =
    screening && typeof screening === 'object' && 'at' in screening && typeof screening.at === 'string'
      ? screening.at
      : item.createdAt;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? new Date(item.createdAt) : parsed;
}

const emptyRoutes = () =>
  Object.fromEntries(OwnerQuestionRoute.options.map((route) => [route, 0])) as Record<
    OwnerQuestionRoute,
    number
  >;

/**
 * The last `weeks` ISO weeks (Monday to Sunday in `timezone`), newest first, the week in progress included:
 * what reached the owners (`ownerQuestionRoute`) and the integrator todos of each week. A combined question
 * is counted with its primary, so the caller passes primaries only.
 */
export function weeklyOwnerQuestions(
  items: readonly MeasuredItem[],
  input: { timezone: string; now: Date; weeks: number; coordinatorHandle: string | null },
): OwnerQuestionsReport {
  const { zone, format } = localDates(input.timezone);
  const current = mondayOf(localDay(format, input.now));
  const weeks: OwnerQuestionWeek[] = Array.from({ length: input.weeks }, (_, index) => {
    const monday = current - 7 * index;
    return {
      weekStart: isoDate(monday),
      weekEnd: isoDate(monday + 6),
      isoWeek: isoWeekOf(monday),
      total: 0,
      byRoute: emptyRoutes(),
      byTopic: {},
      answeredByOwner: 0,
      answeredByIntegrator: 0,
      integratorTodos: 0,
      open: 0,
    };
  });
  for (const item of items) {
    if (item.kind !== 'question') continue;
    const index = (current - mondayOf(localDay(format, measuredAt(item)))) / 7;
    const week = weeks[index];
    if (!week) continue;
    if ('integratorOpenedAt' in item.payload) week.integratorTodos += 1;
    const route = ownerQuestionRoute(item, input.coordinatorHandle);
    if (!route) continue;
    week.total += 1;
    week.byRoute[route] += 1;
    const topic = questionPayloadOf(item)?.ownerTopic ?? UNKNOWN_OWNER_TOPIC;
    week.byTopic[topic] = (week.byTopic[topic] ?? 0) + 1;
    if (item.state === 'open') week.open += 1;
    const resolution = item.resolution;
    if (item.state !== 'resolved' || !resolution || resolution.rule) continue;
    if (resolution.via === 'integrator') week.answeredByIntegrator += 1;
    else if (!resolution.superDecision && !resolution.operatorQueue) week.answeredByOwner += 1;
  }
  return { timezone: zone, weeks };
}
