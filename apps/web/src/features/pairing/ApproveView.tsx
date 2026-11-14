import { PAIRING_KEY_DAYS } from '@projectman/shared';
import type { PairingView } from '@projectman/shared';
import { useEffect, useRef } from 'react';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { formatAgo, formatDate, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { formatCountdown, useCountdown } from '../auth/emailLogin';
import { spelledCode } from './pairingCode';
import styles from './Pairing.module.css';

type Pending = Extract<PairingView, { state: 'pending' }>;
export type Decision = 'approve' | 'deny';

/**
 * The main view (states 5–7): the code to compare with the one on the machine, what the machine asks and what an
 * approval creates, then the two decisions. An error shows above the buttons and the focus goes back to the
 * button that failed, so a retry is one key press away.
 */
export function ApproveView({
  view,
  running,
  failure,
  limit,
  onDecide,
  onExpired,
}: {
  view: Pending;
  /** The decision that is being sent; both buttons are blocked meanwhile. */
  running: Decision | null;
  /** A decision that failed, with the error the page got. */
  failure: { decision: Decision } | null;
  /** Too many attempts: the decision that hit the limit and the seconds left; both buttons wait meanwhile. */
  limit: { decision: Decision; seconds: number } | null;
  onDecide: (decision: Decision) => void;
  onExpired: () => void;
}) {
  const left = useCountdown(Date.parse(view.expiresAt));
  const approve = useRef<HTMLButtonElement>(null);
  const deny = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (left === 0) onExpired();
  }, [left, onExpired]);
  useEffect(() => {
    if (failure) (failure.decision === 'approve' ? approve : deny).current?.focus();
  }, [failure]);
  const limited = limit !== null;
  const limitedDecision = limit?.decision;
  useEffect(() => {
    if (limitedDecision) (limitedDecision === 'approve' ? approve : deny).current?.focus();
  }, [limitedDecision]);

  const requested = new Date(view.requestedAt);
  const keyExpires = new Date(Date.now() + PAIRING_KEY_DAYS * 24 * 60 * 60 * 1000);
  const blocked = running !== null || limited;
  return (
    <div className={styles.approve}>
      <div className={styles.codeBlock}>
        <p className={styles.question}>{t('pairing.approve.sameCode')}</p>
        <p className={styles.code}>
          <span aria-hidden="true">{view.code}</span>
          <span className="visually-hidden">{spelledCode(view.code)}</span>
        </p>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>{t('pairing.approve.machine')}</dt>
          <dd>{view.machineName}</dd>
        </div>
        <div>
          <dt>{t('pairing.approve.requested')}</dt>
          <dd>
            {t('pairing.approve.requestedValue', {
              time: formatTime(requested),
              ago: formatAgo(requested),
            })}
          </dd>
        </div>
        <div>
          <dt>{t('pairing.approve.validFor')}</dt>
          <dd>{formatCountdown(left)}</dd>
        </div>
      </dl>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {left > 0 && left <= 60 ? t('pairing.approve.oneMinute') : ''}
      </div>
      <section aria-labelledby="pairing-creates">
        <h2 id="pairing-creates" className={styles.creates}>
          {t('pairing.approve.creates')}
        </h2>
        <ul className={styles.list}>
          <li>
            <strong>{t('pairing.approve.createsEngine', { name: view.machineName })}</strong>
            <span>{t('pairing.approve.createsEngineNote')}</span>
          </li>
          <li>
            <strong>{t('pairing.approve.createsKey')}</strong>
            <span>{t('pairing.approve.createsKeyNote', { date: formatDate(keyExpires) })}</span>
            {view.replacesKeyPrefix ? (
              <span className={styles.replaces}>
                {t('pairing.approve.replaces', { prefix: view.replacesKeyPrefix })}
              </span>
            ) : null}
          </li>
        </ul>
        <p className={styles.note}>{t('pairing.approve.keysNote')}</p>
      </section>
      <div className={styles.warning}>
        <Icon name="alertCircle" size={18} />
        <p>{t('pairing.approve.warning')}</p>
      </div>
      {limit ? (
        // The page announces the wait once; the text changes every second.
        <ErrorBanner silent>
          {t('pairing.approve.tooMany', { time: formatCountdown(limit.seconds) })}
        </ErrorBanner>
      ) : failure ? (
        <ErrorBanner>
          {failure.decision === 'approve'
            ? t('pairing.approve.approveFailed')
            : t('pairing.approve.denyFailed')}
        </ErrorBanner>
      ) : null}
      <div className={styles.actions}>
        <Button
          ref={approve}
          variant="primary"
          size="xl"
          className={styles.action}
          aria-disabled={blocked || undefined}
          loading={running === 'approve'}
          onClick={() => onDecide('approve')}
        >
          {running === 'approve' ? t('pairing.approve.approving') : t('pairing.approve.approve')}
        </Button>
        <Button
          ref={deny}
          variant="secondary"
          size="xl"
          className={styles.action}
          aria-disabled={blocked || undefined}
          loading={running === 'deny'}
          onClick={() => onDecide('deny')}
        >
          {running === 'deny' ? t('pairing.approve.denying') : t('pairing.approve.deny')}
        </Button>
      </div>
      <p className={styles.note}>{t('pairing.approve.footnote')}</p>
    </div>
  );
}
