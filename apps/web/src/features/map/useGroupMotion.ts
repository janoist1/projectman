import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { MapGroup } from '@projectman/shared';

const FLIP_MS = 260;
const FLASH_MS = 600;

/** What a tile shows: when it changes in a live update, the tile flashes once. */
const signature = (group: MapGroup) => JSON.stringify([group.signals, group.progress]);

export interface LiveItem {
  key: string;
  /** What the item shows: when it changes in a live update, the item flashes once. */
  signature: string;
}

interface Snapshot {
  /** The filters the snapshot was taken under: a filter change is no live change. */
  scope: string;
  rects: Map<string, { x: number; y: number }>;
  signatures: Map<string, string>;
}

/**
 * The live update of the map (PM-379): an item that moves slides to its new place (FLIP, 260 ms), an item
 * whose signature changed flashes once. Neither happens on the first load, on a filter change, or with
 * `prefers-reduced-motion`. `items` holds the elements by key; the result is the keys to flash now.
 */
export function useLiveMotion(
  listRef: RefObject<HTMLElement | null>,
  items: RefObject<Map<string, HTMLElement>>,
  entries: readonly LiveItem[],
  scope: string,
): ReadonlySet<string> {
  const previous = useRef<Snapshot | null>(null);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const origin = list.getBoundingClientRect();
    const rects = new Map<string, { x: number; y: number }>();
    for (const { key } of entries) {
      const element = items.current.get(key);
      if (!element) continue;
      const box = element.getBoundingClientRect();
      rects.set(key, { x: box.left - origin.left, y: box.top - origin.top });
    }
    const signatures = new Map(entries.map((entry) => [entry.key, entry.signature]));
    const before = previous.current;
    previous.current = { scope, rects, signatures };
    if (!before || before.scope !== scope) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const changed = new Set<string>();
    for (const { key } of entries) {
      const element = items.current.get(key);
      const from = before.rects.get(key);
      const to = rects.get(key);
      if (!element || !from || !to) continue;
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      if ((dx !== 0 || dy !== 0) && typeof element.animate === 'function') {
        element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
          duration: FLIP_MS,
          easing: 'ease-out',
        });
      }
      const was = before.signatures.get(key);
      if (was !== undefined && was !== signatures.get(key)) changed.add(key);
    }
    if (changed.size > 0) setFlashing(changed);
  }, [listRef, items, entries, scope]);

  useLayoutEffect(() => {
    if (flashing.size === 0) return;
    const timer = window.setTimeout(() => setFlashing(new Set()), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashing]);

  return flashing;
}

/** The overview's tiles: a tile that moves slides, a tile whose signals or progress changed flashes. */
export function useGroupMotion(
  listRef: RefObject<HTMLElement | null>,
  items: RefObject<Map<string, HTMLElement>>,
  groups: readonly MapGroup[],
  scope: string,
): ReadonlySet<string> {
  const entries = useMemo(
    () => groups.map((group) => ({ key: group.key, signature: signature(group) })),
    [groups],
  );
  return useLiveMotion(listRef, items, entries, scope);
}
