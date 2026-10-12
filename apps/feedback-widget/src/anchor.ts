import type { FeedbackAnchor, FeedbackMarkView } from '@projectman/shared';

/**
 * Where a mark sits on the page now (PM-506). The lookup is a pure function of the stored anchor and
 * the document, so that it can be tested without a browser:
 *
 * 1. an element mark: the selector finds exactly one element, and its text still holds the saved
 *    snippet → the element's position;
 * 2. otherwise the saved document coordinate, flagged `changed` ("the element has changed since");
 * 3. otherwise (no coordinate, or one outside the document) → `lost`, the "no longer on the page" group.
 */
export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}

export type Resolution =
  | { place: 'page' }
  | { place: 'lost' }
  | { place: 'located'; changed: boolean; element: Element | null; point: Point; rect: Rect | null };

export interface DocumentSize {
  width: number;
  height: number;
}

export const SNIPPET_LENGTH = 120;
/** A coordinate this far past the document's edge still counts as on the page (scrollbars, rounding). */
const EDGE_TOLERANCE = 24;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The start of an element's visible text, saved with the mark to recognise the element later. */
export function snippetOf(element: Element): string | null {
  const text = collapse(element.textContent ?? '').slice(0, SNIPPET_LENGTH);
  return text === '' ? null : text;
}

export function findElement(selector: string, root: ParentNode): Element | null {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 ? (found[0] ?? null) : null;
  } catch {
    return null; // a selector the browser does not accept
  }
}

const insideDocument = (point: Point, size: DocumentSize): boolean =>
  point.x >= 0 &&
  point.y >= 0 &&
  point.x <= size.width + EDGE_TOLERANCE &&
  point.y <= size.height + EDGE_TOLERANCE;

export function resolveAnchor(anchor: FeedbackAnchor, root: ParentNode, size: DocumentSize): Resolution {
  switch (anchor.kind) {
    case 'page':
      return { place: 'page' };
    case 'area': {
      const rect = anchor.rect;
      if (!rect || !insideDocument(rect, size)) return { place: 'lost' };
      return { place: 'located', changed: false, element: null, point: { x: rect.x, y: rect.y }, rect };
    }
    case 'point': {
      const point = anchor.pagePoint;
      if (!point || !insideDocument(point, size)) return { place: 'lost' };
      return { place: 'located', changed: false, element: null, point, rect: null };
    }
    case 'element': {
      const element = anchor.selector ? findElement(anchor.selector, root) : null;
      const textMatches =
        element !== null &&
        (anchor.textSnippet === null || collapse(element.textContent ?? '').includes(anchor.textSnippet));
      if (element && textMatches) {
        return {
          place: 'located',
          changed: false,
          element,
          point: anchor.pagePoint ?? { x: 0, y: 0 },
          rect: null,
        };
      }
      const point = anchor.pagePoint;
      if (!point || !insideDocument(point, size)) return { place: 'lost' };
      return { place: 'located', changed: true, element: null, point, rect: null };
    }
  }
}

/**
 * The document coordinate of a located mark's tip: inside the live element for an exact match
 * (so the pin follows layout changes), else the saved coordinate.
 */
export function tipOf(resolution: Resolution, anchor: FeedbackAnchor, scroll: Point): Point | null {
  if (resolution.place !== 'located') return null;
  const { element } = resolution;
  if (element) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 || box.height > 0) {
      const offset = anchor.elementOffset ?? { x: 0.5, y: 0.5 };
      return { x: box.left + scroll.x + box.width * offset.x, y: box.top + scroll.y + box.height * offset.y };
    }
    // A hidden element has no box: fall back to the saved coordinate.
    return anchor.pagePoint ?? resolution.point;
  }
  return resolution.point;
}

/** A page belongs to the one it was made on when origin and path match (the query and fragment do not count). */
export function isSamePage(pageUrl: string, current: Pick<Location, 'origin' | 'pathname'>): boolean {
  try {
    const url = new URL(pageUrl);
    const strip = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);
    return url.origin === current.origin && strip(url.pathname) === strip(current.pathname);
  } catch {
    return false;
  }
}

export interface PanelGroups<M> {
  /** Marks about the whole page: no pin. */
  page: M[];
  /** Marks that have a place on the page (pinned). */
  pinned: M[];
  /** Element marks whose element and coordinate are both gone: no pin. */
  lost: M[];
}

/** The "this page" tab of the list: the whole-page group, the pinned marks, and the lost ones. */
export function groupForPanel<M extends Pick<FeedbackMarkView, 'id'>>(
  marks: M[],
  resolutionOf: (mark: M) => Resolution,
): PanelGroups<M> {
  const groups: PanelGroups<M> = { page: [], pinned: [], lost: [] };
  for (const mark of marks) {
    const place = resolutionOf(mark).place;
    if (place === 'page') groups.page.push(mark);
    else if (place === 'lost') groups.lost.push(mark);
    else groups.pinned.push(mark);
  }
  return groups;
}
