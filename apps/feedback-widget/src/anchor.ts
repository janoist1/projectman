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

/** The element a mark is pinned to, when the selector finds exactly one and its text still holds the snippet. */
function liveElement(anchor: FeedbackAnchor, root: ParentNode): Element | null {
  const element = anchor.selector ? findElement(anchor.selector, root) : null;
  if (!element) return null;
  const textMatches =
    anchor.textSnippet === null || collapse(element.textContent ?? '').includes(anchor.textSnippet);
  return textMatches ? element : null;
}

export function resolveAnchor(anchor: FeedbackAnchor, root: ParentNode, size: DocumentSize): Resolution {
  if (anchor.kind === 'page') return { place: 'page' };
  // Points and areas are pinned to an element only when they carry a selector (PM-917); older ones do not.
  const pinned = anchor.selector !== null;
  const element = liveElement(anchor, root);
  const saved = anchor.kind === 'area' ? anchor.rect : null;
  const savedPoint: Point | null =
    anchor.kind === 'area' ? saved && { x: saved.x, y: saved.y } : anchor.pagePoint;
  if (element) {
    return { place: 'located', changed: false, element, point: savedPoint ?? { x: 0, y: 0 }, rect: saved };
  }
  // The element is gone or has changed: the saved coordinate, flagged; then nothing (the "gone" group).
  if (!savedPoint || !insideDocument(savedPoint, size)) return { place: 'lost' };
  const changed = anchor.kind === 'element' || pinned;
  return { place: 'located', changed, element: null, point: savedPoint, rect: saved };
}

const documentBox = (box: DOMRect, scroll: Point): Rect => ({
  x: box.left + scroll.x,
  y: box.top + scroll.y,
  width: box.width,
  height: box.height,
});

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
      const area = areaOf(resolution, anchor, scroll);
      if (anchor.kind === 'area' && area) return { x: area.x, y: area.y };
      const offset = anchor.elementOffset ?? { x: 0.5, y: 0.5 };
      return { x: box.left + scroll.x + box.width * offset.x, y: box.top + scroll.y + box.height * offset.y };
    }
    // A hidden element has no box: fall back to the saved coordinate.
    return anchor.pagePoint ?? resolution.point;
  }
  return resolution.point;
}

/**
 * The document rectangle of a located area: its saved fractions of the live element's box (so it
 * follows layout changes), else the saved rectangle. Null for anything that is not an area.
 */
export function areaOf(resolution: Resolution, anchor: FeedbackAnchor, scroll: Point): Rect | null {
  if (resolution.place !== 'located' || anchor.kind !== 'area') return null;
  const { element } = resolution;
  if (element && anchor.elementRect) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return rectFrom(documentBox(box, scroll), anchor.elementRect);
  }
  return resolution.rect;
}

// --- pinning a new point or area to an element (PM-917)

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** `rect` as fractions of `box` (both in the same coordinates), kept inside the box. */
export function fractionsIn(box: Rect, rect: Rect): Rect {
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0, width: 1, height: 1 };
  const x = clamp01((rect.x - box.x) / box.width);
  const y = clamp01((rect.y - box.y) / box.height);
  return {
    x,
    y,
    width: Math.min(clamp01(rect.width / box.width), 1 - x),
    height: Math.min(clamp01(rect.height / box.height), 1 - y),
  };
}

/** The inverse of `fractionsIn`: the fractions applied to a box. */
export function rectFrom(box: Rect, fractions: Rect): Rect {
  return {
    x: box.x + box.width * fractions.x,
    y: box.y + box.height * fractions.y,
    width: box.width * fractions.width,
    height: box.height * fractions.height,
  };
}

/** Whether `outer` holds `inner` entirely, give or take `tolerance` pixels. */
export function containsRect(outer: Rect, inner: Rect, tolerance = 1): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/** The share of the document a container may cover and still tell a place apart. */
const MAX_CONTAINER_SHARE = 0.8;

/**
 * A container is reliable unless it is `<html>`/`<body>` or covers at least 80% of the document's
 * area: such a box moves with the whole page, so a place inside it says little. `box` is in document
 * coordinates.
 */
export function isReliableContainer(element: Element, box: Rect, doc: DocumentSize): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body') return false;
  if (box.width <= 0 || box.height <= 0) return false;
  return box.width * box.height < MAX_CONTAINER_SHARE * doc.width * doc.height;
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
