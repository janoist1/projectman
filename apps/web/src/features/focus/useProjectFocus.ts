import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PROJECT_FOCUS_MAX_ITEMS, projectFocusPlaces } from '@projectman/shared';
import type { FocusPlace, ProjectFocusItem, Task } from '@projectman/shared';
import { useBoard } from '../../api/queries';
import { api } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';
import { useProject } from '../../app/contexts';
import { savesFor } from './focusSaves';

const NO_ITEMS: readonly ProjectFocusItem[] = [];

const NO_PLACES: ReadonlyMap<string, FocusPlace> = new Map();

/** The shared rule, taken once for a list and a card list (the same arrays give the same answer). */
const placesCache = new WeakMap<object, WeakMap<object, ReadonlyMap<string, FocusPlace>>>();
function placesOf(
  items: readonly ProjectFocusItem[],
  tasks: readonly Task[],
): ReadonlyMap<string, FocusPlace> {
  let byTasks = placesCache.get(items);
  if (!byTasks) {
    byTasks = new WeakMap();
    placesCache.set(items, byTasks);
  }
  let places = byTasks.get(tasks);
  if (!places) {
    places = projectFocusPlaces(items, tasks);
    byTasks.set(tasks, places);
  }
  return places;
}

/** Moves the item at `from` to the 1-based `position`, clamped to the list. */
function moved(items: readonly ProjectFocusItem[], key: string, position: number): ProjectFocusItem[] {
  const from = items.findIndex((item) => item.key === key);
  if (from < 0) return items.slice();
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(Math.min(Math.max(position, 1), next.length + 1) - 1, 0, item!);
  return next;
}

/**
 * The project's focus (PM-427 4/4). Every member sees it (the client sees everything, decision 59, PM-79);
 * `canEdit` is the server's word on who sets it, so a client reads it and changes nothing. The list is the
 * server's, with the saves that are on their way applied on top, so a change shows at once and goes back by itself
 * when the server refuses it (the save then rejects; the caller shows the error).
 */
export function useProjectFocus() {
  const { key, me, myHandle } = useProject();
  const client = useQueryClient();
  const access = me.projects.find((project) => project.key === key)?.access;
  const visible = access !== undefined;
  const query = useQuery({
    queryKey: queryKeys.focus(key),
    queryFn: () => api.projectFocus(key),
    enabled: visible,
  });
  const saves = savesFor(client, key);
  const changes = useSyncExternalStore(saves.subscribe, saves.snapshot);
  const serverItems = visible ? query.data?.items : undefined;
  const items = useMemo<readonly ProjectFocusItem[]>(
    () =>
      serverItems
        ? changes.reduce<readonly ProjectFocusItem[]>((list, change) => change.apply(list), serverItems)
        : NO_ITEMS,
    [serverItems, changes],
  );
  const tasks = useBoard(key).data?.tasks;
  const places = useMemo<ReadonlyMap<string, FocusPlace>>(
    () => (visible && tasks ? placesOf(items, tasks) : NO_PLACES),
    [visible, items, tasks],
  );

  const add = useCallback(
    (taskKey: string, position?: number): Promise<void> =>
      saves.save(
        (list) => {
          if (list.some((item) => item.key === taskKey)) return list.slice();
          const at = Math.min(Math.max(position ?? list.length + 1, 1), list.length + 1);
          const item: ProjectFocusItem = {
            key: taskKey,
            addedAt: new Date().toISOString(),
            addedBy: { kind: 'human', handle: myHandle },
          };
          return [...list.slice(0, at - 1), item, ...list.slice(at - 1)];
        },
        () => api.addFocusItem(key, taskKey, position),
      ),
    [saves, key, myHandle],
  );
  const move = useCallback(
    (taskKey: string, position: number): Promise<void> =>
      saves.save(
        (list) => moved(list, taskKey, position),
        () => api.moveFocusItem(key, taskKey, position),
      ),
    [saves, key],
  );
  const remove = useCallback(
    (taskKey: string): Promise<void> =>
      saves.save(
        (list) => list.filter((item) => item.key !== taskKey),
        () => api.removeFocusItem(key, taskKey),
      ),
    [saves, key],
  );

  return {
    /** Whether the viewer is a member of the project, so the focus is theirs to see. */
    visible,
    /** The list is not known yet. */
    loading: visible && query.isPending,
    /** The list could not be loaded. */
    loadFailed: visible && query.isError && !query.data,
    reload: () => void query.refetch(),
    items,
    /** The viewer's right to change the list, as the server says it. */
    canEdit: visible && query.data?.canEdit === true,
    full: items.length >= PROJECT_FOCUS_MAX_ITEMS,
    /** Key -> place of every open card and theme the focus covers. */
    places,
    /** Whether a save is on its way. */
    saving: changes.length > 0,
    add,
    move,
    remove,
  };
}
