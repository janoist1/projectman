import { StageKind } from './pipeline';
import { Task, isOpenTask, taskSeq } from './task';

/** Moved here from apps/web/src/lib/taskState.ts, which re-exports it (one definition). */
export type TaskPhase = 'needs_you' | 'working' | 'waiting' | 'blocked' | 'ready' | 'done' | 'cancelled';
export type MapState = 'needs_you' | 'working' | 'waiting' | 'blocked' | 'done';

/** Urgency order: signals, cells, legend. */
export const MAP_STATE_ORDER: readonly MapState[] = ['needs_you', 'blocked', 'working', 'waiting', 'done'];
export const STALE_AFTER_MS = 86_400_000;

export type MapTask = Pick<
  Task,
  'key' | 'kind' | 'status' | 'stageId' | 'parentKey' | 'themeKey' | 'createdAt' | 'stageEnteredAt'
>;

/** stageKind: the kind of the card's stage (pipeline.ts StageKind); the web passes pipeline.stageById.get(task.stageId)?.kind. */
export function isStale(
  task: MapTask,
  phase: TaskPhase,
  stageKind: StageKind | undefined,
  now: number,
): boolean {
  if (!isOpenTask(task)) return false;
  if (stageKind === undefined || stageKind === 'queue') return false;
  if (phase !== 'waiting' && phase !== 'ready') return false;

  const enteredAt = task.stageEnteredAt ?? task.createdAt;
  const time = Date.parse(enteredAt);
  if (isNaN(time)) return false;
  return now - time >= STALE_AFTER_MS;
}

export function staleDays(task: MapTask, now: number): number {
  const enteredAt = task.stageEnteredAt ?? task.createdAt;
  const time = Date.parse(enteredAt);
  if (isNaN(time)) return 0;
  return Math.floor((now - time) / STALE_AFTER_MS);
}

export function mapStateOf(phase: TaskPhase, stale: boolean): MapState | null {
  if (phase === 'cancelled') return null;
  if (phase === 'waiting' || phase === 'ready') return stale ? 'blocked' : 'waiting';
  return phase;
}

export type MapGroupKind = 'theme' | 'collector' | 'other';
export const MAP_OTHER_GROUP_KEY = 'other';
export type MapLaneKind = 'collector' | 'loose' | 'parts' | 'other';

export interface MapSignals {
  needsYou: number;
  blocked: number;
  working: number;
  waiting: number;
  open: number;
}

export interface MapProgress {
  done: number;
  total: number;
  byStage: Record<string, number>;
}

export interface MapLane {
  kind: MapLaneKind;
  /** 'collector' and 'parts': the collecting card heading the lane; otherwise null. */
  collectorKey: string | null;
  /** The lane's non-cancelled cards by key number; the heading collector is not among them. */
  cardKeys: string[];
  open: number;
  done: number;
}

export interface MapGroup {
  kind: MapGroupKind;
  /** The theme's or the collecting card's key, or MAP_OTHER_GROUP_KEY. */
  key: string;
  /** Every non-cancelled card of the group, collecting cards included. */
  cardKeys: string[];
  lanes: MapLane[];
  /** Open cards by state; only the cards `counts` accepts. */
  signals: MapSignals;
  /** Every non-cancelled card of the group, unfiltered. */
  progress: MapProgress;
}

export interface WorkMapInput {
  /** The board's tasks as the viewer sees them, themes included. */
  tasks: readonly MapTask[];
  /** By key, for every non-theme card: from mapStateOf. */
  states: ReadonlyMap<string, MapState | null>;
  /** The member filter; absent: every card counts. */
  counts?: (key: string) => boolean;
}

function emptySignals(): MapSignals {
  return { needsYou: 0, blocked: 0, working: 0, waiting: 0, open: 0 };
}

function emptyProgress(): MapProgress {
  return { done: 0, total: 0, byStage: {} };
}

/** The groups in overview order. */
export function workMap(input: WorkMapInput): MapGroup[] {
  const tasksByKey = new Map<string, MapTask>();
  const parentToChildren = new Map<string, string[]>();
  const openThemes = new Set<string>();

  for (const t of input.tasks) {
    tasksByKey.set(t.key, t);
    if (t.kind === 'theme' && isOpenTask(t)) {
      openThemes.add(t.key);
    }
    if (t.kind !== 'theme' && t.status !== 'cancelled' && t.parentKey) {
      let children = parentToChildren.get(t.parentKey);
      if (!children) {
        children = [];
        parentToChildren.set(t.parentKey, children);
      }
      children.push(t.key);
    }
  }

  // Identify collector cards: not theme, has at least one non-cancelled child in tasks.
  const openCollectors = new Set<string>();
  for (const [parentKey, children] of parentToChildren.entries()) {
    const parent = tasksByKey.get(parentKey);
    if (parent && parent.kind !== 'theme' && children.length > 0) {
      if (isOpenTask(parent)) openCollectors.add(parentKey);
    }
  }

  // Groups map: key -> list of task keys belonging to this group
  // keys are theme keys, collector keys, or 'other'
  const groupCards = new Map<string, string[]>();

  // Ensure all open themes and collectors have a group, even if empty
  for (const tKey of openThemes) groupCards.set(tKey, []);
  for (const cKey of openCollectors) groupCards.set(cKey, []);

  // Assign cards to groups
  for (const t of input.tasks) {
    if (t.kind === 'theme' || t.status === 'cancelled') continue;

    let groupKey = MAP_OTHER_GROUP_KEY;
    if (t.themeKey && openThemes.has(t.themeKey)) {
      groupKey = t.themeKey;
    } else {
      const rootKey = t.parentKey && tasksByKey.has(t.parentKey) ? t.parentKey : t.key;
      if (openCollectors.has(rootKey)) {
        groupKey = rootKey;
      }
    }

    let cards = groupCards.get(groupKey);
    if (!cards) {
      cards = [];
      groupCards.set(groupKey, cards);
    }
    cards.push(t.key);
  }

  const groups: MapGroup[] = [];

  for (const [gKey, cards] of groupCards.entries()) {
    const isTheme = openThemes.has(gKey);
    const isCollector = openCollectors.has(gKey);

    const kind: MapGroupKind = isTheme ? 'theme' : isCollector ? 'collector' : 'other';

    // If other group is empty or has no open cards, drop it
    if (kind === 'other') {
      const hasOpen = cards.some((cKey) => {
        const t = tasksByKey.get(cKey);
        return t && isOpenTask(t);
      });
      if (!hasOpen) continue;
    }

    // Member filter
    if (input.counts) {
      const hasAccepted = cards.some((cKey) => input.counts!(cKey));
      if (!hasAccepted) continue;
    }

    const lanes: MapLane[] = [];
    const signals = emptySignals();
    const progress = emptyProgress();
    progress.total = cards.length;

    // Sort cards numerically
    cards.sort((a, b) => taskSeq(a) - taskSeq(b));

    if (isTheme) {
      const cardsSet = new Set(cards);
      const collectorLanes = new Map<string, string[]>();
      const looseCards: string[] = [];

      for (const cKey of cards) {
        if (openCollectors.has(cKey)) {
          // This card is a collector. Its children (if any) in the group should form a lane.
          const children = parentToChildren.get(cKey) || [];
          const groupChildren = children
            .filter((ch) => cardsSet.has(ch))
            .sort((a, b) => taskSeq(a) - taskSeq(b));
          if (groupChildren.length > 0) {
            collectorLanes.set(cKey, groupChildren);
          }
        }
      }

      // Collect all children in collector lanes to exclude them from loose
      const allLaneChildren = new Set<string>();
      for (const children of collectorLanes.values()) {
        for (const child of children) allLaneChildren.add(child);
      }

      for (const cKey of cards) {
        if (!allLaneChildren.has(cKey) && !collectorLanes.has(cKey)) {
          looseCards.push(cKey);
        }
      }

      // Maintain order for collectors: by seq.
      const collectorKeys = Array.from(collectorLanes.keys()).sort((a, b) => taskSeq(a) - taskSeq(b));
      for (const colKey of collectorKeys) {
        const laneCards = collectorLanes.get(colKey)!;
        lanes.push({
          kind: 'collector',
          collectorKey: colKey,
          cardKeys: laneCards,
          open: laneCards.filter((k) => isOpenTask(tasksByKey.get(k)!)).length,
          done: laneCards.filter((k) => tasksByKey.get(k)!.status === 'done').length,
        });
      }

      if (looseCards.length > 0) {
        lanes.push({
          kind: 'loose',
          collectorKey: null,
          cardKeys: looseCards,
          open: looseCards.filter((k) => isOpenTask(tasksByKey.get(k)!)).length,
          done: looseCards.filter((k) => tasksByKey.get(k)!.status === 'done').length,
        });
      }
    } else if (isCollector) {
      const parts = cards.filter((cKey) => cKey !== gKey);
      lanes.push({
        kind: 'parts',
        collectorKey: gKey,
        cardKeys: parts,
        open: parts.filter((k) => isOpenTask(tasksByKey.get(k)!)).length,
        done: parts.filter((k) => tasksByKey.get(k)!.status === 'done').length,
      });
    } else {
      lanes.push({
        kind: 'other',
        collectorKey: null,
        cardKeys: cards,
        open: cards.filter((k) => isOpenTask(tasksByKey.get(k)!)).length,
        done: cards.filter((k) => tasksByKey.get(k)!.status === 'done').length,
      });
    }

    for (const cKey of cards) {
      const t = tasksByKey.get(cKey)!;
      if (t.status === 'done') progress.done++;
      progress.byStage[t.stageId] = (progress.byStage[t.stageId] || 0) + 1;

      if (isOpenTask(t)) {
        if (!input.counts || input.counts(cKey)) {
          signals.open++;
          const state = input.states.get(cKey);
          if (state === 'needs_you') signals.needsYou++;
          else if (state === 'blocked') signals.blocked++;
          else if (state === 'working') signals.working++;
          else if (state === 'waiting') signals.waiting++;
        }
      }
    }

    groups.push({
      kind,
      key: gKey,
      cardKeys: cards,
      lanes,
      signals,
      progress,
    });
  }

  const levelOf = (s: MapSignals) => {
    if (s.needsYou > 0) return 0;
    if (s.blocked > 0) return 1;
    if (s.working > 0) return 2;
    return 3;
  };

  groups.sort((a, b) => {
    const la = levelOf(a.signals);
    const lb = levelOf(b.signals);
    if (la !== lb) return la - lb;

    if (a.kind === 'other' && b.kind !== 'other') return 1;
    if (a.kind !== 'other' && b.kind === 'other') return -1;

    if (a.signals.needsYou !== b.signals.needsYou) return b.signals.needsYou - a.signals.needsYou;
    if (a.signals.blocked !== b.signals.blocked) return b.signals.blocked - a.signals.blocked;
    if (a.signals.working !== b.signals.working) return b.signals.working - a.signals.working;

    return taskSeq(a.key) - taskSeq(b.key);
  });

  return groups;
}
