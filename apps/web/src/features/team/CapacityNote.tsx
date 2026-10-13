import { Fragment } from 'react';
import { Link } from 'react-router';
import type { MemberView, Task } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { t } from '../../i18n/t';
import { capacityHint, capacityRows } from '../../lib/capacity';
import type { Capacity } from '../../lib/capacity';
import styles from './MemberProfilePage.module.css';

/**
 * A card waits for this member's place (PM-297): the profile says the member is full, which cards wait,
 * what holds the places and when the card starts by itself. Shown only while a card the viewer sees waits.
 */
export function CapacityNote({
  member,
  capacity,
  cards,
}: {
  member: Pick<MemberView, 'displayName'>;
  capacity: Capacity;
  cards: readonly Task[];
}) {
  const { key } = useProject();
  const rows = capacityRows(capacity);
  return (
    <div role="status" className={styles.capacityNote}>
      <p>
        <strong>
          {capacity.max > 1
            ? t('profile.fullOf', { used: capacity.holders.length, max: capacity.max })
            : t('profile.full')}
        </strong>{' '}
        {t('profile.fullWaiting')}{' '}
        {cards.map((card, index) => (
          <Fragment key={card.key}>
            {index > 0 ? t('common.listSeparator') : null}
            <Link to={`/p/${key}/tasks/${card.key}`} className={styles.capacityKey}>
              {card.key}
            </Link>
          </Fragment>
        ))}
      </p>
      <p>
        {t('profile.fullHolders')}{' '}
        {rows.map((row, index) => {
          const to = row.taskKey
            ? `/p/${key}/tasks/${row.taskKey}`
            : row.sessionId
              ? `/p/${key}/sessions/${row.sessionId}`
              : null;
          return (
            <Fragment key={row.id}>
              {index > 0 ? t('common.listSeparator') : null}
              {to ? <Link to={to}>{row.name}</Link> : row.name} {t('profile.fullMeta', { meta: row.meta })}
            </Fragment>
          );
        })}
      </p>
      <p>{capacityHint(capacity, member.displayName)}</p>
    </div>
  );
}
