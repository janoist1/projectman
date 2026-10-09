import clsx from 'clsx';
import { useRef } from 'react';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { t } from '../../i18n/t';
import { pmDotOf, pmStatusText } from './pmChannel';
import { usePm } from './usePm';
import styles from './PmButton.module.css';

/** The longest display name the wide top bar shows before it cuts the name with an ellipsis. */
const NAME_MAX = 18;

/**
 * The header button that opens the project manager's panel (PM-429). `bar` is the desktop top bar's
 * (the label sheds width in steps, CSS); `phone` is the phone header's avatar-only icon button.
 */
export function PmButton({ variant }: { variant: 'bar' | 'phone' }) {
  const { can, pmOpen, openPm, closePm } = useProject();
  const { state, member, handle, unread } = usePm();
  const button = useRef<HTMLButtonElement>(null);
  if (!can.createTasks) return null;

  const displayName = state?.member?.displayName ?? t('pm.name');
  const shortName = displayName.length > NAME_MAX ? `${displayName.slice(0, NAME_MAX - 1)}…` : displayName;
  const dot = pmDotOf(state);
  const status = pmStatusText(state);
  const newReply = unread > 0 && !pmOpen;
  const label = t('pm.button.aria', {
    status: newReply ? `${status}, ${t('pm.button.newReply')}` : status,
  });

  return (
    <button
      ref={button}
      type="button"
      className={clsx(styles.button, variant === 'phone' && styles.phone, pmOpen && styles.open)}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={pmOpen}
      aria-controls="pm-panel"
      data-pm-button
      onClick={() => (pmOpen ? closePm() : openPm(button.current))}
    >
      <span className={styles.avatar}>
        <Avatar member={member} handle={handle ?? 'pm'} size="sm" />
        <span className={clsx(styles.dot, styles[`dot_${dot}`])} aria-hidden="true" />
        {newReply ? <span className={styles.newReply} aria-hidden="true" /> : null}
      </span>
      {variant === 'bar' ? (
        <>
          <span className={clsx(styles.label, styles.wide)}>{shortName}</span>
          <span className={clsx(styles.label, styles.narrow)}>{t('pm.short')}</span>
        </>
      ) : null}
    </button>
  );
}
