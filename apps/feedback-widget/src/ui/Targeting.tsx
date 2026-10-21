import { useEffect, useRef, useState } from 'preact/hooks';
import type { Controller, Mode, Target } from '../controller';
import { containsRect, fractionsIn, isReliableContainer, snippetOf } from '../anchor';
import type { Point, Rect } from '../anchor';
import { HOST_ATTRIBUTE } from '../screenshot';
import { describeElement, selectorFor } from '../selector';
import { t } from '../i18n';
import { clamp01 } from './layout';

/** A drag shorter than this (both sides) is a click: a point mark. */
const MIN_AREA = 4;

const rectOf = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

/** The server refuses an area narrower than this on either side: a thin drag is widened to it. */
const atLeastMin = (rect: Rect): Rect => ({
  ...rect,
  width: Math.max(rect.width, MIN_AREA),
  height: Math.max(rect.height, MIN_AREA),
});

/** The pointer can leave the window while it is captured: the anchor stays inside the viewport. */
const clampToViewport = (point: Point): Point => ({
  x: Math.min(Math.max(point.x, 0), window.innerWidth),
  y: Math.min(Math.max(point.y, 0), window.innerHeight),
});

const toBox = (box: DOMRect): Rect => ({ x: box.left, y: box.top, width: box.width, height: box.height });

/**
 * The page element under the pointer, looking through the overlay that catches the pointer, and
 * skipping the widget's own parts.
 */
function elementUnder(overlay: HTMLElement, point: Point): Element | null {
  const previous = overlay.style.pointerEvents;
  overlay.style.pointerEvents = 'none';
  const found = document.elementFromPoint(point.x, point.y);
  overlay.style.pointerEvents = previous;
  if (!found || found.closest(`[${HOST_ATTRIBUTE}]`)) return null;
  if (found === document.documentElement) return document.body;
  return found;
}

const offsetIn = (box: DOMRect, click: Point): Point => ({
  x: box.width > 0 ? clamp01((click.x - box.left) / box.width) : 0.5,
  y: box.height > 0 ? clamp01((click.y - box.top) / box.height) : 0.5,
});

function elementTarget(element: Element, click: Point): Target {
  const box = element.getBoundingClientRect();
  const selector = selectorFor(element);
  const pagePoint = { x: click.x + window.scrollX, y: click.y + window.scrollY };
  if (!selector) return pointTarget(click, null); // an element no selector can name is marked as a point
  return {
    kind: 'element',
    anchor: {
      kind: 'element',
      selector,
      textSnippet: snippetOf(element),
      elementOffset: offsetIn(box, click),
      pagePoint,
      rect: null,
    },
    label: describeElement(element),
    viewportRect: toBox(box),
    viewportPoint: click,
  };
}

const documentSize = () => ({
  width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
  height: Math.max(document.documentElement.scrollHeight, window.innerHeight),
});

/** The element's box in document coordinates, or null when it cannot hold a pinned mark. */
function reliableBox(element: Element | null): { selector: string; box: DOMRect } | null {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  const inDocument = {
    x: box.left + window.scrollX,
    y: box.top + window.scrollY,
    width: box.width,
    height: box.height,
  };
  if (!isReliableContainer(element, inDocument, documentSize())) return null;
  const selector = selectorFor(element);
  return selector ? { selector, box } : null;
}

/** A point is pinned to the element under it when there is a reliable one (PM-917); else it is just a coordinate. */
function pointTarget(click: Point, under: Element | null): Target {
  const pinned = reliableBox(under);
  return {
    kind: 'point',
    anchor: {
      kind: 'point',
      selector: pinned?.selector ?? null,
      textSnippet: under && pinned ? snippetOf(under) : null,
      elementOffset: pinned ? offsetIn(pinned.box, click) : null,
      pagePoint: { x: click.x + window.scrollX, y: click.y + window.scrollY },
      rect: null,
    },
    label: t('new.whatPoint'),
    viewportRect: null,
    viewportPoint: click,
  };
}

/** The smallest element around the middle of the area that holds the whole area. */
function containerOf(under: Element | null, rect: Rect): Element | null {
  for (let element = under; element; element = element.parentElement) {
    if (element === document.body || element === document.documentElement) return null;
    if (containsRect(toBox(element.getBoundingClientRect()), rect)) return element;
  }
  return null;
}

/** An area is pinned to the smallest element that holds it, with its rectangle as fractions of that element. */
function areaTarget(rect: Rect, under: Element | null): Target {
  const container = containerOf(under, rect);
  const pinned = reliableBox(container);
  return {
    kind: 'area',
    anchor: {
      kind: 'area',
      selector: pinned?.selector ?? null,
      textSnippet: container && pinned ? snippetOf(container) : null,
      elementOffset: null,
      pagePoint: null,
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      elementRect: pinned ? fractionsIn(toBox(pinned.box), rect) : null,
    },
    label: t('new.whatArea'),
    viewportRect: rect,
    viewportPoint: { x: rect.x, y: rect.y },
  };
}

/** The target hint and a transparent layer that catches the choosing click or drag. */
export function Targeting({ controller, mode }: { controller: Controller; mode: Mode }) {
  const overlay = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const moved = useRef(false);

  // The frame is in viewport coordinates: a scroll or a resize leaves it on the wrong element.
  useEffect(() => {
    const forget = (): void => setHover(null);
    window.addEventListener('scroll', forget, true);
    window.addEventListener('resize', forget);
    return () => {
      window.removeEventListener('scroll', forget, true);
      window.removeEventListener('resize', forget);
    };
  }, []);

  const pointOf = (event: PointerEvent): Point => clampToViewport({ x: event.clientX, y: event.clientY });

  const onMove = (event: PointerEvent): void => {
    const at = pointOf(event);
    if (mode === 'area') {
      if (drag) {
        moved.current = true;
        setDrag({ from: drag.from, to: at });
      }
      return;
    }
    if (mode === 'element' && overlay.current) {
      const found = elementUnder(overlay.current, at);
      setHover(found ? toBox(found.getBoundingClientRect()) : null);
    }
  };

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const at = pointOf(event);
    if (mode === 'area') {
      overlay.current?.setPointerCapture?.(event.pointerId);
      moved.current = false;
      setDrag({ from: at, to: at });
    }
  };

  const onUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const at = pointOf(event);
    const underAt = (point: Point): Element | null =>
      overlay.current ? elementUnder(overlay.current, point) : null;
    if (mode === 'area') {
      if (!drag) return;
      const rect = rectOf(drag.from, at);
      setDrag(null);
      if (rect.width < MIN_AREA && rect.height < MIN_AREA)
        controller.chooseTarget(pointTarget(at, underAt(at)));
      else {
        const area = atLeastMin(rect);
        controller.chooseTarget(
          areaTarget(area, underAt({ x: area.x + area.width / 2, y: area.y + area.height / 2 })),
        );
      }
      return;
    }
    if (mode === 'point') {
      controller.chooseTarget(pointTarget(at, underAt(at)));
      return;
    }
    const found = underAt(at);
    controller.chooseTarget(found ? elementTarget(found, at) : pointTarget(at, null));
  };

  const dragged = drag ? rectOf(drag.from, drag.to) : null;
  const frame = dragged ?? (mode === 'element' ? hover : null);
  return (
    <>
      <div
        ref={overlay}
        class={`target t-${mode}`}
        data-mode={mode}
        onPointerMove={onMove}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={() => setDrag(null)}
      />
      {frame && (
        <div
          class={`target-frame${dragged ? ' area' : ''}`}
          style={{
            left: `${frame.x}px`,
            top: `${frame.y}px`,
            width: `${frame.width}px`,
            height: `${frame.height}px`,
          }}
          aria-hidden="true"
        />
      )}
      <div class="hint" role="status">
        <span class="hint-text">{t(`target.${mode}`)}</span>
        <button type="button" class="hint-page" onClick={() => controller.choosePage()}>
          {t('target.page')}
        </button>
        <span class="hint-esc">{t('target.escape')}</span>
      </div>
    </>
  );
}
