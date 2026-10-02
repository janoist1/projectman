import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './Fold.module.css';

/** Background a reader may want, closed until they open it (a question's details, a member's instructions). */
export function Fold({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className={styles.fold}>
      <summary className={styles.summary}>
        <Icon name="chevronRight" size={14} strokeWidth={2.4} className={styles.chevron} />
        {summary}
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
