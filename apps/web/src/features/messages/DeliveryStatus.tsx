import clsx from 'clsx';
import type { TeamMessage } from '@projectman/shared';
import { Popover } from '../../components/Popover';
import { formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { deliveryState, receiptsOf } from './receipts';
import styles from './DeliveryStatus.module.css';

/** How a message of mine stands ("Kézbesítve"), and who got it and who read it behind a click. */
export function DeliveryStatus({
  message,
  members,
  myHandle,
}: {
  message: TeamMessage;
  members: MemberIndex;
  myHandle: string | null;
}) {
  const receipts = receiptsOf(message, members);
  const state = deliveryState(receipts);
  return (
    <Popover
      label={t(`messages.status.${state}`)}
      variant="ghost"
      size="sm"
      className={clsx(styles.status, state === 'queued' && styles.statusWait)}
    >
      {() => (
        <ul className={styles.receipts} aria-label={t('messages.status.details')}>
          {receipts.map((receipt) => (
            <li key={receipt.handle}>
              <strong>{nameOf(receipt.handle, members, myHandle)}</strong> ·{' '}
              {receipt.kind === 'ai'
                ? receipt.deliveredAt
                  ? `${t('messages.status.aiTyped')} · ${formatTime(receipt.deliveredAt)}`
                  : t('messages.status.aiQueued')
                : receipt.readAt
                  ? t('messages.status.humanRead')
                  : t('messages.status.humanUnread')}
              {receipt.route?.type === 'general' ? ` · ${t('messages.routeGeneral')}` : null}
              {receipt.route?.type === 'task'
                ? ` · ${t('messages.routeTask', { taskKey: receipt.route.taskKey })}`
                : null}
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}
