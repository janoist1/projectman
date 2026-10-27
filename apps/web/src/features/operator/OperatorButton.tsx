import clsx from 'clsx';
import { useRef } from 'react';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { t } from '../../i18n/t';
import { useContacts } from '../messages/useContacts';
import { operatorDotOf, operatorStatusWithQueue } from './operatorChannel';
import { useOperator } from './useOperator';
import styles from './OperatorButton.module.css';

/** The longest display name the wide top bar shows before it cuts the name with an ellipsis. */
const NAME_MAX = 18;

/**
 * The header button that opens the project manager's panel (PM-429, PM-447, PM-1042): every person of the project
 * has it.
 * `bar` is the desktop top bar's (the label sheds width in steps, CSS); `phone` is the phone header's
 * avatar-only icon button; `drawer` is the same icon in a card's head, where the open card covers the top bar's
 * button. The owner's open signals show as a number on it; it wins over the dot of a new reply.
 */
export function OperatorButton({ variant }: { variant: 'bar' | 'phone' | 'drawer' }) {
  const { myHandle, operatorOpen, openOperator, closeOperator } = useProject();
  const { state, member, handle, unread, openSignals } = useOperator();
  const button = useRef<HTMLButtonElement>(null);
  const contacts = useContacts();
  if (!myHandle) return null;
  // A member who writes only to the contacts has the project manager's button only when it is a contact (PM-985).
  if (contacts.restricted && (!contacts.ready || handle === null || !contacts.canWriteTo(handle)))
    return null;

  const displayName = state?.member?.displayName ?? t('operator.name');
  const shortName = displayName.length > NAME_MAX ? `${displayName.slice(0, NAME_MAX - 1)}…` : displayName;
  const dot = operatorDotOf(state);
  const queued = state?.queue.open ?? 0;
  const status = operatorStatusWithQueue(state);
  const newReply = unread > 0 && !operatorOpen && openSignals === 0 && queued === 0;
  const extra =
    openSignals > 0
      ? t('operator.button.signals', { count: openSignals })
      : newReply
        ? t('operator.button.newReply')
        : '';
  const label = t('operator.button.aria', { status: extra ? `${status}, ${extra}` : status });

  return (
    <button
      ref={button}
      type="button"
      className={clsx(
        styles.button,
        variant === 'phone' && styles.phone,
        variant === 'drawer' && styles.drawer,
        operatorOpen && styles.open,
      )}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={operatorOpen}
      aria-controls="operator-panel"
      data-operator-button={variant}
      onClick={() => (operatorOpen ? closeOperator() : openOperator(button.current))}
    >
      <span className={styles.avatar}>
        <Avatar member={member} handle={handle ?? 'operator'} size="sm" />
        <span className={clsx(styles.dot, styles[`dot_${dot}`])} aria-hidden="true" />
        {newReply ? <span className={styles.newReply} aria-hidden="true" /> : null}
        {openSignals > 0 ? (
          <span className={styles.signals} aria-hidden="true" data-testid="operator-signals-count">
            {openSignals}
          </span>
        ) : queued > 0 ? (
          <span className={styles.queued} aria-hidden="true" data-testid="operator-queue-count">
            {queued}
          </span>
        ) : null}
      </span>
      {variant === 'bar' ? (
        <>
          <span className={clsx(styles.label, styles.wide)}>{shortName}</span>
          <span className={clsx(styles.label, styles.narrow)}>{t('operator.short')}</span>
        </>
      ) : null}
    </button>
  );
}
