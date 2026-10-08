import { createContext, useContext, useMemo } from 'react';
import { useProject } from '../../app/contexts';

/**
 * Where the open card's drawer leads (PM-407): the drawer sits over the board (`/p/AC`) or over the
 * map's zoomed group (`/p/AC/map/AC-12`). `close` is the path it closes to; `card` is the path of a
 * card (or of one of its views, `sub`: "thread") in the same place.
 */
export interface DrawerBase {
  close: string;
  card: (taskKey: string, sub?: string) => string;
}

/** The base the board's drawer has: no provider above it means the board. */
export const DrawerBaseContext = createContext<DrawerBase | null>(null);

export function useDrawerBase(): DrawerBase {
  const base = useContext(DrawerBaseContext);
  const { key } = useProject();
  return useMemo(
    () =>
      base ?? {
        close: `/p/${key}`,
        card: (taskKey, sub) => `/p/${key}/tasks/${taskKey}${sub ? `/${sub}` : ''}`,
      },
    [base, key],
  );
}

/** Adds one query parameter to a path that may carry a query already. */
export function withQueryParam(path: string, name: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(value)}`;
}
