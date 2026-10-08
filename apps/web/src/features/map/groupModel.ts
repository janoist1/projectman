import { MAP_STATE_ORDER, isOpenTask, openPrerequisites, taskSeq } from '@projectman/shared';
import type { BoardColumnView, MapGroup, MapLane, MapState, Task } from '@projectman/shared';
import type { PipelineIndex } from '../../lib/pipeline';
import type { TaskState } from '../../lib/taskState';
import { matchesAssignee } from '../board/boardFilters';
import type { BoardEntry } from '../board/useBoardModel';
import type { MapShow } from './mapFilters';

export interface ZoomCard {
  task: Task;
  state: TaskState;
  mapState: MapState;
  stale: boolean;
  /** The column the card stands in. */
  columnId: string;
}

export interface ZoomLane {
  lane: MapLane;
  /** The collecting card heading the lane, when there is one in the board's data. */
  collector: BoardEntry | null;
  /** The lane's visible open cards, in the order of the cells. */
  cards: ZoomCard[];
  byColumn: ReadonlyMap<string, ZoomCard[]>;
}

/** The columns of the zoomed view: the board's open columns; the finishing column is the "Kész" column. */
export function openColumns(pipeline: PipelineIndex): BoardColumnView[] {
  return pipeline.columns.filter(
    (column) =>
      !pipeline.stages.some(
        (stage) => stage.kind === 'done' && pipeline.columnOfStage.get(stage.id)?.id === column.id,
      ),
  );
}

const stateRank = (state: MapState) => MAP_STATE_ORDER.indexOf(state);

/** In a cell: by urgency, then by key. */
export function compareCards(a: ZoomCard, b: ZoomCard): number {
  return stateRank(a.mapState) - stateRank(b.mapState) || taskSeq(a.task.key) - taskSeq(b.task.key);
}

export interface LaneInput {
  group: MapGroup;
  byKey: ReadonlyMap<string, BoardEntry>;
  states: ReadonlyMap<string, MapState | null>;
  staleKeys: ReadonlySet<string>;
  pipeline: PipelineIndex;
  show: MapShow;
  member: string;
}

/**
 * The lanes of a group as the zoomed view draws them: only the open cards the filters let through, each in
 * the cell of its column. Done and withdrawn cards are not drawn (the lane counts the done ones). A lane the
 * filters empty is left out; unfiltered, a lane without an open card stays and shows its heading and count.
 */
export function zoomLanes(input: LaneInput): ZoomLane[] {
  const { group, byKey, states, staleKeys, pipeline, show, member } = input;
  const columns = openColumns(pipeline);
  const fallback = columns[columns.length - 1];
  const filtered = show !== 'all' || member !== '';
  const lanes: ZoomLane[] = [];
  for (const lane of group.lanes) {
    const cards: ZoomCard[] = [];
    for (const key of lane.cardKeys) {
      const entry = byKey.get(key);
      const mapState = states.get(key);
      if (!entry || !mapState || !isOpenTask(entry.task)) continue;
      if (show === 'needsYou' && mapState !== 'needs_you') continue;
      if (show === 'blocked' && mapState !== 'blocked') continue;
      if (!matchesAssignee(entry.task, member)) continue;
      const column = pipeline.columnOfStage.get(entry.task.stageId);
      const inOpenColumn = column && columns.some((candidate) => candidate.id === column.id);
      const columnId = inOpenColumn ? column.id : fallback?.id;
      if (!columnId) continue;
      cards.push({ task: entry.task, state: entry.state, mapState, stale: staleKeys.has(key), columnId });
    }
    if (filtered && cards.length === 0) continue;
    cards.sort(compareCards);
    const byColumn = new Map<string, ZoomCard[]>();
    for (const card of cards) {
      const cell = byColumn.get(card.columnId) ?? [];
      cell.push(card);
      byColumn.set(card.columnId, cell);
    }
    lanes.push({
      lane,
      collector: lane.collectorKey ? (byKey.get(lane.collectorKey) ?? null) : null,
      cards,
      byColumn,
    });
  }
  return lanes;
}

export interface Waiting {
  /** The open prerequisites to read as text: not on the map, or every one on a phone. */
  keys: string[];
  /** Open prerequisites on the map: their arrows say it on a desktop. */
  drawn: string[];
}

/**
 * What a card waits for, beyond the arrows (PM-407). Only open prerequisites the viewer may see count (the
 * board's cards are what the server lets through). The one the state's label already names is not repeated.
 */
export function waitingOf(
  card: ZoomCard,
  tasks: readonly Task[],
  drawn: ReadonlySet<string>,
  list: boolean,
): Waiting {
  const named = card.state.prerequisite?.inLabel ? card.state.prerequisite.key : null;
  const keys: string[] = [];
  const onMap: string[] = [];
  for (const prerequisite of openPrerequisites(card.task, tasks)) {
    if (prerequisite.key === named) continue;
    if (drawn.has(prerequisite.key) && !list) onMap.push(prerequisite.key);
    else keys.push(prerequisite.key);
  }
  return { keys, drawn: onMap };
}

export interface Edge {
  from: string;
  to: string;
}

/** The arrows: from an open prerequisite to the card that waits for it, when both are on the map. */
export function edgesOf(cards: readonly ZoomCard[], tasks: readonly Task[]): Edge[] {
  const visible = new Set(cards.map((card) => card.task.key));
  const edges: Edge[] = [];
  for (const card of cards) {
    for (const prerequisite of openPrerequisites(card.task, tasks)) {
      if (visible.has(prerequisite.key)) edges.push({ from: prerequisite.key, to: card.task.key });
    }
  }
  return edges;
}
