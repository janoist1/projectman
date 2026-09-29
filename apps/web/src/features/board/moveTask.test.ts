import { describe, expect, it } from 'vitest';
import { tasks } from '../../mocks/fixtures';
import { mockIndexes } from '../../test/render';
import { canMoveTask, dropStage, enteredStages } from './moveTask';

const { pipeline } = mockIndexes();
const task = tasks.find((entry) => entry.key === 'AC-20')!;

describe('board drop logic', () => {
  it('enters the first stage of a grouped column and rejects the source column', () => {
    expect(
      dropStage(
        task,
        pipeline.columns.find((column) => column.id === 'review')!,
        pipeline,
      ),
    ).toBe('code_review');
    expect(
      dropStage(
        task,
        pipeline.columns.find((column) => column.id === 'dev')!,
        pipeline,
      ),
    ).toBeNull();
    expect(dropStage(task, { id: 'empty', name: 'Empty', stageIds: [] }, pipeline)).toBeNull();
  });
  it('shows every forward gate, but only the target gate when moving backward', () => {
    expect(enteredStages(pipeline, 'dev', 'client_test').map((stage) => stage.id)).toEqual([
      'code_review',
      'integration',
      'qa',
      'client_test',
    ]);
    expect(enteredStages(pipeline, 'release', 'integration').map((stage) => stage.id)).toEqual([
      'integration',
    ]);
  });
  it('requires developer permission and an open task', () => {
    expect(canMoveTask(task, true)).toBe(true);
    expect(canMoveTask(task, false)).toBe(false);
    expect(canMoveTask({ ...task, status: 'done' }, true)).toBe(false);
    expect(canMoveTask({ ...task, status: 'cancelled' }, true)).toBe(false);
  });
});
