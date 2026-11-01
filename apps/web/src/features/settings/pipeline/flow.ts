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

/** Work, intermediate and release stages need someone to carry them; a queue and the end do not. */
export function needsOwner(entry: TeamMapStage): boolean {
  return entry.stage.kind === 'work' || entry.stage.kind === 'step' || entry.stage.kind === 'release';
}

/** The colour a column shows in: its own, else the default of its place in the board. */
export function columnColor(pipeline: Pipeline, column: BoardColumn): BoardColumnColor {
  const index = pipeline.columns.findIndex((candidate) => candidate.id === column.id);
  return column.color ?? defaultBoardColumnColor(Math.max(index, 0));
}
