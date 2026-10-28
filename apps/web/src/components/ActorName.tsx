import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { hasSuperOrigin } from '@projectman/shared';
import type { Actor } from '@projectman/shared';
import { actorLabel, actorParts } from '../lib/members';
import type { MemberIndex } from '../lib/members';
import { t } from '../i18n/t';
import { Chip } from './Chip';
import styles from './ActorName.module.css';

export function ActorName({
  actor,
  members,
  myHandle,
  projectKey,
  history = false,
  machineOperation = false,
  showApproval = true,
  after,
}: {
  actor: Actor;
  members: MemberIndex;
  myHandle: string | null;
  projectKey: string;
  history?: boolean;
  machineOperation?: boolean;
  /** Whether the approver shows next to the chip; the detail line always names it. */
  showApproval?: boolean;
  after?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const { name, connected } = actorParts(actor, members, myHandle);
  if (connected) {
    const chip = (
      <Chip tone="operator" icon="plug">
        {connected.chipHolder === null
          ? t('connected.chip')
          : t('connected.chipHolder', { holder: connected.chipHolder })}
      </Chip>
    );
    const approval = t('connected.approvedBy', { name: connected.approver ?? '' });
    return (
      <span className={styles.actor}>
        <span className={styles.name}>{name}</span>{' '}
        {history ? (
          chip
        ) : (
          <button
            type="button"
            className={styles.badge}
            title={t('connected.title')}
            aria-label={t('connected.chipAria', { holder: connected.holder })}
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
          >
            {chip}
          </button>
        )}
        {connected.approverInline && showApproval ? (
          // A no-break space after the dot keeps it with the approver on a narrow line.
          <span className={styles.muted}> ·&nbsp;{approval}</span>
        ) : null}
        {after}
        {history || expanded ? (
          <span id={id} className={styles.detail}>
            {t('connected.detail')} · {t('connected.holder', { name: connected.holder })} ·{' '}
            {t('connected.key')} <code>{connected.prefix}…</code>
            {connected.approver === null ? null : ` · ${approval}`} ·{' '}
            <Link to={`/p/${projectKey}/sessions?by=super&prefix=${encodeURIComponent(connected.prefix)}`}>
              {t('connected.activity')}
            </Link>
          </span>
        ) : null}
      </span>
    );
  }
  if (!hasSuperOrigin(actor))
    return (
      <>
        {actor.via ? t('involvement.integratorFull') : actorLabel(actor, members, myHandle)}
        {after}
      </>
    );
  return (
    <span className={styles.actor}>
      {t('superMode.name')}{' '}
      {history && machineOperation ? (
        <Chip tone="operator">{t('superMode.badge')}</Chip>
      ) : !history && actor.credential.prefix !== 'operator-app' ? (
        <button
          type="button"
          className={styles.badge}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          <Chip tone="operator">{t(machineOperation ? 'superMode.badge' : 'integratorKey.prefix')}</Chip>
        </button>
      ) : null}
      {after}
      {(history || expanded) && actor.credential.prefix !== 'operator-app' ? (
        <span id={id} className={styles.detail}>
          {t('superMode.credentialLead')} <code>{actor.credential.prefix}…</code>{' '}
          <Link
            to={`/p/${projectKey}/sessions?by=super&prefix=${encodeURIComponent(actor.credential.prefix)}`}
          >
            {t('integratorKey.activity')}
          </Link>
        </span>
      ) : null}
    </span>
  );
}
