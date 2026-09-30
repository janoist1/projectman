import { defaultBoardColumnColor } from '@projectman/shared';
import type { BoardColumnView, BoardView, CheckName, Stage } from '@projectman/shared';

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

/** Which recorded check a stage produces (review → code_review, test → qa, ...). */
export function checkForStage(stage: Stage): CheckName | null {
  switch (stage.kind) {
    case 'review':
      return /secur/i.test(stage.id) || /secur/i.test(stage.name) ? 'security_review' : 'code_review';
    case 'test':
      return 'qa';
    case 'client_test':
      return 'client_test';
    default:
      return null;
  }
}

/** Kind of the first stage in a column. */
export function columnKind(pipeline: PipelineIndex, column: BoardColumnView): Stage['kind'] {
  const first = column.stageIds[0] ? pipeline.stageById.get(column.stageIds[0]) : undefined;
  return first?.kind ?? 'work';
}
