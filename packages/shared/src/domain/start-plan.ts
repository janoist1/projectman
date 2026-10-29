import { compareBoardOrder } from './board-order';
import type { ComplexityPoints } from './complexity';
import { chooseDeveloper, complexityOf, reachingDevelopers } from './choose-developer';
import type { FreeDeveloper, StageDeveloper } from './choose-developer';
import { PRIORITY_RANK, compareStartClass, effectivePriority, startClass } from './start-order';
import type { Task } from './task';

export { ReadyHoldReason, TaskReadyHold } from './ready-hold';

export type StartPlanEntry =
  | { kind: 'offer'; developer: string }
  | { kind: 'pull'; developer: string }
  | { kind: 'hold'; reason: 'no_free_member' }
  | { kind: 'hold'; reason: 'senior_busy'; seniors: string[] };

/**
 * Start class, then priority, then the manual board order (PM-795 R4). With `tasks` the priority is the
 * {@link effectivePriority} (the card's, its parent's or its theme's, the highest); without, the card's own.
 */
export function compareStartOrder(a: Task, b: Task, tasks?: readonly Task[]): number {
  const rank = (card: Task) => {
    const priority = tasks ? effectivePriority(card, tasks) : card.priority;
    return priority ? PRIORITY_RANK[priority] : 4;
  };
  return (
    compareStartClass(startClass(a, tasks), startClass(b, tasks)) ||
    rank(a) - rank(b) ||
    compareBoardOrder(
      { key: a.key, rank: a.boardRank, updatedAt: a.updatedAt },
      { key: b.key, rank: b.boardRank, updatedAt: b.updatedAt },
    )
  );
}

/** Reserves at most one card per free developer; existing offers choose first. */
export function planStarts(input: {
  cards: readonly Task[];
  free: readonly FreeDeveloper[];
  /** All the work stage's developers, free or not (see `stageDevelopers`). */
  developers: readonly StageDeveloper[];
  anyDecided: ReadonlySet<string>;
  /** The largest card a temp worker takes (`tempMaxPointsOf`). */
  tempMaxPoints: ComplexityPoints;
  offered?: ReadonlySet<string>;
  /**
   * The keys of the assigned cards whose assignee may be replaced because its provider is on hold and
   * the work has not begun (`canReplaceUnstartedAssignee`, PM-1051). They are planned like unassigned
   * cards, but only ever offered: the pull does not take an assigned card.
   */
  reassignableTaskKeys?: ReadonlySet<string>;
  /** The cards with their parents and themes (`startContext`): the priority they bring ranks a card (`effectivePriority`). */
  tasks?: readonly Task[];
}): Map<string, StartPlanEntry> {
  const { cards, developers, anyDecided, offered, tasks } = input;
  const reassignable = input.reassignableTaskKeys ?? new Set<string>();
  const keeps = (card: Task) => !!card.assignee && !reassignable.has(card.key);
  let free = [...input.free];
  const plan = new Map<string, StartPlanEntry>();
  // The assigned cards reserve their own developer first, so no other card takes the member they wait for.
  const ordered = [...cards].sort(
    (a, b) =>
      Number(keeps(b)) - Number(keeps(a)) ||
      Number(offered?.has(b.key) ?? false) - Number(offered?.has(a.key) ?? false) ||
      compareStartOrder(a, b, tasks),
  );
  for (const card of ordered) {
    // An assigned card is started by its assignee when the pm starts it with start_task (PM-879): it keeps that developer when
    // they are free, and waits for them otherwise. The pull assigns a developer itself, so it never takes it.
    if (keeps(card)) {
      const own = free.find((member) => member.handle === card.assignee);
      if (own) {
        plan.set(card.key, { kind: 'offer', developer: own.handle });
        free = free.filter((member) => member !== own);
      }
      continue;
    }
    const points = complexityOf(card);
    const reaching = reachingDevelopers(developers, points, card.labels);
    const pick = chooseDeveloper({
      points,
      labels: card.labels,
      anyDecided: anyDecided.has(card.key),
      reaching,
      free,
      tempMaxPoints: input.tempMaxPoints,
    });
    if (pick.kind === 'member') {
      plan.set(card.key, {
        kind: card.assignee || startClass(card, tasks).kind === 'other' ? 'offer' : 'pull',
        developer: pick.handle,
      });
      free = free.filter((member) => member.handle !== pick.handle);
    } else if (pick.kind === 'senior_busy') {
      plan.set(card.key, { kind: 'hold', reason: 'senior_busy', seniors: pick.seniors });
    } else {
      plan.set(card.key, { kind: 'hold', reason: 'no_free_member' });
    }
  }
  return plan;
}
