import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import { t } from '../i18n/t';

export const MOBILE_QUERY = '(max-width: 767px)';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/**
 * The titles the mounted views want. The view that rendered last shows (a card's drawer over a page) and gives way
 * when it closes. The order is the first render's, not the effects': a child mounting in the same commit as its
 * parent runs its effect first, and must still win.
 */
interface TitleEntry {
  title: string;
  order: number;
}
const mountedTitles = new Set<TitleEntry>();
let renderCount = 0;

function showTopTitle(): void {
  let top: TitleEntry | null = null;
  for (const entry of mountedTitles) if (!top || entry.order > top.order) top = entry;
  if (top?.title) document.title = top.title;
}

/** "Folyamat · Acme webshop · projectman" */
export function useDocumentTitle(...parts: Array<string | null | undefined>): void {
  const title = [...parts.filter(Boolean), t('app.name')].join(' · ');
  const entry = useRef<TitleEntry | null>(null);
  entry.current ??= { title: '', order: ++renderCount };
  useEffect(() => {
    const mine = entry.current!;
    mountedTitles.add(mine);
    return () => {
      mountedTitles.delete(mine);
      showTopTitle();
    };
  }, []);
  useEffect(() => {
    entry.current!.title = title;
    showTopTitle();
  }, [title]);
}

/** Closes a popover on outside pointer-down and on Escape (focus returns to the trigger). */
export function useDismiss(
  open: boolean,
  onClose: () => void,
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
  returnFocusTo?: RefObject<HTMLElement | null>,
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && refs.some((ref) => ref.current?.contains(target))) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closeRef.current();
      returnFocusTo?.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, refs, returnFocusTo]);
}

const storagePrefix = 'pm:';

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(storagePrefix + key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(storagePrefix + key, value);
  } catch {
    // Storage can be unavailable (private mode); remembering is only a convenience.
  }
}
