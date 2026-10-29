import { z } from 'zod';
import type { TimelineEvent } from './event';
import { canSeeInboxItem, questionPayloadOf, visibleQuestionItem } from './inbox';
import type { InboxItem } from './inbox';
import { MemberHandle } from './member';
import { canSeeTeamMessage } from './message';
import type { TeamMessage } from './message';
import { TaskKey } from './task';
import type { Task, TaskViewer } from './task';
import { visibleTimelineEvent } from './timeline-visibility';

/**
 * The searchable history of a project (PM-744, PM-786): the cards, the notes on them, the closed
 * questions, the team messages and the two project documents. This file holds the pure parts the
 * server's index and the tools share: the contract, the text each source contributes to the index
 * and the one visibility rule that the search and the full read of a source both apply.
 */
export const HISTORY_SOURCE_TYPES = ['task', 'note', 'question', 'message', 'document'] as const;
export const HistorySourceType = z.enum(HISTORY_SOURCE_TYPES);
export type HistorySourceType = z.infer<typeof HistorySourceType>;

/** The two documents of a registered repository that are searchable. */
export const HISTORY_DOC_PATHS = ['docs/DECISIONS.md', 'docs/LESSONS.md'] as const;
export const HistoryDocPath = z.enum(HISTORY_DOC_PATHS);
export type HistoryDocPath = z.infer<typeof HistoryDocPath>;

export const HISTORY_QUERY_MAX_LENGTH = 400;
export const HISTORY_QUERY_MAX_TOKENS = 12;
export const HISTORY_SEARCH_DEFAULT_LIMIT = 10;
export const HISTORY_SEARCH_MAX_LIMIT = 50;
export const HISTORY_EXCERPT_MAX_CHARS = 600;
export const HISTORY_READ_DEFAULT_LINES = 80;
export const HISTORY_READ_MAX_LINES = 200;

const IsoWithZone = z.iso.datetime({ offset: true });

const searchFilterShape = {
  taskKey: TaskKey.optional(),
  sourceTypes: z.array(HistorySourceType).min(1).max(HISTORY_SOURCE_TYPES.length).optional(),
  since: IsoWithZone.optional(),
  until: IsoWithZone.optional(),
  limit: z.number().int().min(1).max(HISTORY_SEARCH_MAX_LIMIT).optional(),
};

function refineSearchFilters(
  input: { sourceTypes?: string[] | undefined; since?: string | undefined; until?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (input.sourceTypes && new Set(input.sourceTypes).size !== input.sourceTypes.length)
    ctx.addIssue({ code: 'custom', path: ['sourceTypes'], message: 'source types must be distinct' });
  if (input.since && input.until && Date.parse(input.since) > Date.parse(input.until))
    ctx.addIssue({ code: 'custom', path: ['since'], message: 'since must not be after until' });
}

/** What a search asks for; the project is a separate argument. */
export const HistorySearchInput = z
  .strictObject({
    query: z.string().trim().min(1).max(HISTORY_QUERY_MAX_LENGTH),
    ...searchFilterShape,
  })
  .superRefine(refineSearchFilters);
export type HistorySearchInput = z.infer<typeof HistorySearchInput>;

/** What a search was narrowed by: its input without the query (what the private measurement keeps, PM-787). */
export const HistorySearchFilters = z.strictObject(searchFilterShape).superRefine(refineSearchFilters);
export type HistorySearchFilters = z.infer<typeof HistorySearchFilters>;

/** The full read of one source. */
export const HistoryReadInput = z.strictObject({
  sourceId: z.string().min(1).max(200),
  fromLine: z.number().int().min(1).optional(),
  lineCount: z.number().int().min(1).max(HISTORY_READ_MAX_LINES).optional(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});
export type HistoryReadInput = z.infer<typeof HistoryReadInput>;

/** How a hit is read in full: the tool and its arguments, in the tool's own (snake_case) form. */
export const HistoryReference = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('get_task'),
    arguments: z.object({
      project_key: z.string(),
      task_key: TaskKey,
      event_id: z.string().optional(),
    }),
  }),
  z.object({
    tool: z.literal('read_history_source'),
    arguments: z.object({
      project_key: z.string(),
      source_id: z.string(),
      from_line: z.number().int().min(1).optional(),
      line_count: z.number().int().min(1).optional(),
      commit: z.string().optional(),
    }),
  }),
]);
export type HistoryReference = z.infer<typeof HistoryReference>;

/** How a hit got on the list (PM-767): by its words, by its meaning, or by both. */
const HISTORY_MATCH_TYPES = ['text', 'semantic', 'both'] as const;
const HistoryMatchType = z.enum(HISTORY_MATCH_TYPES);
type HistoryMatchType = z.infer<typeof HistoryMatchType>;

/**
 * How the semantic part of one search ended (PM-767), as the private search log keeps it. Never in a tool
 * reply: `not_run` is a search that did not ask the meaning (or an old record), `used` one that ran, and every
 * other value is the reason the search answered by its words only.
 */
export const HISTORY_SEMANTIC_STATUSES = [
  'not_run',
  'used',
  'disabled',
  'loading',
  'backfill',
  'unavailable',
  'busy',
  'timeout',
  'resource_limit',
  'error',
] as const;
export type HistorySemanticStatus = (typeof HISTORY_SEMANTIC_STATUSES)[number];

/** A hit never carries a relevance score, a count of hidden matches or an index identifier. */
export const HistoryHit = z.object({
  sourceId: z.string(),
  sourceType: HistorySourceType,
  taskKey: TaskKey.nullable(),
  author: z.string().nullable(),
  at: z.string(),
  excerpt: z.string(),
  reference: HistoryReference,
  /** A reply of an older build has none: it was a text match. The current server always sends it. */
  matchType: HistoryMatchType.default('text'),
  document: z
    .object({ repo: z.string(), path: HistoryDocPath, commit: z.string(), line: z.number().int().min(1) })
    .optional(),
});
export type HistoryHit = z.infer<typeof HistoryHit>;

const HISTORY_DOCUMENT_STATUSES = ['pending', 'ready', 'stale', 'unavailable', 'missing'] as const;
export const HistoryDocumentStatus = z.enum(HISTORY_DOCUMENT_STATUSES);
export type HistoryDocumentStatus = z.infer<typeof HistoryDocumentStatus>;

/** The state of one searchable document copy of a registered repository. */
export const HistoryDocumentState = z.object({
  repo: z.string(),
  path: HistoryDocPath,
  commit: z.string().nullable(),
  checkedAt: z.string().nullable(),
  indexedAt: z.string().nullable(),
  status: HistoryDocumentStatus,
});
export type HistoryDocumentState = z.infer<typeof HistoryDocumentState>;

export const HistorySearchResult = z.object({
  projectKey: z.string(),
  matches: z.array(HistoryHit),
  hasMore: z.boolean(),
  documents: z.array(HistoryDocumentState),
});
export type HistorySearchResult = z.infer<typeof HistorySearchResult>;

export const HistorySourceRead = z.object({
  projectKey: z.string(),
  sourceId: z.string(),
  sourceType: HistorySourceType,
  taskKey: TaskKey.nullable(),
  author: z.string().nullable(),
  at: z.string(),
  fromLine: z.number().int().min(1),
  totalLines: z.number().int().min(0),
  text: z.string(),
  document: z.object({ repo: z.string(), path: HistoryDocPath, commit: z.string() }).optional(),
});
export type HistorySourceRead = z.infer<typeof HistorySourceRead>;

/** A document snapshot of one repository: exactly the two paths; `null` text: the file is missing. */
export const HistoryDocumentSnapshot = z.strictObject({
  projectKey: z.string().min(1),
  repo: z.string().min(1),
  commit: z.string().min(1),
  checkedAt: z.iso.datetime({ offset: true }),
  files: z
    .array(z.strictObject({ path: HistoryDocPath, text: z.string().nullable() }))
    .length(HISTORY_DOC_PATHS.length)
    .refine((files) => new Set(files.map((file) => file.path)).size === files.length, {
      message: 'the two paths must differ',
    }),
});
export type HistoryDocumentSnapshot = z.infer<typeof HistoryDocumentSnapshot>;

/** Whoever searches: a current member of the project. `via` marks the integrator's bound access. */
export type HistoryViewer = TaskViewer & { via?: 'integrator' };

/** How long the private search log is kept (PM-787): a fixed value in code, not a setting. */
export const HISTORY_SEARCH_RETENTION_DAYS = 90;
export const HISTORY_STATS_DEFAULT_DAYS = 30;
export const HISTORY_STATS_DEFAULT_LIMIT = 50;
const HISTORY_STATS_MAX_LIMIT = 200;

/** Where the list of searches without a result continues: the key of its last entry, `(at, id)` descending. */
const HistoryStatsCursor = z.strictObject({ at: IsoWithZone, id: z.string().min(1).max(200) });
type HistoryStatsCursor = z.infer<typeof HistoryStatsCursor>;

/** What the statistics ask for; the project is a separate argument. */
export const HistoryStatsInput = z
  .strictObject({
    since: IsoWithZone.optional(),
    until: IsoWithZone.optional(),
    member: MemberHandle.optional(),
    limit: z.number().int().min(1).max(HISTORY_STATS_MAX_LIMIT).optional(),
    cursor: HistoryStatsCursor.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.since && input.until && Date.parse(input.since) > Date.parse(input.until))
      ctx.addIssue({ code: 'custom', path: ['since'], message: 'since must not be after until' });
  });
export type HistoryStatsInput = z.infer<typeof HistoryStatsInput>;

/** The statistics of the private search log: counts and the searches that found nothing (PM-787). */
export const HistorySearchStats = z.object({
  since: z.string(),
  until: z.string(),
  /** The oldest time the log still holds; older searches are deleted. */
  retainedSince: z.string(),
  /** The searches that ended with a result list (a zero result is one too). */
  totalSearches: z.number().int().min(0),
  /** The searches that failed on the server's side; they are in no other number. */
  failedSearches: z.number().int().min(0),
  byMember: z.array(
    z.object({
      member: z.string(),
      searches: z.number().int().min(0),
      zeroResultSearches: z.number().int().min(0),
    }),
  ),
  zeroResultCount: z.number().int().min(0),
  zeroResultRate: z.number().min(0).max(1),
  zeroResults: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      member: z.string(),
      query: z.string(),
      filters: HistorySearchFilters,
      via: z.literal('integrator').nullable(),
    }),
  ),
  nextCursor: HistoryStatsCursor.nullable(),
});
export type HistorySearchStats = z.infer<typeof HistorySearchStats>;

/**
 * Whether the viewer may read the private search statistics: a current owner or admin on their own request.
 * The integrator's bound access (`via`) never may, however the key is set; the adapter still checks the
 * session and the origin of the request.
 */
export function canSeeHistorySearchStats(viewer: HistoryViewer): boolean {
  return !viewer.via && (viewer.access === 'owner' || viewer.access === 'admin');
}

/** What a source contributes to the index and to a full read: a heading and a body. */
export interface HistoryText {
  title: string;
  body: string;
}

/** A source as the server reads it from the current project (never from an index copy). */
export type HistorySourceState =
  | { type: 'task'; task: Task }
  | { type: 'note'; task: Task; event: TimelineEvent }
  | { type: 'question'; item: InboxItem }
  | { type: 'message'; message: TeamMessage }
  | { type: 'document'; repo: string; path: HistoryDocPath; commit: string; text: string };

/** The current records a source refers to; a missing one hides the source. */
export interface HistoryRelated {
  taskOf: (key: string) => Task | null;
  eventOf: (id: string) => TimelineEvent | null;
  inboxOf: (id: string) => InboxItem | null;
}

const CLOSED_QUESTION_STATES: ReadonlySet<string> = new Set(['resolved', 'cancelled', 'expired']);

function noteTextOf(event: TimelineEvent): string {
  const text = event.data?.text;
  return typeof text === 'string' ? text : '';
}

/**
 * The question as its asker wrote it. A grouped question is its own original question; a client's
 * projection (`visibleQuestionItem`) blanks that and shows it as the item's title, so both give the
 * same text.
 */
function questionOf(item: InboxItem): string {
  const payload = questionPayloadOf(item);
  if (payload?.group) return payload.group.originalQuestion || item.title;
  return payload?.question || item.title;
}

function questionBodyOf(item: InboxItem): string {
  const payload = questionPayloadOf(item);
  const parts: string[] = [];
  if (item.body) parts.push(item.body);
  if (payload?.details) parts.push(payload.details);
  for (const option of item.options) {
    parts.push(option.consequence ? `${option.label}: ${option.consequence}` : option.label);
  }
  const chosen = item.resolution && item.options.find((option) => option.id === item.resolution!.optionId);
  if (chosen) parts.push(chosen.label);
  if (item.resolution?.note) parts.push(item.resolution.note);
  return parts.join('\n');
}

/** Whether the source has anything the index may hold (a closed question, a non-empty text). */
export function isHistoryIndexable(source: HistorySourceState): boolean {
  switch (source.type) {
    case 'task':
      return true;
    case 'note':
      return source.event.type === 'task_note' && noteTextOf(source.event).trim() !== '';
    case 'question':
      return (
        source.item.kind === 'question' &&
        CLOSED_QUESTION_STATES.has(source.item.state) &&
        questionPayloadOf(source.item) !== null
      );
    case 'message':
      return historySourceText(source).body.trim() !== '';
    case 'document':
      return source.text !== '';
  }
}

/**
 * The text of a source that is searched and read, and nothing else: no old description, no
 * attachments or transcript, no group sources, triage or request payloads.
 */
export function historySourceText(source: HistorySourceState): HistoryText {
  switch (source.type) {
    case 'task':
      return { title: source.task.title, body: source.task.description };
    case 'note':
      return { title: '', body: noteTextOf(source.event) };
    case 'question':
      return { title: questionOf(source.item), body: questionBodyOf(source.item) };
    case 'message': {
      const { message } = source;
      const parts = [message.body];
      if (message.answer) parts.push(message.answer.question, message.answer.answer);
      return { title: '', body: parts.filter((part) => part !== '').join('\n') };
    }
    case 'document':
      return { title: '', body: source.text };
  }
}

/** Who wrote a source, the card it belongs to and when (the stored metadata of its index copy). */
export function historySourceMeta(
  source: HistorySourceState,
  /** The inbox row's `updated_at` for a question without a resolution time; a document's `indexedAt`. */
  storedAt: string,
): { author: string | null; taskKey: string | null; at: string } {
  switch (source.type) {
    case 'task':
      return { author: source.task.createdBy, taskKey: source.task.key, at: source.task.updatedAt };
    case 'note': {
      const imported = source.event.data?.importedAuthor;
      return {
        author: typeof imported === 'string' ? imported : source.event.actor.handle,
        taskKey: source.event.taskKey,
        at: source.event.createdAt,
      };
    }
    case 'question':
      return {
        author: source.item.source,
        taskKey: source.item.taskKey,
        at: source.item.resolution?.at ?? storedAt,
      };
    case 'message':
      return { author: source.message.from, taskKey: source.message.taskKey, at: source.message.createdAt };
    case 'document':
      return { author: null, taskKey: null, at: storedAt };
  }
}

/** A reader of the project's current cards: a card that is gone is not there. */
function taskVisible(taskKey: string | null, related: HistoryRelated): Task | null {
  if (taskKey === null) return null;
  return related.taskOf(taskKey) ?? null;
}

function questionVisible(viewer: HistoryViewer, item: InboxItem, related: HistoryRelated): boolean {
  if (!canSeeInboxItem(viewer, item)) return false;
  return item.taskKey === null || taskVisible(item.taskKey, related) !== null;
}

/** A timeline event of a card that is still there. */
function timelineEventVisible(event: TimelineEvent, related: HistoryRelated): boolean {
  return event.taskKey !== null && taskVisible(event.taskKey, related) !== null;
}

function noteVisible(event: TimelineEvent, related: HistoryRelated): boolean {
  return event.type === 'task_note' && timelineEventVisible(event, related);
}

function messageVisible(viewer: HistoryViewer, message: TeamMessage, related: HistoryRelated): boolean {
  if (!canSeeTeamMessage(viewer, message)) return false;
  if (message.taskKey !== null && !taskVisible(message.taskKey, related)) return false;
  // A copy of a private question, answer or note is as private as its original.
  const inboxOk = (id: string) => {
    const item = related.inboxOf(id);
    return !!item && questionVisible(viewer, item, related);
  };
  if (message.answer && !inboxOk(message.answer.inboxItemId)) return false;
  const origin = message.origin;
  if (!origin) return true;
  switch (origin.kind) {
    case 'note':
    case 'label': {
      const eventId = origin.eventId;
      // A label origin without an event is the card's own label change: the task rule above covers it.
      if (eventId === undefined) return true;
      const event = related.eventOf(eventId);
      return !!event && timelineEventVisible(event, related);
    }
    case 'operator_knowledge_approval':
      return !viewer.via && inboxOk(origin.inboxItemId);
    case 'answer':
    case 'question_forward':
      return inboxOk(origin.inboxItemId);
  }
}

/**
 * The text of a source the viewer may read, or null. The one place that combines the existing rules
 * (`canSeeInboxItem`, `visibleQuestionItem`, `canSeeTeamMessage`, `visibleTimelineEvent`) for the history; the search and the full read both call it with the
 * source as it is now, so a change of access applies to the very next call.
 */
export function visibleHistorySource(
  viewer: HistoryViewer,
  source: HistorySourceState,
  related: HistoryRelated,
): HistoryText | null {
  switch (source.type) {
    case 'task':
      return historySourceText(source);
    case 'note': {
      if (!noteVisible(source.event, related)) return null;
      return historySourceText({ ...source, event: visibleTimelineEvent(viewer, source.event, () => null) });
    }
    case 'question': {
      if (!isHistoryIndexable(source) || !questionVisible(viewer, source.item, related)) return null;
      const shown = visibleQuestionItem(viewer, source.item, (key) => taskVisible(key, related) !== null);
      return historySourceText({ type: 'question', item: shown });
    }
    case 'message':
      return messageVisible(viewer, source.message, related) ? historySourceText(source) : null;
    case 'document':
      return historySourceText(source);
  }
}
