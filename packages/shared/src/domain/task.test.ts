import { describe, expect, it } from 'vitest';
import { isOpenTask, subtaskParentRefusal, taskSeq } from './task';
import type { SubtaskParentRefusal, TaskStatus } from './task';

describe('task helpers', () => {
  it.each<[TaskStatus, boolean]>([
    ['active', true],
    ['waiting', true],
    ['blocked', true],
    ['done', false],
    ['cancelled', false],
  ])('a %s task is open: %s', (status, open) => {
    expect(isOpenTask({ status })).toBe(open);
  });

  it.each([
    ['AR-1', 1],
    ['PM2-117', 117],
  ])('numbers %s as %i', (key, seq) => {
    expect(taskSeq(key)).toBe(seq);
  });
});

describe('subtaskParentRefusal', () => {
  const topLevel = { projectKey: 'AR', parentKey: null };
  const child: Parameters<typeof subtaskParentRefusal>[2] = {
    key: 'AR-2',
    projectKey: 'AR',
    hasSubtasks: false,
  };

  it.each<
    [
      string,
      string,
      Parameters<typeof subtaskParentRefusal>[1],
      Partial<Parameters<typeof subtaskParentRefusal>[2]>,
      SubtaskParentRefusal | null,
    ]
  >([
    ['a top-level task of the project', 'AR-1', topLevel, {}, null],
    ['a top-level task from before subtasks existed', 'AR-1', { projectKey: 'AR' }, {}, null],
    ['a top-level task, for a task being created', 'AR-1', topLevel, { key: null }, null],
    ['the task itself', 'AR-2', topLevel, {}, 'subtask_self_parent'],
    ['missing', 'AR-9', null, {}, 'subtask_parent_not_found'],
    ['missing, for a task being created', 'AR-9', undefined, { key: null }, 'subtask_parent_not_found'],
    [
      'a task of another project',
      'XY-1',
      { projectKey: 'XY', parentKey: null },
      {},
      'subtask_parent_project',
    ],
    ['a subtask', 'AR-3', { projectKey: 'AR', parentKey: 'AR-1' }, {}, 'subtask_parent_is_subtask'],
    ['any task, for a task with subtasks', 'AR-1', topLevel, { hasSubtasks: true }, 'subtask_has_children'],
  ])('a parent that is %s (%s)', (_case, parentKey, parent, overrides, expected) => {
    expect(subtaskParentRefusal(parentKey, parent, { ...child, ...overrides })).toBe(expected);
  });

  it('checks in the order the refusals are listed', () => {
    const subtaskElsewhere = { projectKey: 'XY', parentKey: 'XY-1' };
    expect(subtaskParentRefusal('AR-2', subtaskElsewhere, { ...child, hasSubtasks: true })).toBe(
      'subtask_self_parent',
    );
    expect(subtaskParentRefusal('XY-2', subtaskElsewhere, { ...child, hasSubtasks: true })).toBe(
      'subtask_parent_project',
    );
    expect(
      subtaskParentRefusal('AR-3', { projectKey: 'AR', parentKey: 'AR-1' }, { ...child, hasSubtasks: true }),
    ).toBe('subtask_parent_is_subtask');
  });
});
