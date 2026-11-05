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

/** Work, intermediate and release stages need someone to carry them; a queue and the end do not. */
export function needsOwner(entry: TeamMapStage): boolean {
  return entry.stage.kind === 'work' || entry.stage.kind === 'step' || entry.stage.kind === 'release';
}

/** The colour a column shows in: its own, else the default of its place in the board. */
export function columnColor(pipeline: Pipeline, column: BoardColumn): BoardColumnColor {
  const index = pipeline.columns.findIndex((candidate) => candidate.id === column.id);
  return column.color ?? defaultBoardColumnColor(Math.max(index, 0));
}
