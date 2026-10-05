import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import styles from './Flow.module.css';

export interface FlowReturn {
  fromId: string;
  toId: string;
}

interface Drawing {
  width: number;
  height: number;
  line: { x1: number; y1: number; x2: number; y2: number } | null;
  arcs: string[];
}

/**
 * The line through the marks of a flow (the elements with `data-glyph`, in document order) and a
 * dashed return arc for each of `returns` (a stage handing work back to an earlier one). It only
 * decorates: the text next to the marks says the same. Redrawn when the flow resizes or `watch` changes.
 */
export function FlowLine({
  containerRef,
  returns,
  watch,
}: {
  containerRef: RefObject<HTMLElement | null>;
  returns: readonly FlowReturn[];
  watch?: unknown;
}) {
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const returnsKey = returns.map((entry) => `${entry.fromId}>${entry.toId}`).join(',');
  // A passive effect: the flow (the parent) gets its ref only after this child's layout effects ran.
  useEffect(() => {
    const flow = containerRef.current;
    if (!flow) return;
    const draw = () => setDrawing(measure(flow, returns));
    draw();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(draw);
    observer.observe(flow);
    return () => observer.disconnect();
    // `returns` is compared by its content (returnsKey).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, returnsKey, watch]);
  if (!drawing?.line) return null;
  const { line } = drawing;
  return (
    <svg
      className={styles.line}
      width={drawing.width}
      height={drawing.height}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <marker
          id="flow-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 10 5 0 10z" style={{ fill: 'var(--c-ink-4)' }} />
        </marker>
      </defs>
      <line {...line} style={{ stroke: 'var(--c-mark-ready)' }} strokeWidth="2" />
      {drawing.arcs.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          style={{ stroke: 'var(--c-ink-4)' }}
          strokeWidth="1.5"
          strokeDasharray="4 3"
          markerEnd="url(#flow-arrow)"
        />
      ))}
    </svg>
  );
}

function measure(flow: HTMLElement, returns: readonly FlowReturn[]): Drawing {
  const box = flow.getBoundingClientRect();
  const centre = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2 };
  };
  const marks = [...flow.querySelectorAll('[data-glyph]')];
  const first = marks[0];
  const last = marks[marks.length - 1];
  if (!first || !last) return { width: box.width, height: box.height, line: null, arcs: [] };
  const a = centre(first);
  const b = centre(last);
  const radius = 6;
  const arcs = returns.flatMap((entry, index) => {
    const from = marks.find((mark) => mark.getAttribute('data-glyph') === entry.fromId);
    const to = marks.find((mark) => mark.getAttribute('data-glyph') === entry.toId);
    if (!from || !to) return [];
    const f = centre(from);
    const t = centre(to);
    const x = f.x - 18 - index * 8;
    return [
      `M${f.x - 12} ${f.y} H${x + radius} Q${x} ${f.y} ${x} ${f.y - radius} V${t.y + radius} ` +
        `Q${x} ${t.y} ${x + radius} ${t.y} H${t.x - 13}`,
    ];
  });
  return { width: box.width, height: box.height, line: { x1: a.x, y1: a.y, x2: b.x, y2: b.y }, arcs };
}
