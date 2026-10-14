import { useId, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { StructureLink } from '@projectman/shared';
import styles from './StructureView.module.css';

/** Decorative measured roads; the panel also exposes every relationship as text. */
export function StructureRoads({
  container,
  links,
  active,
  layout,
}: {
  container: RefObject<HTMLDivElement | null>;
  links: readonly StructureLink[];
  active: boolean;
  layout: string;
}) {
  const marker = useId();
  const [drawing, setDrawing] = useState({ width: 0, height: 0, paths: [] as string[] });
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const origin = element.getBoundingClientRect();
      const boxes = new Map(
        [...element.querySelectorAll<HTMLElement>('[data-module]')].map((el) => [
          el.dataset.module,
          el.getBoundingClientRect(),
        ]),
      );
      const paths = links.flatMap((link) => {
        const from = boxes.get(link.from),
          to = boxes.get(link.to);
        if (!from || !to) return [];
        const x1 = from.left - origin.left + from.width / 2,
          x2 = to.left - origin.left + to.width / 2;
        const sameRow = Math.abs(from.top - to.top) < 20;
        const down = to.top > from.top;
        const y1 = (sameRow || !down ? from.top : from.bottom) - origin.top;
        const y2 = (sameRow || down ? to.top : to.bottom) - origin.top;
        const bend = sameRow ? Math.min(y1, y2) - 22 : (y1 + y2) / 2;
        return [`M ${x1} ${y1} C ${x1} ${bend}, ${x2} ${bend}, ${x2} ${y2}`];
      });
      setDrawing({ width: origin.width, height: origin.height, paths });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    element.querySelectorAll('[data-module]').forEach((el) => observer?.observe(el));
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [container, links, layout]);
  return (
    <svg
      className={styles.roads}
      data-active={active}
      aria-hidden="true"
      focusable="false"
      width={drawing.width}
      height={drawing.height}
    >
      <defs>
        <marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path d="M0 0 L7 3.5 L0 7z" fill={active ? 'var(--c-ink)' : 'var(--c-mark-off)'} />
        </marker>
      </defs>
      {drawing.paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={active ? 'var(--c-ink)' : 'var(--c-mark-off)'}
          strokeWidth={active ? 2.2 : 1.3}
          markerEnd={`url(#${marker})`}
        />
      ))}
    </svg>
  );
}
