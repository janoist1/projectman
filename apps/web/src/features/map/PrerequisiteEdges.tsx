import { useCallback, useEffect, useId, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { Edge } from './groupModel';
import styles from './PrerequisiteEdges.module.css';

interface Path {
  from: string;
  to: string;
  d: string;
}

interface Drawing {
  width: number;
  height: number;
  paths: Path[];
}

/** How far a loop reaches out of the card side when both ends sit in one column (inside the 28 px gap). */
const LOOP = 14;
const CURVE = 56;

function pathBetween(from: DOMRect, to: DOMRect, origin: DOMRect): string {
  const left = (box: DOMRect) => box.left - origin.left;
  const right = (box: DOMRect) => box.right - origin.left;
  const middle = (box: DOMRect) => box.top - origin.top + box.height / 2;
  const y1 = middle(from);
  const y2 = middle(to);
  // The usual way: out of the prerequisite's right side, into the waiting card's left side.
  if (left(to) - right(from) >= LOOP) {
    const x1 = right(from);
    const x2 = left(to);
    const bend = Math.min(CURVE, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  }
  // The waiting card is a column before its prerequisite: out of the prerequisite's left side, into the
  // waiting card's right side, across the gap between them.
  if (left(from) - right(to) >= LOOP) {
    const x1 = left(from);
    const x2 = right(to);
    const bend = Math.min(CURVE, (x1 - x2) / 2);
    return `M ${x1} ${y1} C ${x1 - bend} ${y1}, ${x2 + bend} ${y2}, ${x2} ${y2}`;
  }
  // In one column: out of the right sides, around, into the waiting card's right side.
  const x1 = right(from);
  const x2 = right(to);
  const reach = Math.max(x1, x2) + LOOP;
  return `M ${x1} ${y1} C ${reach} ${y1}, ${reach} ${y2}, ${x2} ${y2}`;
}

/**
 * The "Előtte kell" arrows of the zoomed view (PM-407): a decorative SVG layer over the cards' place, drawn
 * from where the cards are (measured again when the layer resizes), behind the cards. It takes no pointer
 * and no screen reader: the same wait is in the card's text. Only the edges it is given are drawn.
 */
export function PrerequisiteEdges({
  containerRef,
  edges,
  active,
  layout,
}: {
  /** The positioned box that holds the cards (`[data-card-key]`) and this layer. */
  containerRef: RefObject<HTMLElement | null>;
  edges: readonly Edge[];
  /** The card looked at: its arrows are drawn strong. */
  active: string | null;
  /** Changes when the cards move without the box resizing (a live update, a filter). */
  layout: string;
}) {
  const marker = useId();
  const [drawing, setDrawing] = useState<Drawing>({ width: 0, height: 0, paths: [] });

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const origin = container.getBoundingClientRect();
    const boxes = new Map<string, DOMRect>();
    for (const element of container.querySelectorAll<HTMLElement>('[data-card-key]')) {
      boxes.set(element.dataset.cardKey ?? '', element.getBoundingClientRect());
    }
    const paths: Path[] = [];
    for (const edge of edges) {
      const from = boxes.get(edge.from);
      const to = boxes.get(edge.to);
      if (from && to) paths.push({ from: edge.from, to: edge.to, d: pathBetween(from, to, origin) });
    }
    setDrawing({ width: origin.width, height: origin.height, paths });
  }, [containerRef, edges]);

  // Before paint, so the arrows never lag a frame behind the cards.
  useLayoutEffect(() => {
    measure();
  }, [measure, layout]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // The box is attached after this layer's own layout effect on the first draw: measure once more.
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [containerRef, measure]);

  const idle = `${marker}-idle`;
  const lit = `${marker}-lit`;
  return (
    <svg
      className={styles.layer}
      width={drawing.width}
      height={drawing.height}
      viewBox={`0 0 ${drawing.width} ${drawing.height}`}
      aria-hidden="true"
      focusable="false"
      data-edge-layer=""
    >
      <defs>
        <marker
          id={idle}
          className={styles.idleHead}
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
        <marker
          id={lit}
          className={styles.litHead}
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
      </defs>
      {drawing.paths.map(({ from, to, d }) => {
        const strong = active !== null && (from === active || to === active);
        return (
          <path
            key={`${from}>${to}`}
            d={d}
            className={strong ? styles.lit : styles.edge}
            data-edge=""
            data-from={from}
            data-to={to}
            markerEnd={`url(#${strong ? lit : idle})`}
          />
        );
      })}
    </svg>
  );
}
