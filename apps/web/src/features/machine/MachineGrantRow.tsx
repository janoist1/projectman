import { Link } from 'react-router';
import type { OperatorGrantState } from '@projectman/shared';
import { useOperatorGrant } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { daysBetween, formatDate, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import styles from './Machine.module.css';

/** When the grant ends: "visszavonásig", "ma 20:55-ig" or "okt. 27. 20:55-ig". */
function operatorGrantExpiryText(grant: OperatorGrantState, now: Date = new Date()): string {
  if (!grant.expiresAt) return t('machine.grant.untilRevoked');
  const time = formatTime(grant.expiresAt);
  return daysBetween(grant.expiresAt, now) === 0
    ? t('machine.grant.untilToday', { time })
    : t('machine.grant.untilDate', { date: formatDate(grant.expiresAt, now), time });
}

/**
 * Whether the Operator may run operations on this machine, until when, and where the owner manages it: the machine
 * is where its super grant acts, so the state sits at the bottom of the panel (PM-1042).
 */
export function MachineGrantRow() {
  const { key } = useProject();
  const query = useOperatorGrant();
  const grant = query.data;
  if (query.isError)
    return (
      <footer className={styles.grantRow}>
        <span className={styles.grantText}>{t('machine.grant.unknown')}</span>
      </footer>
    );
  if (!grant) return null;
  return (
    <footer className={styles.grantRow}>
      {grant.active ? (
        <span className={styles.grantChip}>super</span>
      ) : (
        <span className={styles.grantOff} aria-hidden="true" />
      )}
      <span className={styles.grantText}>
        <b>
          {grant.active
            ? t('machine.grant.on', { expiry: operatorGrantExpiryText(grant) })
            : t('machine.grant.off')}
        </b>
        <small>{t(grant.active ? 'machine.grant.onHint' : 'machine.grant.offHint')}</small>
      </span>
      {grant.canManage ? (
        <Link to={`/p/${key}/settings/integrator`} className={styles.grantLink}>
          {t(grant.active ? 'machine.grant.manage' : 'machine.grant.give')}
        </Link>
      ) : null}
    </footer>
  );
}
