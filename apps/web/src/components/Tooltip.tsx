import clsx from 'clsx';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import styles from './Tooltip.module.css';

const HOVER_DELAY_MS = 300;
/** The pointer crosses the gap between the anchor and the tooltip without closing it. */
const LEAVE_DELAY_MS = 150;
const EDGE_MARGIN = 8;
const GAP = 8;

/** Only one tooltip shows at a time: opening one closes the one that was open. */
let closeActive: (() => void) | null = null;

/**
 * A focusable group with a tooltip under it. The tooltip opens after a short hover, at once on
 * keyboard focus, and on a tap; it closes when the pointer leaves (it stays open while the pointer
 * is on it), on blur and on Escape. It is in the DOM while closed, so a screen reader reads it as the
 * group's description on focus.
 */
export function Tooltip({
  label,
  content,
  className,
  children,
}: {
  /** The group's accessible name. */
  label: string;
  content: string;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const clearTimer = () => clearTimeout(timer.current);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
    if (closeActive === close) closeActive = null;
  }, []);
  const show = () => {
    clearTimer();
    if (closeActive && closeActive !== close) closeActive();
    closeActive = close;
    setOpen(true);
  };

  useEffect(() => () => close(), [close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Under the anchor, aligned to its left edge, but at least 8px from the window's right edge.
  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !tipRef.current) return;
    const anchor = anchorRef.current.getBoundingClientRect();
    const width = tipRef.current.offsetWidth;
    const left = Math.max(EDGE_MARGIN, Math.min(anchor.left, window.innerWidth - EDGE_MARGIN - width));
    setPosition({ left, top: anchor.bottom + GAP });
  }, [open, content]);

  return (
    <span
      ref={anchorRef}
      className={clsx(styles.anchor, className)}
      role="group"
      tabIndex={0}
      aria-label={label}
      aria-describedby={id}
      onFocus={show}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
      onClick={show}
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch') return;
        clearTimer();
        if (!open) timer.current = setTimeout(show, HOVER_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'touch') return;
        clearTimer();
        timer.current = setTimeout(close, LEAVE_DELAY_MS);
      }}
    >
      {children}
      <span
        ref={tipRef}
        id={id}
        role="tooltip"
        data-open={open}
        className={clsx(styles.tooltip, open && styles.open)}
        style={position ? { left: position.left, top: position.top } : undefined}
      >
        {content}
      </span>
    </span>
  );
}
