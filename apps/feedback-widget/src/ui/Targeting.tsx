import { useRef, useState } from 'preact/hooks';
import type { Controller, Mode, Target } from '../controller';
import { snippetOf } from '../anchor';
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

function elementTarget(element: Element, click: Point): Target {
  const box = element.getBoundingClientRect();
  const selector = selectorFor(element);
  const pagePoint = { x: click.x + window.scrollX, y: click.y + window.scrollY };
  if (!selector) return pointTarget(click); // an element no selector can name is marked as a point
  return {
    kind: 'element',
    anchor: {
      kind: 'element',
      selector,
      textSnippet: snippetOf(element),
      elementOffset: {
        x: box.width > 0 ? clamp01((click.x - box.left) / box.width) : 0.5,
        y: box.height > 0 ? clamp01((click.y - box.top) / box.height) : 0.5,
      },
      pagePoint,
      rect: null,
    },
    label: describeElement(element),
    viewportRect: toBox(box),
    viewportPoint: click,
  };
}

function pointTarget(click: Point): Target {
  return {
    kind: 'point',
    anchor: {
      kind: 'point',
      selector: null,
      textSnippet: null,
      elementOffset: null,
      pagePoint: { x: click.x + window.scrollX, y: click.y + window.scrollY },
      rect: null,
    },
    label: t('new.whatPoint'),
    viewportRect: null,
    viewportPoint: click,
  };
}

function areaTarget(rect: Rect): Target {
  return {
    kind: 'area',
    anchor: {
      kind: 'area',
      selector: null,
      textSnippet: null,
      elementOffset: null,
      pagePoint: null,
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
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

  const pointOf = (event: PointerEvent): Point => ({ x: event.clientX, y: event.clientY });

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
    if (mode === 'area') {
      if (!drag) return;
      const rect = rectOf(drag.from, at);
      setDrag(null);
      if (rect.width < MIN_AREA && rect.height < MIN_AREA) controller.chooseTarget(pointTarget(at));
      else controller.chooseTarget(areaTarget(rect));
      return;
    }
    if (mode === 'point') {
      controller.chooseTarget(pointTarget(at));
      return;
    }
    const found = overlay.current ? elementUnder(overlay.current, at) : null;
    controller.chooseTarget(found ? elementTarget(found, at) : pointTarget(at));
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
