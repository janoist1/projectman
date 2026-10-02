import clsx from 'clsx';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './Fold.module.css';

interface FoldProps {
  title: string;
  /** Shown beside the title while the fold is closed: the values inside, so no one has to open it to see them. */
  peek?: ReactNode;
  /** Controlled state: a form opens the fold that holds its first invalid field. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

/** A closed-by-default section on <details>: Enter and Space on the summary open it. */
export function Fold({ title, peek, open, onToggle, children, className }: FoldProps) {
  const [inner, setInner] = useState(false);
  const isOpen = open ?? inner;
  return (
    <details className={clsx(styles.fold, className)} open={isOpen}>
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
        <span className={styles.title}>{title}</span>
        {!isOpen && peek ? <span className={styles.peek}>{peek}</span> : null}
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
