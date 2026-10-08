import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/** The navigation state "‹ Térkép" carries: the group the viewer comes back from. */
export interface ReturnState {
  focusGroup?: string;
}

/** The group last zoomed into, for a return by the browser's Back, which carries no state of ours. */
let lastZoomed: string | null = null;

export function rememberZoomed(groupKey: string | null) {
  lastZoomed = groupKey;
}

/**
 * Back on the overview from a group's zoomed view, the focus goes to that group's tile (PM-407): by
 * "‹ Térkép" (its state names the group) or by the browser's Back. Any other arrival leaves the focus
 * where it is. `ready`: the tiles are drawn.
 */
export function useReturnFocus(listRef: RefObject<HTMLElement | null>, ready: boolean) {
  const location = useLocation();
  const type = useNavigationType();
  const target = useRef<string | null | undefined>(undefined);
  if (target.current === undefined) {
    const state = location.state as ReturnState | null;
    target.current = state?.focusGroup ?? (type === 'POP' ? lastZoomed : null);
    lastZoomed = null;
  }
  useEffect(() => {
    if (!ready || !target.current) return;
    const tile = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-group]') ?? []).find(
      (element) => element.dataset.group === target.current,
    );
    tile?.querySelector<HTMLElement>('a')?.focus();
    target.current = null;
  }, [listRef, ready]);
}
