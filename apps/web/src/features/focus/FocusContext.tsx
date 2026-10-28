import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { isTheme } from '@projectman/shared';
import type { FocusPlace, Task } from '@projectman/shared';
import { useBoard } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { useProjectFocus } from './useProjectFocus';

type FocusState = ReturnType<typeof useProjectFocus>;

export interface FocusContextValue extends FocusState {
  /** Every card and theme the board knows; an item that is not in it (a closed card) is shown by its key. */
  tasksByKey: ReadonlyMap<string, Task>;
}

const FocusContext = createContext<FocusContextValue | null>(null);

/**
 * The project's focus for every screen of the project, taken once: the marks on the cards read the places
 * from here, so a board of many cards does not work the places out for each of them (PM-438).
 */
export function FocusProvider({ children }: { children: ReactNode }) {
  const { key } = useProject();
  const focus = useProjectFocus();
  const tasks = useBoard(key).data?.tasks;
  const tasksByKey = useMemo(() => new Map((tasks ?? []).map((task) => [task.key, task])), [tasks]);
  return <FocusContext.Provider value={{ ...focus, tasksByKey }}>{children}</FocusContext.Provider>;
}

/** What a screen outside a project's layout gets: no focus is shown, nothing can be changed. */
const NO_FOCUS: FocusContextValue = {
  visible: false,
  loading: false,
  loadFailed: false,
  reload: () => {},
  items: [],
  canEdit: false,
  full: false,
  places: new Map(),
  saving: false,
  add: () => Promise.resolve(),
  move: () => Promise.resolve(),
  remove: () => Promise.resolve(),
  tasksByKey: new Map(),
};

/** The focus, for a screen that is part of it (the strip, the panel, the card's row, the filter). */
export function useFocus(): FocusContextValue {
  return useContext(FocusContext) ?? NO_FOCUS;
}

/** What puts a card in the focus: the item that covers it, when it is not the card itself. */
export type FocusVia = { kind: 'theme'; key: string; title: string } | { kind: 'card'; key: string };

export interface FocusPlaceView {
  position: number;
  via: FocusVia | null;
}

/** The place of a card or theme, or null: not in the focus, the viewer may not see it, or no focus around. */
export function useFocusPlace(taskKey: string): FocusPlaceView | null {
  const value = useFocus();
  const place: FocusPlace | undefined = value.visible ? value.places.get(taskKey) : undefined;
  if (!place) return null;
  const via = place.via ? value.tasksByKey.get(place.via) : undefined;
  return {
    position: place.position,
    via: !place.via
      ? null
      : via && isTheme(via)
        ? { kind: 'theme', key: via.key, title: via.title }
        : { kind: 'card', key: place.via },
  };
}
