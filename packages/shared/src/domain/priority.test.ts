import { describe, expect, it } from 'vitest';
import { UpdateTaskRequest } from '../api/dto';
import { priorityRefusal, TASK_PRIORITIES } from './task';

describe('card priority', () => {
  it('allows only people, including when clearing or keeping the same level', () => {
    expect(priorityRefusal({ kind: 'human' })).toBeNull();
    expect(priorityRefusal({ kind: 'ai' })).toBe('priority_humans_only');
    expect(priorityRefusal({ kind: 'system' })).toBe('priority_humans_only');
  });
  it('accepts the four named levels and clearing, but refuses numbers and unknown names', () => {
    for (const priority of [...TASK_PRIORITIES, null])
      expect(UpdateTaskRequest.parse({ priority })).toEqual({ priority });
    for (const priority of ['medium', 2])
      expect(UpdateTaskRequest.safeParse({ priority }).success).toBe(false);
  });
});
