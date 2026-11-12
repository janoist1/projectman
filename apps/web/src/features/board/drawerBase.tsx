import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useProject } from '../../app/contexts';

/**
 * Where the open card's drawer leads (PM-407): the drawer sits over the board (`/p/AC`) or over the
 * structure map (`/p/AC/map`). `close` is the path it closes to; `card` is the path of a
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

/** An element the focus can go to: still on the page and not under an inert or hidden ancestor. */
function canTakeFocus(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected && !element.closest('[inert],[hidden]');
}

/** The card links a drawer opens from: the board's cards and the inbox rows. */
const CARD_LINK = '[data-card-key] a, [data-inbox-card-link]';
/** How long a click on a card link counts as what opened the drawer. */
const OPENING_CLICK_MS = 1000;
let lastCardClick: { link: HTMLElement; at: number } | null = null;
// Safari does not focus a link on a mouse click, so the click itself is the only trace of the opener.
if (typeof document !== 'undefined')
  document.addEventListener(
    'click',
    (event) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLElement>(CARD_LINK) : null;
      lastCardClick = link ? { link, at: Date.now() } : null;
    },
    true,
  );

/** The element that opened the drawer: the focused one, else the card link just clicked. */
function currentOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  return lastCardClick && Date.now() - lastCardClick.at < OPENING_CLICK_MS ? lastCardClick.link : null;
}

/**
 * Gives the focus back when the card's drawer closes to its base (PM-1358). The opener is remembered once, as the
 * drawer opens, and stays the same while the user moves on to another card inside it. The target is that opener
 * while it is on the page, else the closed card's own link on the board, else the page region (`#main`).
 * Returns the close function; leaving the drawer by another route (a menu, a link) does not touch the focus.
 */
export function useDrawerFocusReturn(taskKey: string): () => void {
  const base = useDrawerBase();
  const navigate = useNavigate();
  const opener = useRef<HTMLElement | null>(null);
  const closing = useRef(false);
  const closedKey = useRef(taskKey);
  closedKey.current = taskKey;

  // Before any other effect of the drawer moves the focus (the heading takes it).
  useLayoutEffect(() => {
    opener.current = currentOpener();
  }, []);

  // The drawer is gone with this commit, its inert window lifted: a frame later the focus can land.
  useEffect(
    () => () => {
      if (!closing.current) return;
      const from = opener.current;
      const key = closedKey.current;
      requestAnimationFrame(() => {
        const target = canTakeFocus(from)
          ? from
          : document.querySelector<HTMLElement>(`[data-card-key="${key}"] a`);
        (canTakeFocus(target) ? target : document.getElementById('main'))?.focus();
      });
    },
    [],
  );

  return useCallback(() => {
    closing.current = true;
    navigate(base.close);
  }, [base.close, navigate]);
}

/** Adds one query parameter to a path that may carry a query already. */
export function withQueryParam(path: string, name: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(value)}`;
}
