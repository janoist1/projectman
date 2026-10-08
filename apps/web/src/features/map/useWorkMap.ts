import { useMemo } from 'react';
import { isStale, mapStateOf, workMap } from '@projectman/shared';
import type { MapGroup, MapState } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { t } from '../../i18n/t';
import { useNow } from '../../lib/useNow';
import { assigneeOptions, matchesAssignee } from '../board/boardFilters';
import type { FilterOption } from '../board/boardFilters';
import { useBoardModel } from '../board/useBoardModel';
import type { MapShow } from './mapFilters';

export interface MapTotals {
  needsYou: number;
  blocked: number;
  working: number;
  open: number;
}

/**
 * The overview's groups (PM-379), from the board's own data and the shared rule: the state of each
 * card is the one the board shows, a card is "stale" by the shared threshold. The member filter
 * narrows the signals (and drops the groups without that member's cards); the state filter only
 * hides the groups. The clock renews every minute, so a card that has stood still long enough turns
 * "Elakadt" without a reload.
 */
export function useWorkMap(show: MapShow, requestedMember: string) {
  const now = useNow(true, 60_000);
  const { board, model, pipeline } = useBoardModel();
  const { myHandle } = useProject();
  const tasks = board.data?.tasks;
  const team = board.data?.members;

  const assignees = useMemo<FilterOption[]>(() => {
    if (!model || !team) return [];
    const open = model.entries.filter((entry) => entry.state.phase !== 'cancelled');
    return assigneeOptions(open, team, model.ctx.members, myHandle, t('board.filterNoAssignee'));
  }, [model, team, myHandle]);
  // An unknown member (a stale link) is ignored, like an unknown `show`.
  const member = assignees.some((option) => option.value === requestedMember) ? requestedMember : '';

  const data = useMemo(() => {
    if (!tasks || !model || !pipeline) return null;
    const states = new Map<string, MapState | null>();
    const staleKeys = new Set<string>();
    for (const { task, state } of model.entries) {
      const stale = isStale(task, state.phase, pipeline.stageById.get(task.stageId)?.kind, now);
      states.set(task.key, mapStateOf(state.phase, stale));
      if (stale) staleKeys.add(task.key);
    }
    const unfiltered = workMap({ tasks, states });
    const scoped: MapGroup[] =
      member === ''
        ? unfiltered
        : workMap({
            tasks,
            states,
            counts: (key) => {
              const entry = model.byKey.get(key);
              return entry ? matchesAssignee(entry.task, member) : false;
            },
          });
    const totals = scoped.reduce<MapTotals>(
      (sum, group) => ({
        needsYou: sum.needsYou + group.signals.needsYou,
        blocked: sum.blocked + group.signals.blocked,
        working: sum.working + group.signals.working,
        open: sum.open + group.signals.open,
      }),
      { needsYou: 0, blocked: 0, working: 0, open: 0 },
    );
    const groups =
      show === 'needsYou'
        ? scoped.filter((group) => group.signals.needsYou > 0)
        : show === 'blocked'
          ? scoped.filter((group) => group.signals.blocked > 0)
          : scoped;
    const titles = new Map(tasks.map((task) => [task.key, task.title]));
    return {
      groups,
      /** Every group, whatever the filters (the zoomed view decides "not found" from it). */
      allGroups: unfiltered,
      /** The groups with the member filter applied: their signals count that member's cards only. */
      scopedGroups: scoped,
      states,
      staleKeys,
      now,
      totals,
      titles,
      /** No group at all, whatever the filters: nothing open in the project. */
      empty: unfiltered.length === 0,
      /** Only the "Egyéb" group: no open theme or collecting card yet. */
      firstUse: unfiltered.length > 0 && unfiltered.every((group) => group.kind === 'other'),
    };
  }, [tasks, model, pipeline, now, show, member]);

  return { board, pipeline, model, data, assignees, member };
}

/** A group's title: the card's own for a theme or collecting card, "Egyéb" for the rest. */
export function groupTitle(group: MapGroup, titles: ReadonlyMap<string, string>): string {
  return group.kind === 'other' ? t('map.other') : (titles.get(group.key) ?? group.key);
}
