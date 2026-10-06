import { useEffect, useMemo } from 'react';
import type { BoardView } from '@projectman/shared';
import { TASK_PRIORITIES, isOpenTask } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { t } from '../../i18n/t';
import { matchesFilter } from '../../lib/taskState';
import type { BoardFilter } from '../../lib/taskState';
import {
  activeFilterCount,
  NO_PRIORITY,
  assigneeOptions,
  labelOptions,
  matchesCardFilters,
  noBoardFilters,
  sanitizeFilters,
} from './boardFilters';
import type { FilterOption } from './boardFilters';
import { matchesSearch } from './cardModel';
import { sortedThemes } from './themeModel';
import type { BoardEntry, useBoardModel } from './useBoardModel';

type Model = NonNullable<ReturnType<typeof useBoardModel>['model']>;

/**
 * What the board shows once the search, the theme and the state, member and label filters have
 * narrowed it. The two views of the board, the columns and the phone list, take the same result, so
 * a filter means the same on both. Nothing here asks the server: it works on the board's data.
 */
export function useBoardFilters({
  entries,
  model,
  board,
}: {
  /** The cards as the board shows them now (a card on its way to another column is already there). */
  entries: BoardEntry[];
  model: Model | null;
  board: BoardView | undefined;
}) {
  const { myHandle, search, themeFilter, boardFilters, setBoardFilters } = useProject();
  const labels = model?.ctx.labels;
  const members = model?.ctx.members;
  const tasks = board?.tasks;
  const team = board?.members;

  const open = useMemo(() => entries.filter((entry) => entry.state.phase !== 'cancelled'), [entries]);
  const assignees = useMemo<FilterOption[]>(
    () =>
      members && team ? assigneeOptions(open, team, members, myHandle, t('board.filterNoAssignee')) : [],
    [open, team, members, myHandle],
  );
  const labelChoices = useMemo<FilterOption[]>(() => labelOptions(open, labels ?? []), [open, labels]);

  // A choice whose cards are gone (the member was removed, the label taken off) falls back to "Mind".
  const filters = useMemo(
    () => sanitizeFilters(boardFilters, assignees, labelChoices),
    [boardFilters, assignees, labelChoices],
  );
  const loaded = board !== undefined;
  useEffect(() => {
    if (loaded && filters !== boardFilters) setBoardFilters(filters);
  }, [loaded, filters, boardFilters, setBoardFilters]);

  // The theme filter narrows with the others: a card matches by its computed theme, so the subtasks of a
  // collecting card in the theme are in the list too (PM-192).
  const activeTheme = useMemo(
    () => sortedThemes(tasks ?? []).find((theme) => theme.key === themeFilter) ?? null,
    [tasks, themeFilter],
  );
  const themed = useMemo(
    () => (activeTheme ? entries.filter((entry) => entry.task.themeKey === activeTheme.key) : entries),
    [entries, activeTheme],
  );
  const searched = useMemo(
    () => themed.filter((entry) => matchesSearch(entry.task, search, labels)),
    [themed, search, labels],
  );
  // Everything but the state: the segments count over this, so each says what it would show.
  const narrowed = useMemo(
    () => themed.filter((entry) => matchesCardFilters(entry.task, filters, search, labels ?? [])),
    [themed, filters, search, labels],
  );
  const visible = useMemo(
    () => narrowed.filter((entry) => matchesFilter(entry.state.phase, filters.phase)),
    [narrowed, filters.phase],
  );
  const counts = useMemo(
    () => ({
      all: narrowed.filter((entry) => matchesFilter(entry.state.phase, 'all')).length,
      needsYou: narrowed.filter((entry) => matchesFilter(entry.state.phase, 'needsYou')).length,
      waiting: narrowed.filter((entry) => matchesFilter(entry.state.phase, 'waiting')).length,
    }),
    [narrowed],
  );

  const clearable = activeFilterCount(filters);
  const priorityChoices: FilterOption[] = [
    ...TASK_PRIORITIES.map((level) => ({ value: level, label: t(`priority.levels.${level}`) })),
    { value: NO_PRIORITY, label: t('priority.none') },
  ];
  const labelOf = (options: readonly FilterOption[], value: string) =>
    options.find((option) => option.value === value)?.label ?? value;
  const priorityValue =
    filters.priority === NO_PRIORITY
      ? t('board.filterNoPriority')
      : t('board.filterPriorityValue', { level: labelOf(priorityChoices, filters.priority) });
  const chips: { id: 'assignee' | 'label' | 'priority'; value: string }[] = [];
  if (filters.assignee) chips.push({ id: 'assignee', value: labelOf(assignees, filters.assignee) });
  if (filters.label) chips.push({ id: 'label', value: labelOf(labelChoices, filters.label) });
  if (filters.priority) chips.push({ id: 'priority', value: priorityValue });
  return {
    filters,
    setPhase: (phase: BoardFilter) => setBoardFilters({ ...filters, phase }),
    setAssignee: (assignee: string) => setBoardFilters({ ...filters, assignee }),
    setLabel: (label: string) => setBoardFilters({ ...filters, label }),
    setPriority: (priority: string) => setBoardFilters({ ...filters, priority }),
    priorityChoices,
    showPriority:
      Boolean(filters.priority) ||
      entries.some((entry) => isOpenTask(entry.task) && entry.task.priority !== null),
    clear: () => setBoardFilters(noBoardFilters),
    clearable,
    assignees,
    labelChoices,
    activeTheme,
    searched,
    visible,
    counts,
    /** A filter or the search narrows the board: only then does an empty column say so. */
    narrowing: clearable > 0 || search !== '' || activeTheme !== null,
    /** The values the board is narrowed to by member, label and theme, for the subtitle. */
    values: [
      ...(activeTheme ? [activeTheme.title] : []),
      ...(filters.assignee ? [labelOf(assignees, filters.assignee)] : []),
      ...(filters.label ? [labelOf(labelChoices, filters.label)] : []),
      ...(filters.priority ? [priorityValue] : []),
    ],
    /** The chips of the phone list: what is set and how to take it off. */
    chips,
  };
}
