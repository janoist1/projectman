import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { hasSuperOrigin } from '@projectman/shared';
import type { Actor } from '@projectman/shared';
import { actorLabel } from '../lib/members';
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
  after,
}: {
  actor: Actor;
  members: MemberIndex;
  myHandle: string | null;
  projectKey: string;
  history?: boolean;
  machineOperation?: boolean;
  after?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
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
