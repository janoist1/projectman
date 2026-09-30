import { expect, it } from 'vitest';
import { indexPipeline } from './pipeline';

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
