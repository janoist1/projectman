import { StageKind } from './pipeline';
import { Task, isOpenTask } from './task';

/** Moved here from apps/web/src/lib/taskState.ts, which re-exports it (one definition). */
export type TaskPhase =
  'needs_you' | 'stuck' | 'working' | 'waiting' | 'blocked' | 'ready' | 'done' | 'cancelled';
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
  // A card that stands on an outage (PM-468) waits; it is no "needs you" and no stale-blocked card.
  if (phase === 'stuck') return 'waiting';
  if (phase === 'waiting' || phase === 'ready') return stale ? 'blocked' : 'waiting';
  return phase;
}
