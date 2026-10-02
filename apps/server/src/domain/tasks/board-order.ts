import { isChronologicalColumn, planRanks, stagesOfColumn } from '@projectman/shared';
import type { BoardMoveResult, BoardPlacement, ProjectConfig, RankedCard, Task } from '@projectman/shared';
import { conflict } from '../errors';
import type { TaskStore } from './store';

/**
 * The manual order of the cards of a board column (PM-118). The rules are the shared ones
 * (`planRanks`); this reads the column, writes the ranks a plan asks for and publishes the cards whose
 * rank changed. Writing a rank touches neither `updatedAt` nor `closedAt`, and a rank is published
 * (like any change of a card) only once the unit of work commits.
 */
export class BoardOrder {
  private readonly store: TaskStore;

  constructor(store: TaskStore) {
    this.store = store;
  }

  /** A column ordered by closing time has no manual order and no rank to give. */
  chronological(config: ProjectConfig, columnId: string): boolean {
    return isChronologicalColumn(config.pipeline.stages, columnId);
  }

  /** The open cards standing in a column's stages (themes excluded), unordered. */
  cards(config: ProjectConfig, projectKey: string, columnId: string): RankedCard[] {
    const stageIds = stagesOfColumn(config.pipeline.stages, columnId).map((stage) => stage.id);
    return stageIds.length > 0 ? this.store.ctx.repos.tasks.boardCards(projectKey, stageIds) : [];
  }

  /**
   * Refuses a placement whose anchor is not an open card of the column now (or is the card itself):
   * the person decided by a picture that no longer holds (409 `board_stale`).
   */
  requireCurrent(config: ProjectConfig, task: Task, columnId: string, placement: BoardPlacement): void {
    if (placement.at === 'top' || placement.at === 'end') return;
    const open = this.cards(config, task.projectKey, columnId);
    if (placement.anchor === task.key || !open.some((card) => card.key === placement.anchor))
      throw conflict(
        'board_stale',
        `${placement.anchor} is not a card of the column ${columnId} any more: the board changed`,
        { reason: 'anchor', anchor: placement.anchor, columnId },
      );
  }

  /**
   * Where `task` takes its place in `columnId` (a column it is not in yet, or is created in): the rank
   * to write on the card, and the keys of the other cards written, when the column had to be numbered
   * afresh. No rank for a column ordered by closing time. A placement whose anchor is gone (an approval
   * that waited) falls back to the top of the column, deterministically.
   */
  enter(
    config: ProjectConfig,
    task: Pick<Task, 'projectKey' | 'key' | 'updatedAt'>,
    columnId: string,
    placement: BoardPlacement = { at: 'top' },
  ): { rank?: number; reranked: string[] } {
    if (this.chronological(config, columnId)) return { reranked: [] };
    const column = this.cards(config, task.projectKey, columnId).filter((card) => card.key !== task.key);
    const moving: RankedCard = { key: task.key, updatedAt: task.updatedAt };
    let plan = planRanks(column, moving, placement);
    if (plan.status !== 'planned') plan = planRanks(column, moving, { at: 'top' });
    if (plan.status !== 'planned') return { reranked: [] };
    const others = plan.ranks.filter((entry) => entry.key !== task.key);
    this.store.ctx.repos.tasks.setBoardRanks(task.projectKey, others);
    return {
      rank: plan.ranks.find((entry) => entry.key === task.key)?.rank,
      reranked: others.map((entry) => entry.key),
    };
  }

  /** Publishes the cards whose rank was written next to a change of another card. */
  publish(projectKey: string, keys: readonly string[]): void {
    for (const key of keys) {
      const task = this.store.find(projectKey, key);
      if (task) this.store.publish(task);
    }
  }

  /** A card dropped in its own column: only its place changes, nothing else of it. */
  reorder(config: ProjectConfig, task: Task, columnId: string, placement: BoardPlacement): BoardMoveResult {
    const plan = planRanks(this.cards(config, task.projectKey, columnId), task, placement);
    if (plan.status === 'stale')
      throw conflict('board_stale', `the anchor is not a card of the column ${columnId} any more`, {
        reason: 'anchor',
        columnId,
      });
    if (plan.status === 'unchanged') return { task, outcome: 'unchanged', reranked: [] };
    this.store.ctx.repos.tasks.setBoardRanks(task.projectKey, plan.ranks);
    const reranked = plan.ranks.map((entry) => entry.key);
    this.publish(task.projectKey, reranked);
    return { task: this.store.get(task.projectKey, task.key), outcome: 'reordered', reranked };
  }
}
