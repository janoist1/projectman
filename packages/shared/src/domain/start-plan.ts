import { compareBoardOrder } from './board-order';
import { developerLevelOf, pickDeveloper } from './developer-level';
import type { DeveloperCandidate } from './developer-level';
import { compareStartClass, startClass } from './project-focus';
import type { FocusPlace } from './project-focus';
import type { Task } from './task';

export { ReadyHoldReason, TaskReadyHold } from './ready-hold';

export type StartPlanEntry =
  | { kind: 'offer'; developer: string }
  | { kind: 'pull'; developer: string }
  | { kind: 'hold'; reason: 'no_free_member' | 'focus_order' }
  | { kind: 'hold'; reason: 'senior_busy'; seniors: string[] };

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

/** Start class, then priority, then the manual board order (PM-795 R4). */
export function compareStartOrder(a: Task, b: Task, places: ReadonlyMap<string, FocusPlace>): number {
  return (
    compareStartClass(startClass(a, places), startClass(b, places)) ||
    (a.priority ? PRIORITY_ORDER[a.priority] : 4) - (b.priority ? PRIORITY_ORDER[b.priority] : 4) ||
    compareBoardOrder(
      { key: a.key, rank: a.boardRank, updatedAt: a.updatedAt },
      { key: b.key, rank: b.boardRank, updatedAt: b.updatedAt },
    )
  );
}

/** Reserves at most one card per free developer; existing offers choose first. */
export function planStarts(input: {
  cards: readonly Task[];
  places: ReadonlyMap<string, FocusPlace>;
  free: readonly DeveloperCandidate[];
  seniors: readonly string[];
  anyDecided: ReadonlySet<string>;
  offered?: ReadonlySet<string>;
}): Map<string, StartPlanEntry> {
  const { cards, places, seniors, anyDecided, offered } = input;
  let free = [...input.free];
  const plan = new Map<string, StartPlanEntry>();
  // The assigned cards reserve their own developer first, so no other card takes the member they wait for.
  const ordered = [...cards].sort(
    (a, b) =>
      Number(!!b.assignee) - Number(!!a.assignee) ||
      Number(offered?.has(b.key) ?? false) - Number(offered?.has(a.key) ?? false) ||
      compareStartOrder(a, b, places),
  );
  for (const card of ordered) {
    // An assigned card is started by its assignee when the pm starts it with start_task (PM-879): it keeps that developer when
    // they are free, and waits for them otherwise. The pull assigns a developer itself, so it never takes it.
    if (card.assignee) {
      const own = free.find((member) => member.handle === card.assignee);
      if (own) {
        plan.set(card.key, { kind: 'offer', developer: own.handle });
        free = free.filter((member) => member !== own);
      }
      continue;
    }
    const choose = (candidates: readonly DeveloperCandidate[]) =>
      pickDeveloper({
        level: developerLevelOf(card),
        anyDecided: anyDecided.has(card.key),
        seniors: [...seniors],
        free: [...candidates],
      });
    const pick = choose(free);
    if (pick.kind === 'member') {
      plan.set(card.key, {
        kind: startClass(card, places).kind === 'other' ? 'offer' : 'pull',
        developer: pick.handle,
      });
      free = free.filter((member) => member.handle !== pick.handle);
    } else if (pick.kind === 'senior_busy') {
      plan.set(card.key, { kind: 'hold', reason: 'senior_busy', seniors: pick.seniors });
    } else {
      plan.set(card.key, {
        kind: 'hold',
        reason: choose(input.free).kind === 'member' ? 'focus_order' : 'no_free_member',
      });
    }
  }
  return plan;
}
