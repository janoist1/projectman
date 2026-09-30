import { describe, expect, it } from 'vitest';
import { isOpenTask, taskSeq } from './task';
import type { TaskStatus } from './task';

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
