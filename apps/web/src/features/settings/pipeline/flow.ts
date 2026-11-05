import { defaultBoardColumnColor } from '@projectman/shared';
import type { BoardColumn, BoardColumnColor, Pipeline, Stage, TeamMapStage } from '@projectman/shared';

export interface ColumnRun {
  column: BoardColumn;
  stages: Stage[];
  /** Index of its first stage in the pipeline. */
  start: number;
}

/** Consecutive stages in one column form a run; a column whose stages are apart gets several runs. */
export function columnRuns(pipeline: Pipeline): ColumnRun[] {
  const runs: ColumnRun[] = [];
  pipeline.stages.forEach((stage, index) => {
    const last = runs[runs.length - 1];
    if (last && last.column.id === stage.columnId) {
      last.stages.push(stage);
      return;
    }
    const column = pipeline.columns.find((candidate) => candidate.id === stage.columnId) ?? {
      id: stage.columnId,
      name: stage.columnId,
    };
    runs.push({ column, stages: [stage], start: index });
  });
  return runs;
}

/** Columns with no stage, in their `pipeline.columns` order (shown at the bottom). */
export function emptyColumns(pipeline: Pipeline): BoardColumn[] {
  const used = new Set(pipeline.stages.map((stage) => stage.columnId));
  return pipeline.columns.filter((column) => !used.has(column.id));
}

/**
 * Columns ordered by their first stage; columns with no stage at the end, in their current order.
 * Only a save that changes the order of the stages or the column of a stage calls it: a name or a colour
 * leaves an old, differently ordered pipeline as it is. A column without a colour of its own shows the default
 * of its place, so a column that moves keeps the colour it showed: it is written down.
 */
export function orderColumns(pipeline: Pipeline): Pipeline {
  const first = new Map<string, number>();
  pipeline.stages.forEach((stage, index) => {
    if (!first.has(stage.columnId)) first.set(stage.columnId, index);
  });
  const before = new Map(pipeline.columns.map((column, index) => [column.id, index]));
  const used = pipeline.columns
    .filter((column) => first.has(column.id))
    .sort((a, b) => first.get(a.id)! - first.get(b.id)!);
  const unused = pipeline.columns.filter((column) => !first.has(column.id));
  const columns = [...used, ...unused].map((column, index) =>
    column.color === undefined && before.get(column.id) !== index
      ? { ...column, color: defaultBoardColumnColor(before.get(column.id)!) }
      : column,
  );
  return { ...pipeline, columns };
}

/** Where a stage stands after a move: its index in the pipeline then, and its column. */
export interface StagePlace {
  index: number;
  columnId: string;
}

/** Moves the stage so it ends at `index` (the index after the move), in `columnId`; then orderColumns. */
export function moveStage(pipeline: Pipeline, stageId: string, to: StagePlace): Pipeline {
  const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
  if (!stage) return pipeline;
  const rest = pipeline.stages.filter((candidate) => candidate.id !== stageId);
  const index = Math.min(Math.max(to.index, 0), rest.length);
  const stages = [...rest.slice(0, index), { ...stage, columnId: to.columnId }, ...rest.slice(index)];
  return orderColumns({ ...pipeline, stages });
}

/**
 * One step up or down. At the edge of a column run the stage first joins the neighbouring run's
 * column (same index), the next step moves it past. null at the start or end of the pipeline.
 */
export function stageMoveStep(
  pipeline: Pipeline,
  stageId: string,
  direction: 'up' | 'down',
): StagePlace | null {
  const { stages } = pipeline;
  const index = stages.findIndex((stage) => stage.id === stageId);
  if (index < 0) return null;
  const columnId = stages[index]!.columnId;
  const neighbour = stages[direction === 'up' ? index - 1 : index + 1];
  if (!neighbour) return null;
  if (neighbour.columnId !== columnId) return { index, columnId: neighbour.columnId };
  return { index: direction === 'up' ? index - 1 : index + 1, columnId };
}

/** Where a column's stages stand: first and last index, or 'scattered' when other stages come between them. */
export function columnSpan(
  pipeline: Pipeline,
  columnId: string,
): { start: number; end: number } | 'scattered' | null {
  const indexes = pipeline.stages.flatMap((stage, index) => (stage.columnId === columnId ? [index] : []));
  if (indexes.length === 0) return null;
  const start = indexes[0]!;
  const end = indexes[indexes.length - 1]!;
  return end - start + 1 === indexes.length ? { start, end } : 'scattered';
}

/** Moves a column's stages, together, past the neighbouring run; null when its stages are not consecutive or it is at the edge. */
export function columnMoveStep(
  pipeline: Pipeline,
  columnId: string,
  direction: 'up' | 'down',
): Pipeline | null {
  const span = columnSpan(pipeline, columnId);
  if (span === null || span === 'scattered') return null;
  const { stages } = pipeline;
  const block = stages.slice(span.start, span.end + 1);
  if (direction === 'up') {
    if (span.start === 0) return null;
    const neighbour = stages[span.start - 1]!.columnId;
    let from = span.start - 1;
    while (from > 0 && stages[from - 1]!.columnId === neighbour) from -= 1;
    return orderColumns({
      ...pipeline,
      stages: [
        ...stages.slice(0, from),
        ...block,
        ...stages.slice(from, span.start),
        ...stages.slice(span.end + 1),
      ],
    });
  }
  if (span.end === stages.length - 1) return null;
  const neighbour = stages[span.end + 1]!.columnId;
  let to = span.end + 1;
  while (to < stages.length - 1 && stages[to + 1]!.columnId === neighbour) to += 1;
  return orderColumns({
    ...pipeline,
    stages: [
      ...stages.slice(0, span.start),
      ...stages.slice(span.end + 1, to + 1),
      ...block,
      ...stages.slice(to + 1),
    ],
  });
}

/** Work, intermediate and release stages need someone to carry them; a queue and the end do not. */
export function needsOwner(entry: TeamMapStage): boolean {
  return entry.stage.kind === 'work' || entry.stage.kind === 'step' || entry.stage.kind === 'release';
}

/** The colour a column shows in: its own, else the default of its place in the board. */
export function columnColor(pipeline: Pipeline, column: BoardColumn): BoardColumnColor {
  const index = pipeline.columns.findIndex((candidate) => candidate.id === column.id);
  return column.color ?? defaultBoardColumnColor(Math.max(index, 0));
}
