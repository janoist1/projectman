import { describe, expect, it } from 'vitest';
import {
  NO_ASSIGNEE,
  activeFilterCount,
  matchesAssignee,
  matchesLabel,
  noBoardFilters,
  sanitizeFilters,
} from './boardFilters';

describe('board filters', () => {
  it('counts what is set', () => {
    expect(activeFilterCount(noBoardFilters)).toBe(0);
    expect(activeFilterCount({ phase: 'needsYou', assignee: 'be-1', label: '' })).toBe(2);
    expect(activeFilterCount({ phase: 'all', assignee: NO_ASSIGNEE, label: 'Új' })).toBe(2);
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
    const set = { phase: 'waiting', assignee: 'be-1', label: 'qa-ok' } as const;
    expect(sanitizeFilters(set, assignees, labels)).toEqual({
      phase: 'waiting',
      assignee: '',
      label: 'qa-ok',
    });
    const fine = { phase: 'all', assignee: NO_ASSIGNEE, label: 'qa-ok' } as const;
    expect(sanitizeFilters(fine, assignees, labels)).toBe(fine);
  });
});
