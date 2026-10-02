import type { LabelView, MemberView, Task } from '@projectman/shared';
import { labelName } from '../../lib/labels';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import type { BoardFilter } from '../../lib/taskState';
import { matchesSearch } from './cardModel';
import type { BoardEntry } from './useBoardModel';

/** The "no one is responsible" choice of the assignee filter; a handle never holds an `@`. */
export const NO_ASSIGNEE = '@none';

/**
 * What narrows the board besides the search and the theme: the state (Mind / Rád vár / Másra vár),
 * the member responsible for the card and a label or tag. The empty string is "Mind". The conditions
 * and the search all hold at once.
 */
export interface BoardFilters {
  phase: BoardFilter;
  assignee: string;
  label: string;
}

export const noBoardFilters: BoardFilters = { phase: 'all', assignee: '', label: '' };

export interface FilterOption {
  value: string;
  label: string;
}

/** How many of the three filters are set to something other than "Mind". */
export function activeFilterCount(filters: BoardFilters): number {
  return (
    (filters.phase !== 'all' ? 1 : 0) + (filters.assignee !== '' ? 1 : 0) + (filters.label !== '' ? 1 : 0)
  );
}

export function matchesAssignee(task: Pick<Task, 'assignee'>, assignee: string): boolean {
  if (assignee === '') return true;
  if (assignee === NO_ASSIGNEE) return !task.assignee;
  return task.assignee === assignee;
}

export function matchesLabel(task: Pick<Task, 'labels'>, label: string): boolean {
  return label === '' || task.labels.includes(label);
}

/** Everything but the state filter: the segments' counts are taken over this. */
export function matchesCardFilters(
  task: Task,
  filters: Pick<BoardFilters, 'assignee' | 'label'>,
  search: string,
  labels: readonly LabelView[],
): boolean {
  return (
    matchesAssignee(task, filters.assignee) &&
    matchesLabel(task, filters.label) &&
    matchesSearch(task, search, labels)
  );
}

/**
 * The members to filter by: no one, yourself (when you are responsible for a card), then the team in
 * its order, those responsible for at least one card. A responsible handle that is no member (any
 * more) is named by the handle, after the team.
 */
export function assigneeOptions(
  entries: readonly BoardEntry[],
  teamOrder: readonly MemberView[],
  members: MemberIndex,
  myHandle: string | null,
  noneLabel: string,
): FilterOption[] {
  const handles = new Set(entries.flatMap((entry) => (entry.task.assignee ? [entry.task.assignee] : [])));
  const known = teamOrder.map((member) => member.handle).filter((handle) => handles.has(handle));
  const unknown = [...handles].filter((handle) => !known.includes(handle)).sort();
  const ordered = [...known, ...unknown];
  const mine = myHandle && handles.has(myHandle) ? [myHandle] : [];
  return [
    { value: NO_ASSIGNEE, label: noneLabel },
    ...[...mine, ...ordered.filter((handle) => handle !== myHandle)].map((handle) => ({
      value: handle,
      label: nameOf(handle, members, myHandle),
    })),
  ];
}

/**
 * The labels to filter by, those on at least one card: the project's labels in the order of their
 * list, then the plain tags in alphabetical order.
 */
export function labelOptions(entries: readonly BoardEntry[], labels: readonly LabelView[]): FilterOption[] {
  const used = new Set(entries.flatMap((entry) => entry.task.labels));
  const defined = labels.filter((label) => used.has(label.id));
  const known = new Set(labels.map((label) => label.id));
  const plain = [...used].filter((id) => !known.has(id)).sort((a, b) => a.localeCompare(b));
  return [
    ...defined.map((label) => ({ value: label.id, label: label.name })),
    ...plain.map((id) => ({ value: id, label: labelName(id, labels) })),
  ];
}

/** A choice whose card is gone falls back to "Mind". */
export function sanitizeFilters(
  filters: BoardFilters,
  assignees: readonly FilterOption[],
  labelChoices: readonly FilterOption[],
): BoardFilters {
  const assignee = assignees.some((option) => option.value === filters.assignee) ? filters.assignee : '';
  const label = labelChoices.some((option) => option.value === filters.label) ? filters.label : '';
  return assignee === filters.assignee && label === filters.label ? filters : { ...filters, assignee, label };
}
