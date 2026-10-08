import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { MapGroup } from '@projectman/shared';

const FLIP_MS = 260;
const FLASH_MS = 600;

/** What a tile shows: when it changes in a live update, the tile flashes once. */
const signature = (group: MapGroup) => JSON.stringify([group.signals, group.progress]);

interface Snapshot {
  /** The filters the snapshot was taken under: a filter change is no live change. */
  scope: string;
  rects: Map<string, { x: number; y: number }>;
  signatures: Map<string, string>;
}

/**
 * The live update of the overview: a tile that moves slides to its new place (FLIP, 260 ms), a tile
 * whose signals or progress changed flashes once. Neither happens on the first load, on a filter
 * change, or with `prefers-reduced-motion`. `items` holds the tiles' elements by group key; the
 * result is the keys to flash now.
 */
export function useGroupMotion(
  listRef: RefObject<HTMLElement | null>,
  items: RefObject<Map<string, HTMLElement>>,
  groups: readonly MapGroup[],
  scope: string,
): ReadonlySet<string> {
  const previous = useRef<Snapshot | null>(null);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const origin = list.getBoundingClientRect();
    const rects = new Map<string, { x: number; y: number }>();
    for (const group of groups) {
      const element = items.current.get(group.key);
      if (!element) continue;
      const box = element.getBoundingClientRect();
      rects.set(group.key, { x: box.left - origin.left, y: box.top - origin.top });
    }
    const signatures = new Map(groups.map((group) => [group.key, signature(group)]));
    const before = previous.current;
    previous.current = { scope, rects, signatures };
    if (!before || before.scope !== scope) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const changed = new Set<string>();
    for (const group of groups) {
      const element = items.current.get(group.key);
      const from = before.rects.get(group.key);
      const to = rects.get(group.key);
      if (!element || !from || !to) continue;
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      if ((dx !== 0 || dy !== 0) && typeof element.animate === 'function') {
        element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
          duration: FLIP_MS,
          easing: 'ease-out',
        });
      }
      const was = before.signatures.get(group.key);
      if (was !== undefined && was !== signatures.get(group.key)) changed.add(group.key);
    }
    if (changed.size > 0) setFlashing(changed);
  }, [listRef, items, groups, scope]);

  useLayoutEffect(() => {
    if (flashing.size === 0) return;
    const timer = window.setTimeout(() => setFlashing(new Set()), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashing]);

  return flashing;
}
