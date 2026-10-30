import { cardStepOutcome } from '@projectman/shared';
import type { BoardColumnColor, Stage, Task, TimelineEvent } from '@projectman/shared';
import { labelName } from './labels';
import { describeEvent } from './timeline';
import type { TimelineContext } from './timeline';

/** A round's rows shown at first: the older ones open in place. */
export const STORY_ROW_LIMIT = 30;

export type StoryView = 'essence' | 'all';

/** How a round ended: the card went on, came back, moved somewhere that cannot be ordered, closed, or is still there. */
export type RoundOutcome =
  | { kind: 'running' }
  | { kind: 'closed'; cancelled: boolean }
  | { kind: 'forward' | 'back' | 'moved'; stageId: string };

/** One stay of the card in a stage (PM-1160): cut by the stage moves, oldest event first. */
export interface StoryRound {
  /** The id of the round's first event. */
  key: string;
  /** Null: a theme's single round, which has no stage. */
  stageId: string | null;
  stageName: string;
  /** The pipeline column's colour; null for a stage the pipeline no longer has. */
  color: BoardColumnColor | null;
  /** 1-based, among the rounds of the same stage. */
  number: number;
  /** The stage has more than one round: the number is shown. */
  numbered: boolean;
  events: TimelineEvent[];
  /** Handles of the people and AI members who wrote an event, first seen first; empty: only the system did. */
  actors: string[];
  start: string;
  /** The next round's start; null: the card is still here. */
  end: string | null;
  outcome: RoundOutcome;
  /** Events before the loaded window are missing from the round: only its stage and label steps are known. */
  partial: boolean;
  /** The event that sums the round up and its text; null: nothing of note happened. */
  summary: string | null;
}

export interface CardStory {
  /** Oldest first. */
  rounds: StoryRound[];
  /** A card with nothing yet but its creation. */
  first: boolean;
}

export type StoryRow = { kind: 'event'; event: TimelineEvent } | { kind: 'noise'; events: TimelineEvent[] };

/** Events that always matter, whatever their data. */
const ESSENCE_TYPES: ReadonlySet<string> = new Set([
  'task_created',
  'task_note',
  'team_message',
  'question_asked',
  'question_answered',
  'question_closed',
  'question_recipient_escalated',
  'fix_limit_recipient_escalated',
  'task_assigned',
  'task_hand_on_requested',
  'task_handoff',
  'attachment_added',
  'attachment_deleted',
  'acceptance_item_changed',
  'task_merge_requested',
  'task_merged',
  'task_merge_failed',
  'task_merge_blocked',
  'feedback_linked',
  'host_request_opened',
  'host_request_answered',
]);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const addedLabels = (event: TimelineEvent): string[] =>
  Array.isArray(event.data.added)
    ? event.data.added.filter((id): id is string => typeof id === 'string')
    : [];

/** Whether the label is one of a group (a result label such as a review's verdict); the group comes from the project's labels. */
const isResultLabel = (id: string, ctx: Pick<TimelineContext, 'labels'>): boolean =>
  Boolean(ctx.labels?.find((label) => label.id === id)?.group);

/** Whether an event is listed at all: a session restart is no event of the card. */
export function isListedEvent(event: TimelineEvent): boolean {
  return !(event.type === 'session_ended' && record(event.data.stop)?.kind === 'restart');
}

/**
 * Whether an event is the essence of the story or noise that folds away. A closed list: a type this
 * web app does not know is noise, but it is still listed.
 */
export function storyWeight(event: TimelineEvent, ctx: Pick<TimelineContext, 'labels'>): 'essence' | 'noise' {
  const { data, type } = event;
  // The automatic notice to a member (a card moved into their stage) is the system talking, not a message.
  if (type === 'team_message' && event.actor.kind === 'system') return 'noise';
  if (ESSENCE_TYPES.has(type)) return 'essence';
  if (
    type === 'task_labels_changed' &&
    (data.noteExcerpt || addedLabels(event).some((id) => isResultLabel(id, ctx)))
  )
    return 'essence';
  if (
    type === 'task_stage_changed' &&
    (data.noteExcerpt || data.testsFailed || data.branchMoved || data.partsClosed || data.pulled)
  )
    return 'essence';
  if (type === 'task_updated' && data.action) return 'essence';
  const outcome = cardStepOutcome(event);
  return outcome === 'failed' || outcome === 'handed_over' ? 'essence' : 'noise';
}

const firstLine = (value: string): string => value.trim().split('\n')[0] ?? '';

/** The round's deciding event as a line, first match of: result label, closing move's note, last note, failed step, last essence. */
function summaryOf(events: readonly TimelineEvent[], closing: TimelineEvent | null, ctx: TimelineContext) {
  const lastWhere = (test: (event: TimelineEvent) => boolean) => events.findLast(test);
  const result = lastWhere(
    (event) =>
      event.type === 'task_labels_changed' && addedLabels(event).some((id) => isResultLabel(id, ctx)),
  );
  if (result) {
    const names = addedLabels(result)
      .filter((id) => isResultLabel(id, ctx))
      .map((id) => labelName(id, ctx.labels ?? []))
      .join(', ');
    const note = firstLine(text(result.data.noteExcerpt));
    return note ? `${names}: ${note}` : names;
  }
  const closingNote = firstLine(text(closing?.data.noteExcerpt));
  if (closingNote) return closingNote;
  const note = lastWhere(
    (event) =>
      (event.type === 'task_note' && text(event.data.text).trim() !== '') || Boolean(event.data.noteExcerpt),
  );
  if (note) return firstLine(text(note.type === 'task_note' ? note.data.text : note.data.noteExcerpt));
  const step = lastWhere((event) => {
    const outcome = cardStepOutcome(event);
    return outcome === 'failed' || outcome === 'handed_over';
  });
  const essence =
    step ?? lastWhere((event) => event.type !== 'task_created' && storyWeight(event, ctx) === 'essence');
  return essence ? firstLine(describeEvent(essence, ctx).text) : null;
}

/** The card's story (PM-1160): the events cut into rounds at the stage moves, from the pipeline's own order and kinds. */
export function buildCardStory({
  task,
  events,
  earlierEvents = [],
  theme = false,
  ctx,
}: {
  task: Pick<Task, 'stageId' | 'status'>;
  events: readonly TimelineEvent[];
  earlierEvents?: readonly TimelineEvent[];
  theme?: boolean;
  ctx: TimelineContext;
}): CardStory {
  const earlierIds = new Set(earlierEvents.map((event) => event.id));
  const seen = new Set<string>();
  const all = [...earlierEvents, ...events]
    .filter((event) => isListedEvent(event) && !seen.has(event.id) && seen.add(event.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const created = all.some((event) => event.type === 'task_created');
  const pipeline = ctx.pipeline;
  const groups: Array<{ stageId: string | null; events: TimelineEvent[] }> = [];
  if (theme) groups.push({ stageId: null, events: all });
  else {
    const firstMove = all.find((event) => event.type === 'task_stage_changed');
    let stageId = text(firstMove?.data.from) || task.stageId;
    let current = { stageId: stageId as string | null, events: [] as TimelineEvent[] };
    groups.push(current);
    for (const event of all) {
      if (event.type === 'task_stage_changed' && text(event.data.to) && text(event.data.to) !== stageId) {
        stageId = text(event.data.to);
        current = { stageId, events: [] };
        groups.push(current);
      }
      current.events.push(event);
    }
  }
  const stageOf = (id: string | null): Stage | undefined => (id ? pipeline?.stageById.get(id) : undefined);
  const counts = new Map<string | null, number>();
  const rounds = groups
    .filter((group) => group.events.length > 0)
    .map((group, index, list): StoryRound => {
      const next = list[index + 1];
      const number = (counts.get(group.stageId) ?? 0) + 1;
      counts.set(group.stageId, number);
      const stage = stageOf(group.stageId);
      const from = pipeline?.stageIndex.get(group.stageId ?? '');
      const to = pipeline?.stageIndex.get(next?.stageId ?? '');
      const outcome: RoundOutcome = next
        ? {
            kind:
              from === undefined || to === undefined || from === to
                ? 'moved'
                : to > from
                  ? 'forward'
                  : 'back',
            stageId: next.stageId ?? '',
          }
        : task.status === 'done' || task.status === 'cancelled'
          ? { kind: 'closed', cancelled: task.status === 'cancelled' }
          : { kind: 'running' };
      const actors = [
        ...new Set(
          group.events.flatMap((event) =>
            event.actor.kind !== 'system' && event.actor.handle ? [event.actor.handle] : [],
          ),
        ),
      ];
      return {
        key: group.events[0]!.id,
        stageId: group.stageId,
        stageName: stage?.name ?? group.stageId ?? '',
        color: (group.stageId ? pipeline?.columnOfStage.get(group.stageId)?.color : null) ?? null,
        number,
        numbered: false,
        events: group.events,
        actors,
        start: group.events[0]!.createdAt,
        end: next?.events[0]?.createdAt ?? null,
        outcome,
        partial: !created && (index === 0 || group.events.some((event) => earlierIds.has(event.id))),
        summary: summaryOf(group.events, next?.events[0] ?? null, ctx),
      };
    });
  for (const round of rounds) round.numbered = (counts.get(round.stageId) ?? 0) > 1;
  const first =
    rounds.length <= 1 &&
    !rounds.some((round) =>
      round.events.some((event) => event.type !== 'task_created' && storyWeight(event, ctx) === 'essence'),
    );
  return { rounds, first };
}

/** The rows of a round in a view: all events, or the essence with the noise between folded into runs. */
export function roundRows(
  round: StoryRound,
  view: StoryView,
  ctx: Pick<TimelineContext, 'labels'>,
): StoryRow[] {
  const rows: StoryRow[] = [];
  for (const event of round.events) {
    const last = rows.at(-1);
    if (view === 'essence' && storyWeight(event, ctx) === 'noise') {
      if (last?.kind === 'noise') last.events.push(event);
      else rows.push({ kind: 'noise', events: [event] });
    } else rows.push({ kind: 'event', event });
  }
  return rows;
}

/** Where an event is on the page, to open what hides it: its round, whether it hides in a noise run or behind "Korábbiak". */
export function locateEvent(
  story: CardStory,
  id: string,
  view: StoryView,
  ctx: Pick<TimelineContext, 'labels'>,
): { roundKey: string; noise: boolean; earlier: boolean } | null {
  for (const round of story.rounds) {
    const rows = roundRows(round, view, ctx);
    const index = rows.findIndex((row) =>
      row.kind === 'event' ? row.event.id === id : row.events.some((event) => event.id === id),
    );
    if (index < 0) continue;
    return {
      roundKey: round.key,
      noise: rows[index]!.kind === 'noise',
      earlier: index < rows.length - STORY_ROW_LIMIT,
    };
  }
  return null;
}
