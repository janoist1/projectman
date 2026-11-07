import type { MessageProcessing } from '@projectman/shared';
import type { ReactNode } from 'react';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { processingView } from './processing';
import type { ProcessingView } from './processing';
import styles from './ProcessingLines.module.css';

/**
 * The status line of a message, one row per recipient (PM-1305): who, the state's name and, where the state
 * has one, why or what next. It shows what the server sent in `processing` and nothing it works out itself.
 */
export function ProcessingLines({
  items,
  members,
  myHandle,
  reply,
  className,
}: {
  items: readonly MessageProcessing[];
  members: MemberIndex;
  myHandle: string | null;
  /** What to show for a reply: a button or link that opens it, or a note that it cannot be opened. */
  reply?: (view: NonNullable<ProcessingView['reply']>, handle: string) => ReactNode;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul className={`${styles.list} ${className ?? ''}`} aria-label={t('processing.list')} aria-live="polite">
      {items.map((item) => {
        const view = processingView(item);
        return (
          <li key={item.handle} className={styles.row} data-state={item.state} data-tone={view.tone}>
            <span className={styles.who}>{nameOf(item.handle, members, myHandle)}</span>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.label}>{view.label}</span>
            {view.detail ? (
              <details className={styles.details}>
                <summary>{t('processing.details')}</summary>
                <span className={styles.detail}>{view.detail}</span>
              </details>
            ) : null}
            {view.reply && reply ? (
              <span className={styles.reply}>{reply(view.reply, item.handle)}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
