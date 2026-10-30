import { z } from 'zod';
import type { TimelineEvent } from './event';
import type { InboxItem } from './inbox';
import { canSeeInboxItem, isInformationalAlert } from './inbox';
import { MemberHandle } from './member';
import type { MemberQueueItem } from './member-queue';
import { canSeeAllTeamMessages } from './message';
import type { Obligation } from './obligation';
import type { TaskStartWaiting, TaskViewer } from './task';

/**
 * The open system steps of a card (PM-1151), read from the mechanisms that already hold them: an
 * obligation, a member queue item, a waiting start and an open human item. One pure mapping, used by the
 * server (`TaskDetail.steps`) and by the web's test fake. It stores nothing and carries no message text.
 */

const CardStepSource = z.enum(['obligation', 'queue', 'start', 'inbox']);

const CardStepState = z.enum(['waiting', 'running', 'reminded', 'handed_over']);
type CardStepState = z.infer<typeof CardStepState>;

export const CardStep = z.object({
  source: CardStepSource,
  /** The mechanism's own kind: ObligationKind, MemberQueueItemKind, 'start', InboxKind. */
  kind: z.string(),
  /** Who acts; null: the system or nobody. */
  holder: MemberHandle.nullable(),
  state: CardStepState,
  since: z.string(),
  dueAt: z.string().nullable(),
  /**
   * Why it stands: `startWaiting.reason`, the queue item's wait code or the obligation's pause reason.
   * Never a raw error text.
   */
  waitCode: z.string().nullable(),
  /** The number of the attempt the step is at (the first is 1); null: the mechanism has no attempts. */
  attempts: z.number().int().nonnegative().nullable(),
  /** The row shown: the obligation id, the queue item id or the inbox item id. */
  ref: z.string().nullable(),
});
export type CardStep = z.infer<typeof CardStep>;

export interface CardStepsInput {
  /** The card's open and handed-over obligations. */
  obligations: readonly Obligation[];
  /** The card's open (queued or processing) queue items. */
  queueItems: readonly MemberQueueItem[];
  startWaiting: TaskStartWaiting | null;
  /** The card's pending inbox items the viewer may see. */
  openItems: readonly InboxItem[];
  /** The viewer: an item assigned to them names them as its holder; absent: the first assignee. */
  viewer?: string | null;
}

/**
 * What of the card's steps the viewer may see, by the rules of the places they come from: an inbox item
 * by `canSeeInboxItem`, a queued team message only to its parties and to those who see every message.
 * Everything else on the card is open to every member, a client included.
 */
export function visibleCardStepsInput(
  viewer: TaskViewer & { via?: 'integrator' },
  input: CardStepsInput,
): CardStepsInput {
  return {
    ...input,
    queueItems: input.queueItems.filter(
      (item) =>
        item.kind !== 'message' ||
        canSeeAllTeamMessages(viewer) ||
        item.member === viewer.handle ||
        item.from === viewer.handle,
    ),
    openItems: input.openItems.filter((item) => canSeeInboxItem(viewer, item)),
  };
}

/** The most urgent first: what went to a person, what was reminded, what runs, what waits. */
const STATE_ORDER: Record<CardStepState, number> = { handed_over: 0, reminded: 1, running: 2, waiting: 3 };

/** The card's open steps, in the order they are shown: by state, then the oldest first. */
export function cardSteps(input: CardStepsInput): CardStep[] {
  // The todo an obligation was handed over as is the same step: shown once, as the obligation.
  const handedTodos = new Set(input.obligations.flatMap((row) => (row.inboxItemId ? [row.inboxItemId] : [])));
  const steps: CardStep[] = [
    ...input.obligations
      .filter((row) => row.state === 'open' || row.state === 'handed_over')
      .map((row): CardStep => ({
        source: 'obligation',
        kind: row.kind,
        holder: row.responsible,
        state: row.state === 'handed_over' ? 'handed_over' : row.wokenAt ? 'reminded' : 'waiting',
        since: row.openedAt,
        dueAt: row.dueAt,
        waitCode: row.pauseReason,
        attempts: null,
        ref: row.id,
      })),
    ...input.queueItems
      .filter((item) => item.state === 'queued' || item.state === 'processing')
      .map((item): CardStep => ({
        source: 'queue',
        kind: item.kind,
        holder: item.member,
        state: item.state === 'processing' ? 'running' : 'waiting',
        since: item.state === 'processing' ? (item.startedAt ?? item.queuedAt) : item.queuedAt,
        dueAt: null,
        waitCode: item.state === 'queued' ? (item.wait?.code ?? null) : null,
        attempts: item.attempts + 1,
        ref: item.id,
      })),
    ...(input.startWaiting
      ? [
          {
            source: 'start',
            kind: 'start',
            holder: null,
            state: 'waiting',
            since: input.startWaiting.since,
            dueAt: null,
            waitCode: input.startWaiting.reason,
            attempts: null,
            ref: null,
          } satisfies CardStep,
        ]
      : []),
    ...input.openItems
      .filter(
        (item) =>
          (item.state === 'open' || item.state === 'screening') &&
          !handedTodos.has(item.id) &&
          !isInformationalAlert(item) &&
          item.payload.groupWithdrawn !== true,
      )
      .map((item): CardStep => ({
        source: 'inbox',
        kind: item.kind,
        holder:
          (input.viewer && item.assignees.includes(input.viewer) ? input.viewer : item.assignees[0]) ?? null,
        state: 'waiting',
        since: item.createdAt,
        dueAt: null,
        waitCode: null,
        attempts: null,
        ref: item.id,
      })),
  ];
  return steps.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.since.localeCompare(b.since));
}

export type CardStepOutcome = 'ran' | 'failed' | 'handed_over';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * How a system step ended: it ran, it failed, or it went to a person. Null: an event that is no step
 * (an older or unknown type) or whose ending is neutral; it is still listed, with no mark.
 */
export function cardStepOutcome(event: Pick<TimelineEvent, 'type' | 'data'>): CardStepOutcome | null {
  const { data } = event;
  switch (event.type) {
    case 'refinement_turn':
      return text(data.reason) === 'stopped' ? 'failed' : 'ran';
    case 'obligation_woken':
    case 'task_merge_requested':
    case 'task_merged':
      return 'ran';
    case 'obligation_handed_over':
      return 'handed_over';
    case 'task_full_test':
      return text(data.outcome) === 'passed' ? 'ran' : 'failed';
    case 'task_merge_failed':
    case 'task_merge_blocked':
      return 'failed';
    case 'task_handoff':
      return text(data.phase) === 'cancelled' ? 'failed' : 'ran';
    case 'task_senior_wait':
      return text(data.phase) === 'no_senior'
        ? 'failed'
        : text(data.phase) === 'asked'
          ? 'handed_over'
          : 'ran';
    case 'task_fix_limit':
      return text(data.phase) === 'reached'
        ? 'failed'
        : text(data.phase) === 'passed_on'
          ? 'handed_over'
          : 'ran';
    case 'task_loop':
      return text(data.phase) === 'raised'
        ? 'failed'
        : text(data.phase) === 'escalated'
          ? 'handed_over'
          : 'ran';
    case 'question_screened':
      return text(data.outcome) === 'forwarded' ? 'handed_over' : 'ran';
    case 'member_queue_item_closed': {
      const reason = text(data.reason);
      if (reason === 'attempts_exhausted') return 'failed';
      if (reason === 'handed_off') return 'handed_over';
      return reason === 'delivered' || reason === 'resolved' || reason === 'finished' || reason === 'started'
        ? 'ran'
        : null;
    }
    default:
      return null;
  }
}
