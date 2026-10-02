import { describe, expect, it } from 'vitest';
import type { Task } from '@projectman/shared';
import { mockIndexes } from '../../test/render';
import { sortColumnEntries, sortGroupEntries } from './useBoardModel';
import type { BoardEntry } from './useBoardModel';
import type { TaskState } from '../../lib/taskState';

function entry(key: string, fields: Partial<Task>, phase: TaskState['phase'] = 'working'): BoardEntry {
  return {
    task: { key, updatedAt: '2026-01-01T00:00:00.000Z', ...fields } as Task,
    state: { phase } as TaskState,
  };
}

const keys = (entries: BoardEntry[]) => entries.map(({ task }) => task.key);

describe('board card order (PM-118)', () => {
  it('orders a column by its stored rank, whatever the phase', () => {
    const entries = [
      entry('A', { boardRank: 3072 }, 'needs_you'),
      entry('B', { boardRank: 1024 }, 'blocked'),
      entry('C', { boardRank: 2048 }, 'working'),
    ];
    expect(keys(sortColumnEntries(entries, false))).toEqual(['B', 'C', 'A']);
  });

  it('breaks a rank tie by the later update, then by the later card', () => {
    const entries = [
      entry('A-1', { boardRank: 1024, updatedAt: '2026-01-01T00:00:00.000Z' }),
      entry('A-2', { boardRank: 1024, updatedAt: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(keys(sortColumnEntries(entries, false))).toEqual(['A-2', 'A-1']);
  });

  it('orders a column of finished work by closing time, newest first', () => {
    const entries = [
      entry('A', { boardRank: 1024, closedAt: '2026-03-01T00:00:00.000Z' }, 'done'),
      entry('B', { boardRank: 2048, closedAt: '2026-05-01T00:00:00.000Z' }, 'done'),
    ];
    expect(keys(sortColumnEntries(entries, true))).toEqual(['B', 'A']);
  });

  it('puts the later column first on the phone, each column in its stored order, finished ones by closing time', () => {
    const { pipeline } = mockIndexes();
    const entries = [
      entry('R1', { stageId: 'ready', boardRank: 1024 }),
      entry('D2', { stageId: 'dev', boardRank: 2048 }),
      entry('D1', { stageId: 'dev', boardRank: 1024 }),
      entry('F1', { stageId: 'done', closedAt: '2026-03-01T00:00:00.000Z' }, 'done'),
      entry('F2', { stageId: 'done', closedAt: '2026-05-01T00:00:00.000Z' }, 'done'),
    ];
    const sorted = keys(sortGroupEntries(entries, pipeline));
    expect(sorted.slice(0, 2)).toEqual(['F2', 'F1']);
    expect(sorted.slice(2)).toEqual(['D1', 'D2', 'R1']);
  });
});
