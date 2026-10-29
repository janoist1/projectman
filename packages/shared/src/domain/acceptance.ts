import { z } from 'zod';
import { stepResult } from '../config/gates';
import type { ProjectConfig } from '../config/schema';
import type { Actor } from './event';
import { ITEM_STATES } from './item-state';
import { MemberHandle } from './member';
import { isOpenTask, isTheme, TaskKey } from './task';
import type { Task } from './task';

/**
 * Acceptance items: the conditions of a card as items. The assignee (or a person) marks each one with its
 * evidence, the owner of the card's current step (or a person) confirms each one, never the marker or the
 * assignee. Two system labels follow the items and the pipeline's gates hold on them. A card without items is
 * not touched by any of it.
 */
export const MAX_ACCEPTANCE_ITEMS = 40;
/** Operations one update may carry. */
export const MAX_ACCEPTANCE_CHANGES = 20;

export const AcceptanceItemId = z.string().regex(/^acc_[a-z0-9]{10,32}$/);
export type AcceptanceItemId = z.infer<typeof AcceptanceItemId>;

export const AcceptanceItem = z
  .object({
    id: AcceptanceItemId,
    position: z.number().int().nonnegative(),
    text: z.string().min(1).max(500),
    state: z.enum(ITEM_STATES),
    /** `done`: a commit, a test, a screenshot, a file and line. */
    evidence: z.string().min(1).max(2000).nullable(),
    /** `not_needed`: why. */
    reason: z.string().min(1).max(1000).nullable(),
    /** `moved`: the card that took the item over. */
    movedTo: TaskKey.nullable(),
    /** The item this one was moved here from. */
    origin: z.object({ taskKey: TaskKey, itemId: AcceptanceItemId }).nullable(),
    markedBy: MemberHandle.nullable(),
    markedAt: z.string().nullable(),
    confirmedBy: MemberHandle.nullable(),
    confirmedAt: z.string().nullable(),
    createdBy: MemberHandle.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .superRefine((item, ctx) => {
    if (item.state === 'done' && !item.evidence)
      ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'A done item needs evidence' });
    if (item.state === 'not_needed' && !item.reason)
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A not needed item needs a reason' });
    if (item.state === 'moved' && !item.movedTo)
      ctx.addIssue({ code: 'custom', path: ['movedTo'], message: 'A moved item needs the card it moved to' });
  });
export type AcceptanceItem = z.infer<typeof AcceptanceItem>;

const text = z.string().min(1).max(500);
export const AcceptanceChange = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), text }),
  z.object({ op: z.literal('edit'), itemId: AcceptanceItemId, text }),
  z.object({ op: z.literal('remove'), itemId: AcceptanceItemId }),
  z.object({ op: z.literal('done'), itemId: AcceptanceItemId, evidence: z.string().min(1).max(2000) }),
  z.object({ op: z.literal('not_needed'), itemId: AcceptanceItemId, reason: z.string().min(1).max(1000) }),
  z.object({ op: z.literal('move'), itemId: AcceptanceItemId, taskKey: TaskKey }),
  z.object({
    op: z.literal('reopen'),
    itemId: AcceptanceItemId,
    note: z.string().min(1).max(1000).optional(),
  }),
  z.object({ op: z.literal('confirm'), itemId: AcceptanceItemId }),
]);
export type AcceptanceChange = z.infer<typeof AcceptanceChange>;

/** Why an acceptance change is refused (`acceptance_item_refused.details.reason`). */
export type AcceptanceRefusal =
  | 'card_closed'
  | 'too_many'
  | 'not_open'
  | 'remove_after_start'
  | 'not_marker'
  | 'not_settled'
  | 'not_confirmer'
  | 'own_work'
  | 'move_target';

/**
 * Whether the item is settled but nobody confirmed it. A `reopen` clears the marker and the confirmation, and
 * every new mark clears the confirmation, so a confirmed item is always one that stands as confirmed.
 */
const isUnconfirmed = (item: Pick<AcceptanceItem, 'state' | 'confirmedBy'>): boolean =>
  item.state === 'open' || item.confirmedBy === null;

/**
 * The two labels the items call for: `open` while an item is open; `unconfirmed` while an item is open or
 * settled without a confirmation. A card without items has neither.
 */
export function acceptanceLabels(items: readonly Pick<AcceptanceItem, 'state' | 'confirmedBy'>[]): {
  open: boolean;
  unconfirmed: boolean;
} {
  return {
    open: items.some((item) => item.state === 'open'),
    unconfirmed: items.some(isUnconfirmed),
  };
}

/** Whether the work stage is already behind (or under) the card. */
function workStarted(config: ProjectConfig, task: Pick<Task, 'stageId'>): boolean {
  const stages = config.pipeline.stages;
  const work = stages.findIndex((stage) => stage.kind === 'work');
  const at = stages.findIndex((stage) => stage.id === task.stageId);
  return work >= 0 && at >= work;
}

/**
 * Why the actor may not make this change to the card's acceptance items; null: it is allowed. The one place
 * that holds the rights: the server and the web's test fake both ask it. A theme is refused before (themeRefused).
 */
export function acceptanceRefusal(input: {
  config: ProjectConfig;
  task: Task;
  item: AcceptanceItem | undefined;
  count: number;
  change: AcceptanceChange;
  actor: Pick<Actor, 'kind' | 'handle'>;
  target?: Pick<Task, 'key' | 'projectKey' | 'status' | 'kind'> | null;
}): AcceptanceRefusal | null {
  const { config, task, item, count, change, actor, target } = input;
  if (!isOpenTask(task)) return 'card_closed';
  const human = actor.kind === 'human';
  const assignee = actor.handle !== null && actor.handle === task.assignee;
  switch (change.op) {
    case 'add':
      return count >= MAX_ACCEPTANCE_ITEMS ? 'too_many' : null;
    case 'edit':
      return item?.state === 'open' ? null : 'not_open';
    case 'remove':
      return human || !workStarted(config, task) ? null : 'remove_after_start';
    case 'done':
    case 'not_needed':
      return human || assignee ? null : 'not_marker';
    case 'move':
      if (!human && !assignee) return 'not_marker';
      return target &&
        target.key !== task.key &&
        target.projectKey === task.projectKey &&
        isOpenTask(target) &&
        !isTheme(target)
        ? null
        : 'move_target';
    case 'reopen':
      return human || assignee || canConfirm(config, task, actor) ? null : 'not_marker';
    case 'confirm':
      if (!human && !canConfirm(config, task, actor)) return 'not_confirmer';
      if (actor.handle !== null && (actor.handle === item?.markedBy || actor.handle === task.assignee))
        return 'own_work';
      return item && item.state !== 'open' ? null : 'not_settled';
  }
}

/** Whether the AI actor owns the card's current step: it sets one of the labels the next gate asks. */
function canConfirm(config: ProjectConfig, task: Task, actor: Pick<Actor, 'kind' | 'handle'>): boolean {
  return actor.handle !== null && stepResult(config, task, actor.handle) !== null;
}
