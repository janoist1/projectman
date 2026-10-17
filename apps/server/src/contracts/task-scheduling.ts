import type { Task, TimelineEvent } from '@projectman/shared';

/**
 * What a periodic or startup scheduler may ask of the task store (PM-770). Every query is bounded by what
 * it names: there is no "every card" default, and history that is closed and not named is never read.
 *
 * - `keys`: exactly these cards, closed ones too.
 * - `focus`: these focus roots (closed ones too) and the open cards open roots cover (`projectFocusPlaces`):
 *   a card root's subtasks; a theme root's cards and their subtasks, with the theme read from the parent.
 * - `pull`: the active, unassigned `task` cards of this stage that are urgent or in `focusedKeys`.
 * - `children`: the direct subtasks of these cards (open ones, closed too with `includeClosed`).
 * - `open`: every card that is not done or cancelled, themes included.
 * - `closed-worktrees`: done or cancelled `task` cards closed at or before `closedBefore` (a UTC ISO time),
 *   a page of at most `limit` (1-500, default 100) by number, after `afterSeq` (default 0).
 */
export type TaskSchedulingQuery =
  | { kind: 'keys'; keys: readonly string[] }
  | { kind: 'focus'; keys: readonly string[] }
  | { kind: 'pull'; stageId: string; focusedKeys: readonly string[] }
  | { kind: 'children'; parentKeys: readonly string[]; includeClosed?: boolean }
  | { kind: 'open' }
  | { kind: 'closed-worktrees'; closedBefore: string; afterSeq?: number; limit?: number };

/**
 * The stored cards of one project a scheduling query selects, once each, in ascending number order, with
 * only their own links. They are the rows as stored: no board view, so none of the derived fields (review
 * pin, outage, cover, merge, start waiting, handoff).
 */
export interface TaskSchedulingReader {
  readSchedulingTasks(projectKey: string, query: TaskSchedulingQuery): Task[];
}

/**
 * What a card's state was before a moment, from the timeline alone (PM-771): the starting state of the
 * reconstruction of a state at an event, which then replays the events of the window on top of it.
 *
 * For each of the given cards of the project, the one event with the greatest `seq` among those created
 * strictly before `before` (a UTC ISO time) that sets the card's state: a `task_stage_changed`, or a
 * `task_updated` whose `action` is `cancelled` or `reopened`. The events are returned in ascending `seq`.
 * A card without such an event has no result: its state before `before` stays unknown. No keys: `[]`.
 */
export interface TaskStateHistoryReader {
  latestTaskStatesBefore(projectKey: string, taskKeys: readonly string[], before: string): TimelineEvent[];
}
