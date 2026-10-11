import { Link } from 'react-router';
import { useBoard } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { t } from '../../i18n/t';
import { capacityRows } from '../../lib/capacity';
import type { Capacity, CapacityRow } from '../../lib/capacity';
import styles from './CapacityList.module.css';

/**
 * What holds the places of the member a card waits for (PM-297), one row per holder: a card goes to the card,
 * a chat, a schedule run and a meeting to their session (a client gets no session, so the row is plain text,
 * as a card the client cannot see is).
 */
export function CapacityList({ capacity, memberName }: { capacity: Capacity; memberName: string }) {
  const { key } = useProject();
  const tasks = useBoard(key).data?.tasks;
  const titles = new Map((tasks ?? []).map((task) => [task.key, task.title]));
  return (
    <ul className={styles.list} aria-label={t('task.whyBox.capacityList', { name: memberName })}>
      {capacityRows(capacity, titles).map((row) => {
        const to = row.taskKey
          ? `/p/${key}/tasks/${row.taskKey}`
          : row.sessionId
            ? `/p/${key}/sessions/${row.sessionId}`
            : null;
        return (
          <li key={row.id}>
            {to ? (
              <Link
                to={to}
                className={styles.row}
                aria-label={t('task.whyBox.capacityLink', {
                  what: row.title ? `${row.what} ${row.title}` : row.what,
                  meta: row.meta,
                })}
              >
                <RowContent row={row} />
              </Link>
            ) : (
              <div className={styles.row}>
                <RowContent row={row} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RowContent({ row }: { row: CapacityRow }) {
  return (
    <>
      <span className={row.taskKey ? styles.key : styles.what}>{row.what}</span>
      {row.title ? <span className={styles.title}>{row.title}</span> : null}
      <span className={styles.meta}>{row.meta}</span>
    </>
  );
}
