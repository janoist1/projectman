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
  after,
}: {
  actor: Actor;
  members: MemberIndex;
  myHandle: string | null;
  projectKey: string;
  history?: boolean;
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
      {history ? (
        <Chip tone="operator">{t('superMode.badge')}</Chip>
      ) : (
        <button
          type="button"
          className={styles.badge}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          <Chip tone="operator">{t('superMode.badge')}</Chip>
        </button>
      )}
      {!history ? <span className={styles.muted}> · {t('superMode.driven')}</span> : null}
      {after}
      {history || expanded ? (
        <span id={id} className={styles.detail}>
          {history ? `${t('superMode.driven')} · ` : `${t('integratorKey.prefix')}: `}
          <code>{actor.credential.prefix}…</code>{' '}
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
