import { describe, expect, it } from 'vitest';
import {
  NO_ASSIGNEE,
  activeFilterCount,
  matchesAssignee,
  matchesLabel,
  matchesPriority,
  NO_PRIORITY,
  noBoardFilters,
  sanitizeFilters,
} from './boardFilters';

describe('board filters', () => {
  it('matches the stored priority, including unset, and counts it independently', () => {
    expect(matchesPriority({ priority: 'high' }, '')).toBe(true);
    expect(matchesPriority({ priority: 'high' }, 'high')).toBe(true);
    expect(matchesPriority({ priority: 'low' }, 'high')).toBe(false);
    expect(matchesPriority({ priority: null }, NO_PRIORITY)).toBe(true);
    expect(matchesPriority({ priority: 'normal' }, NO_PRIORITY)).toBe(false);
    expect(activeFilterCount({ ...noBoardFilters, priority: NO_PRIORITY })).toBe(1);
  });
  it('counts what is set', () => {
    expect(activeFilterCount(noBoardFilters)).toBe(0);
    expect(activeFilterCount({ ...noBoardFilters, phase: 'needsYou', assignee: 'be-1' })).toBe(2);
    expect(activeFilterCount({ ...noBoardFilters, assignee: NO_ASSIGNEE, label: 'Új' })).toBe(2);
  });

  it('matches the assignee, and "no one"', () => {
    expect(matchesAssignee({ assignee: 'be-1' }, '')).toBe(true);
    expect(matchesAssignee({ assignee: 'be-1' }, 'be-1')).toBe(true);
    expect(matchesAssignee({ assignee: 'be-1' }, 'fe-1')).toBe(false);
    expect(matchesAssignee({ assignee: null }, NO_ASSIGNEE)).toBe(true);
    expect(matchesAssignee({ assignee: 'be-1' }, NO_ASSIGNEE)).toBe(false);
  });

  it('matches a label or a plain tag', () => {
    expect(matchesLabel({ labels: [] }, '')).toBe(true);
    expect(matchesLabel({ labels: ['qa-ok', 'Új'] }, 'Új')).toBe(true);
    expect(matchesLabel({ labels: ['qa-ok'] }, 'Új')).toBe(false);
  });

  it('lets a choice whose cards are gone fall back to "Mind", and keeps the object when nothing changes', () => {
    const assignees = [{ value: NO_ASSIGNEE, label: 'Nincs' }];
    const labels = [{ value: 'qa-ok', label: 'QA rendben' }];
    const set = { phase: 'waiting', assignee: 'be-1', label: 'qa-ok', priority: 'high' } as const;
    expect(sanitizeFilters(set, assignees, labels)).toEqual({
      phase: 'waiting',
      assignee: '',
      label: 'qa-ok',
      priority: 'high',
    });
    const fine = { phase: 'all', assignee: NO_ASSIGNEE, label: 'qa-ok', priority: '' } as const;
    expect(sanitizeFilters(fine, assignees, labels)).toBe(fine);
  });
});
