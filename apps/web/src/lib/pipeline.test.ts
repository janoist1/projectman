import { expect, it } from 'vitest';
import { columnSegments, indexPipeline } from './pipeline';

it('resolves colours by position without mutating config and preserves explicit colours', () => {
  const columns = [
    { id: 'ready', name: 'Ready', stageIds: [] },
    { id: 'work', name: 'Work', stageIds: [] },
    { id: 'done', name: 'Done', color: 'pink' as const, stageIds: [] },
  ];
  const pipeline = indexPipeline({ columns, stages: [] });
  expect(pipeline.columns.map((column) => column.color)).toEqual(['gray', 'blue', 'pink']);
  expect(columns[0]).not.toHaveProperty('color');
});

it('counts cards by board column in the board order, leaving out the empty columns and unknown stages', () => {
  const pipeline = indexPipeline({
    columns: [
      { id: 'todo', name: 'Todo', stageIds: ['incoming', 'ready'] },
      { id: 'work', name: 'Work', stageIds: ['dev'] },
      { id: 'finished', name: 'Finished', stageIds: ['done'] },
    ],
    stages: [],
  });
  const segments = columnSegments({ done: 5, ready: 2, incoming: 1, gone: 7 }, pipeline);
  expect(segments.map(({ column, count }) => [column.id, count])).toEqual([
    ['todo', 3],
    ['finished', 5],
  ]);
});
