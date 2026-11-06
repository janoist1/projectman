import { describe, expect, it } from 'vitest';
import { defaultBoardColumnColor } from '@projectman/shared';
import type { Pipeline, Stage } from '@projectman/shared';
import {
  columnColor,
  columnMoveStep,
  columnRuns,
  emptyColumns,
  moveStage,
  orderColumns,
  stageMoveStep,
} from './flow';

function stage(id: string, columnId: string): Stage {
  return { id, name: id, kind: 'work', owners: [], columnId };
}

function pipeline(stages: Stage[], columns: string[]): Pipeline {
  return {
    columns: columns.map((id) => ({ id, name: id })),
    stages,
    labels: [],
  } as Pipeline;
}

describe('columnRuns', () => {
  it('puts consecutive stages of one column into one run', () => {
    const runs = columnRuns(pipeline([stage('a', 'x'), stage('b', 'x'), stage('c', 'y')], ['x', 'y']));
    expect(runs.map((run) => [run.column.id, run.stages.map((s) => s.id), run.start])).toEqual([
      ['x', ['a', 'b'], 0],
      ['y', ['c'], 2],
    ]);
  });

  it('gives a scattered column one run for each stretch', () => {
    const runs = columnRuns(pipeline([stage('a', 'x'), stage('b', 'y'), stage('c', 'x')], ['x', 'y']));
    expect(runs.map((run) => [run.column.id, run.start])).toEqual([
      ['x', 0],
      ['y', 1],
      ['x', 2],
    ]);
  });
});

describe('emptyColumns', () => {
  it('lists the columns no stage uses, in column order', () => {
    const empty = emptyColumns(pipeline([stage('a', 'y')], ['x', 'y', 'z']));
    expect(empty.map((column) => column.id)).toEqual(['x', 'z']);
  });
});

describe('orderColumns', () => {
  const ids = (value: Pipeline) => value.columns.map((column) => column.id);

  it('puts an old, differently ordered pipeline into the order of its stages', () => {
    const ordered = orderColumns(
      pipeline([stage('a', 'x'), stage('b', 'y'), stage('c', 'z')], ['z', 'x', 'y']),
    );
    expect(ids(ordered)).toEqual(['x', 'y', 'z']);
  });

  it('orders a scattered column by its first stage', () => {
    const ordered = orderColumns(pipeline([stage('a', 'y'), stage('b', 'x'), stage('c', 'y')], ['x', 'y']));
    expect(ids(ordered)).toEqual(['y', 'x']);
  });

  it('keeps the columns with no stage at the end, in their current order', () => {
    const ordered = orderColumns(pipeline([stage('a', 'y')], ['w', 'x', 'y', 'z']));
    expect(ids(ordered)).toEqual(['y', 'w', 'x', 'z']);
  });

  it('keeps the columns of a pipeline that is in order', () => {
    const base = pipeline([stage('a', 'x'), stage('b', 'y')], ['x', 'y', 'z']);
    expect(orderColumns(base)).toEqual(base);
  });

  it('pins the colour a moved column showed, and leaves one that has its own', () => {
    const base = pipeline([stage('a', 'y'), stage('b', 'x')], ['x', 'y']);
    base.columns[1]!.color = 'teal';
    const ordered = orderColumns(base);
    expect(ids(ordered)).toEqual(['y', 'x']);
    expect(ordered.columns[0]!.color).toBe('teal');
    expect(ordered.columns[1]!.color).toBe(defaultBoardColumnColor(0));
  });
});

const ids = (p: Pipeline | null) => p!.stages.map((s) => `${s.id}:${s.columnId}`);

describe('moveStage', () => {
  it('puts the stage at the index after the move, in the column given', () => {
    const base = pipeline([stage('a', 'x'), stage('b', 'x'), stage('c', 'y')], ['x', 'y']);
    expect(ids(moveStage(base, 'a', { index: 2, columnId: 'y' }))).toEqual(['b:x', 'c:y', 'a:y']);
  });

  it('orders the columns again when the first stage changes column', () => {
    const base = pipeline([stage('a', 'x'), stage('b', 'y')], ['x', 'y']);
    expect(moveStage(base, 'b', { index: 0, columnId: 'y' }).columns.map((c) => c.id)).toEqual(['y', 'x']);
  });
});

describe('stageMoveStep', () => {
  const base = pipeline([stage('a', 'x'), stage('b', 'x'), stage('c', 'y'), stage('d', 'y')], ['x', 'y']);

  it('moves a stage inside its run by one place', () => {
    expect(stageMoveStep(base, 'b', 'up')).toEqual({ index: 0, columnId: 'x' });
    expect(stageMoveStep(base, 'c', 'down')).toEqual({ index: 3, columnId: 'y' });
  });

  it('joins the neighbouring column at the edge of a run, then the next step passes the border', () => {
    expect(stageMoveStep(base, 'b', 'down')).toEqual({ index: 1, columnId: 'y' });
    expect(stageMoveStep(base, 'c', 'up')).toEqual({ index: 2, columnId: 'x' });
    const joined = moveStage(base, 'b', { index: 1, columnId: 'y' });
    expect(stageMoveStep(joined, 'b', 'down')).toEqual({ index: 2, columnId: 'y' });
  });

  it('has no step before the first stage or after the last', () => {
    expect(stageMoveStep(base, 'a', 'up')).toBeNull();
    expect(stageMoveStep(base, 'd', 'down')).toBeNull();
  });
});

describe('columnMoveStep', () => {
  const base = pipeline(
    [stage('a', 'x'), stage('b', 'y'), stage('c', 'y'), stage('d', 'z')],
    ['x', 'y', 'z'],
  );

  it('moves the stages of a column together past the neighbouring run', () => {
    expect(ids(columnMoveStep(base, 'y', 'up'))).toEqual(['b:y', 'c:y', 'a:x', 'd:z']);
    expect(ids(columnMoveStep(base, 'y', 'down'))).toEqual(['a:x', 'd:z', 'b:y', 'c:y']);
  });

  it('has no step at the edge of the pipeline', () => {
    expect(columnMoveStep(base, 'x', 'up')).toBeNull();
    expect(columnMoveStep(base, 'z', 'down')).toBeNull();
  });

  it('has no step for a scattered column or one with no stage', () => {
    const scattered = pipeline([stage('a', 'x'), stage('b', 'y'), stage('c', 'x')], ['x', 'y', 'e']);
    expect(columnMoveStep(scattered, 'x', 'down')).toBeNull();
    expect(columnMoveStep(scattered, 'e', 'up')).toBeNull();
  });
});

describe('columnColor', () => {
  it('uses the column own colour, else the default of its place', () => {
    const base = pipeline([stage('a', 'x')], ['x', 'y']);
    base.columns[1]!.color = 'teal';
    expect(columnColor(base, base.columns[1]!)).toBe('teal');
    expect(columnColor(base, base.columns[0]!)).toBe(defaultBoardColumnColor(0));
  });
});
