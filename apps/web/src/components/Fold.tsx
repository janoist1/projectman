import clsx from 'clsx';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './Fold.module.css';

interface FoldProps {
  summary: ReactNode;
  /** Shown beside the summary while the fold is closed: the values inside, so no one has to open it to see them. */
  peek?: ReactNode;
  /** Controlled state: a form opens the fold that holds its first invalid field. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** The fold's content is a form's fields: no grey box around it, the fields are spaced like the form's. */
  plain?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Background a reader may want, closed until they open it (a question's details, a member's
 * instructions), or a form's less common fields. Built on <details>: Enter and Space on the summary
 * open it.
 */
export function Fold({ summary, peek, open, onToggle, plain, children, className }: FoldProps) {
  const [inner, setInner] = useState(false);
  const isOpen = open ?? inner;
  return (
    <details className={clsx(styles.fold, plain && styles.plain, className)} open={isOpen}>
      <summary
        className={styles.summary}
        aria-expanded={isOpen}
        onClick={(event) => {
          event.preventDefault();
          setInner(!isOpen);
          onToggle?.(!isOpen);
        }}
      >
        <Icon name="chevronRight" size={14} strokeWidth={2.4} className={styles.chevron} />
        {summary}
        {!isOpen && peek ? <span className={styles.peek}>{peek}</span> : null}
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
