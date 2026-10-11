import { useId, useState } from 'react';
import type { ConfigChangeRow } from '@projectman/shared';
import { t } from '../../i18n/t';
import styles from './OperatorChanges.module.css';

/** How many changed rows show before the "+N" button (the designer's plan: at most 3). */
export const CHANGES_SHOWN = 3;

/** What a row is about: the target and the field; a whole target added or removed has no field. */
function rowHead(row: ConfigChangeRow): string {
  const field = row.field === '*' ? '' : row.field;
  return [row.target, field].filter(Boolean).join(' · ') || row.area;
}

/** Before → after of one row: the old value struck out, the new one bold, with a word for screen readers. */
function Values({ row }: { row: ConfigChangeRow }) {
  if (row.field === '*') {
    // The target itself came or went; the value is a short descriptor of it.
    const added = row.before === null;
    return (
      <span className={styles.values}>
        <span className={styles.mark}>
          {added ? t('operator.change.added') : t('operator.change.removed')}
        </span>
        {added ? <ins>{row.after}</ins> : <del>{row.before}</del>}
      </span>
    );
  }
  return (
    <span className={styles.values}>
      <del>{row.before ?? t('operator.change.empty')}</del>
      <span className={styles.arrow} aria-hidden="true">
        →
      </span>
      <span className={styles.sr}>{t('operator.change.instead')}</span>
      <ins>{row.after ?? t('operator.change.empty')}</ins>
    </span>
  );
}

/**
 * The "Mi változik" table of an Operator approval (PM-447): before → after, at most three rows, the rest behind a
 * "+N további változás" button. Used by the Rád vár card and by the inline approval in the Operator's steps.
 */
export function OperatorChanges({ changes }: { changes: readonly ConfigChangeRow[] }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  if (changes.length === 0) return null;
  const rest = changes.length - CHANGES_SHOWN;
  const shown = all || rest <= 0 ? changes : changes.slice(0, CHANGES_SHOWN);
  return (
    <section className={styles.changes} aria-label={t('operator.approval.changes')}>
      <h3 className={styles.title}>{t('operator.approval.changes')}</h3>
      <ul id={listId} className={styles.list}>
        {shown.map((row, index) => (
          <li key={`${row.area}:${row.target}:${row.field}:${index}`} className={styles.row}>
            <span className={styles.head}>{rowHead(row)}</span>
            <Values row={row} />
          </li>
        ))}
      </ul>
      {rest > 0 ? (
        <button
          type="button"
          className={styles.more}
          aria-expanded={all}
          aria-controls={listId}
          onClick={() => setAll((value) => !value)}
        >
          {all ? t('operator.approval.less') : t('operator.approval.more', { count: rest })}
        </button>
      ) : null}
    </section>
  );
}
