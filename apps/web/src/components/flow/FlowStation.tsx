import clsx from 'clsx';
import type { ReactNode } from 'react';
import styles from './Flow.module.css';

/**
 * One row of a flow: a mark in the left column (the line runs through it), the content, and what
 * belongs on the right. A button when it has `onClick`: the whole row is the target.
 */
export function FlowStation({
  glyph,
  children,
  aside,
  selected = false,
  flash = false,
  onClick,
  showId,
  className,
}: {
  glyph: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  selected?: boolean;
  /** The row just changed: it flashes once (no animation when the user prefers reduced motion). */
  flash?: boolean;
  /** Gets the row's own element, so a panel it opens can give the focus back to it. */
  onClick?: (element: HTMLElement) => void;
  /** Names the target for whoever puts the focus back after a panel closes. */
  showId?: string;
  className?: string;
}) {
  const content = (
    <>
      <span className={styles.glyphCell}>{glyph}</span>
      <span className={styles.main}>{children}</span>
      {aside ? <span className={styles.aside}>{aside}</span> : null}
    </>
  );
  const classes = clsx(styles.row, styles.station, flash && styles.flash, className);
  return onClick ? (
    <button
      type="button"
      className={classes}
      aria-pressed={selected}
      data-show={showId}
      onClick={(event) => onClick(event.currentTarget)}
    >
      {content}
    </button>
  ) : (
    <div className={classes}>{content}</div>
  );
}

/** A row of a flow that is not a station (a gate, a note): the mark column and the content. */
export function FlowRow({
  mark,
  children,
  className,
}: {
  mark?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx(styles.row, className)}>
      <span className={styles.glyphCell}>{mark}</span>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
