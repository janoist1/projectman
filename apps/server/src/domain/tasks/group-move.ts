import { groupPlacement, stageHandsOverForReview, subtasksMovingAlong } from '@projectman/shared';
import type {
  Actor,
  BoardGroupItem,
  BoardMoveRequest,
  BoardMoveResult,
  ProjectConfig,
  Stage,
  Task,
} from '@projectman/shared';
import { DomainError } from '../errors';
import type { BoardOrder } from './board-order';
import type { Handover, TaskMoves } from './moves';
import type { Effect, TaskStore } from './store';

type BlockedItem = Extract<BoardGroupItem, { outcome: 'blocked' }>;

/** What was read about a card before the unit of work (the one thing that needs an await). */
export type PreparedCard = { handover: Handover | null } | { blocked: BoardGroupItem };

/**
 * A collecting card dragged to another column with the subtasks that stand in its column (PM-121).
 * Every card goes through its own `TaskMoves.move` (its gates, approval request, `task_stage_changed`
 * event, expiring labels, rank), inside a unit of work of its own that nests in the caller's: a card the
 * rules refuse leaves nothing behind, and the others carry on. Whatever is not a business refusal
 * (a failing write) leaves the caller's unit of work and rolls everything back. This starts no work:
 * the stage-change events run after the commit, one per card, and the admission decides there.
 */
export class BoardGroupMove {
  private readonly store: TaskStore;
  private readonly moves: TaskMoves;
  private readonly order: BoardOrder;

  constructor(deps: { store: TaskStore; moves: TaskMoves; order: BoardOrder }) {
    this.store = deps.store;
    this.moves = deps.moves;
    this.order = deps.order;
  }

  /** The subtasks of `parent` that go along, from the current state (read in the running unit of work or before it). */
  along(config: ProjectConfig, parent: Task): Task[] {
    const children = this.store.ctx.repos.tasks
      .children(parent.projectKey, parent.key)
      .map((child) => this.store.view(child));
    return subtasksMovingAlong(config.pipeline.stages, parent, children);
  }

  /** Reads what the hand-over of each card into `target` needs; an uncommitted branch is that card's refusal. */
  async prepare(
    config: ProjectConfig,
    cards: readonly Task[],
    target: Stage,
  ): Promise<Map<string, PreparedCard>> {
    const prepared = new Map<string, PreparedCard>();
    for (const card of cards) {
      try {
        prepared.set(card.key, { handover: await this.moves.prepareHandover(config, card, target.id) });
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'handover_uncommitted') throw error;
        prepared.set(card.key, { blocked: blockedItem(card.key, error) });
      }
    }
    return prepared;
  }

  /**
   * Moves the collecting card, then its subtasks in their order, to `target` in the running unit of
   * work, the successful ones as one block at the dropped place (the collecting card first). Events and
   * listeners wait in `effects` for the commit; a card that did not move leaves no effect.
   */
  run(
    config: ProjectConfig,
    parent: Task,
    target: Stage,
    req: BoardMoveRequest,
    actor: Actor,
    prepared: ReadonlyMap<string, PreparedCard>,
    effects: Effect[],
  ): BoardMoveResult {
    const handsOver = stageHandsOverForReview(config, target);
    const along = this.along(config, parent);
    const items: BoardGroupItem[] = [];
    const reranked: string[] = [];
    // Subtasks that were going along when the person asked and are not any more.
    const alongNow = new Set(along.map((card) => card.key));
    for (const key of prepared.keys())
      if (key !== parent.key && !alongNow.has(key))
        items.push({ taskKey: key, outcome: 'skipped', reason: 'changed' });

    let previous: string | null = null;
    let parentMoved = false;
    for (const card of [parent, ...along]) {
      const cardPrepared = prepared.get(card.key);
      if (cardPrepared && 'blocked' in cardPrepared) {
        items.push(cardPrepared.blocked);
        continue;
      }
      // A subtask that came into the column since the request was read has no hand-over read for it.
      if (!cardPrepared && handsOver && card.key !== parent.key) {
        items.push({ taskKey: card.key, outcome: 'skipped', reason: 'changed' });
        continue;
      }
      const item = this.moveCard(
        config,
        card,
        target,
        req,
        actor,
        cardPrepared?.handover ?? null,
        previous,
        effects,
        reranked,
      );
      items.push(item);
      if (item.outcome === 'moved') {
        previous = card.key;
        if (card.key === parent.key) parentMoved = true;
      }
    }
    // The collecting card first, then its subtasks in their order; skipped ones last.
    const order = [parent.key, ...along.map((card) => card.key)];
    items.sort((a, b) => rankOf(order, a.taskKey) - rankOf(order, b.taskKey));
    return {
      task: this.store.get(parent.projectKey, parent.key),
      outcome: parentMoved
        ? 'moved'
        : items.some((item) => item.taskKey === parent.key && item.outcome === 'merging')
          ? 'merging'
          : 'unchanged',
      reranked,
      group: items,
    };
  }

  private moveCard(
    config: ProjectConfig,
    card: Task,
    target: Stage,
    req: BoardMoveRequest,
    actor: Actor,
    handover: Handover | null,
    previous: string | null,
    effects: Effect[],
    reranked: string[],
  ): BoardGroupItem {
    const cardEffects: Effect[] = [];
    try {
      const result = this.store.ctx.unitOfWork(() =>
        this.moves.move(config, card, target.id, actor, cardEffects, {
          handover,
          despitePrerequisites: req.despitePrerequisites,
          placement: groupPlacement(req.placement, previous),
        }),
      );
      if (result.moved) {
        effects.push(...cardEffects);
        reranked.push(card.key, ...(result.reranked ?? []));
        return { taskKey: card.key, outcome: 'moved' };
      }
      if (result.pendingApproval.length > 0)
        return {
          taskKey: card.key,
          outcome: 'approval_pending',
          inboxItemIds: result.pendingApproval.map((item) => item.id),
        };
      if (result.merging) {
        effects.push(...cardEffects);
        return { taskKey: card.key, outcome: 'merging', mergeId: result.merging.id };
      }
      return { taskKey: card.key, outcome: 'skipped', reason: 'changed' };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      if (error.code === 'gate_blocked') return blockedItem(card.key, error);
      if (error.code === 'task_closed') return { taskKey: card.key, outcome: 'skipped', reason: 'closed' };
      if (NO_APPROVER.has(error.code)) return noApproverItem(card.key, error);
      throw error;
    }
  }
}

/** The refusals of an approval request nobody may give: the holders authored the card, or nobody holds the label. */
const NO_APPROVER: ReadonlySet<string> = new Set([
  'self_review_forbidden',
  'release_four_eyes',
  'missing_duty_holder',
]);

function rankOf(order: readonly string[], key: string): number {
  const index = order.indexOf(key);
  return index < 0 ? order.length : index;
}

/** An approval nobody may give is that card's refusal: its label comes with no approvers. */
function noApproverItem(taskKey: string, error: DomainError): BlockedItem {
  const details = (error.details ?? {}) as { stageId?: string; label?: string };
  return {
    taskKey,
    outcome: 'blocked',
    code: 'no_approver',
    message: error.message,
    unmet: [],
    approvals:
      details.stageId && details.label
        ? [{ stageId: details.stageId, label: details.label, approvers: [] }]
        : [],
  };
}

/** The refusal of one card as its item: the gate's details are those `gateBlockedError` carries. */
function blockedItem(taskKey: string, error: DomainError): BlockedItem {
  const details = (error.details ?? {}) as Partial<Pick<BlockedItem, 'unmet' | 'approvals'>>;
  return {
    taskKey,
    outcome: 'blocked',
    code: error.code === 'handover_uncommitted' ? 'handover_uncommitted' : 'gate_blocked',
    message: error.message,
    unmet: details.unmet ?? [],
    approvals: details.approvals ?? [],
  };
}
