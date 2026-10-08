import { defaultBoardColumnColor } from '@projectman/shared';
import type { BoardColumnView, BoardView, Stage } from '@projectman/shared';

export interface PipelineIndex {
  stages: Stage[];
  columns: BoardColumnView[];
  stageById: ReadonlyMap<string, Stage>;
  stageIndex: ReadonlyMap<string, number>;
  columnOfStage: ReadonlyMap<string, BoardColumnView>;
}

export function indexPipeline(board: Pick<BoardView, 'stages' | 'columns'>): PipelineIndex {
  const columns = board.columns.map((column, position) => ({
    ...column,
    color: column.color ?? defaultBoardColumnColor(position),
  }));
  const stageById = new Map(board.stages.map((stage) => [stage.id, stage]));
  const stageIndex = new Map(board.stages.map((stage, index) => [stage.id, index]));
  const columnOfStage = new Map<string, BoardColumnView>();
  for (const column of columns) {
    for (const stageId of column.stageIds) columnOfStage.set(stageId, column);
  }
  // Stages whose column lists nothing still map through Stage.columnId.
  for (const stage of board.stages) {
    if (!columnOfStage.has(stage.id)) {
      const column = columns.find((entry) => entry.id === stage.columnId);
      if (column) columnOfStage.set(stage.id, column);
    }
  }
  return { stages: board.stages, columns, stageById, stageIndex, columnOfStage };
}

export function columnSegments(byStage: Record<string, number>, pipeline: PipelineIndex) {
  const counts = new Map<string, number>();
  for (const [stageId, count] of Object.entries(byStage)) {
    const column = pipeline.columnOfStage.get(stageId);
    if (column) counts.set(column.id, (counts.get(column.id) ?? 0) + count);
  }
  return pipeline.columns
    .map((column) => ({ column, count: counts.get(column.id) ?? 0 }))
    .filter(({ count }) => count > 0);
}

/** 1-based position of a stage: "QA · 5/9". */
export function stagePosition(pipeline: PipelineIndex, stageId: string): { index: number; total: number } {
  return { index: (pipeline.stageIndex.get(stageId) ?? 0) + 1, total: pipeline.stages.length };
}

export function nextStage(pipeline: PipelineIndex, stageId: string): Stage | null {
  const index = pipeline.stageIndex.get(stageId);
  if (index === undefined) return null;
  return pipeline.stages[index + 1] ?? null;
}

/** Stages of the column a stage belongs to, in pipeline order. */
export function stagesInColumn(pipeline: PipelineIndex, column: BoardColumnView): Stage[] {
  return pipeline.stages.filter((stage) => pipeline.columnOfStage.get(stage.id)?.id === column.id);
}
