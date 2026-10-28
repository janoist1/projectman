import { useState } from 'react';
import type { OwnerAccountView, OwnerInvitationView } from '@projectman/shared';
import { useRevokeOwnerInvitation } from '../../../api/queries';
import { Button } from '../../../components/Button';
import { Fold } from '../../../components/Fold';
import { MoreMenu } from '../../../components/MoreMenu';
import { EmptyState } from '../../../components/States';
import { useToast } from '../../../components/toastContext';
import { formatDate } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import { useNow } from '../../../lib/useNow';
import { RevokeOwnerDialog } from './RevokeOwnerDialog';
import styles from './owners.module.css';

export function OwnerAccountsCard({
  accounts,
  invitations,
  onInvite,
}: {
  accounts: OwnerAccountView[];
  invitations: OwnerInvitationView[];
  onInvite: () => void;
}) {
  const now = useNow(true, 30_000);
  const pending = invitations.filter(
    (i) => i.acceptedAt === null && i.revokedAt === null && Date.parse(i.expiresAt) > now,
  );
  const active = accounts
    .filter((a) => a.revokedAt === null)
    .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));
  const revoked = accounts.filter((a) => a.revokedAt !== null);
  const [target, setTarget] = useState<OwnerAccountView | null>(null);
  const revoke = useRevokeOwnerInvitation();
  const toast = useToast();
  const button = (
    <Button size="md" icon="plus" variant="primary" onClick={onInvite}>
      {t('owners.invite')}
    </Button>
  );
  return (
    <>
      {!accounts.length && !pending.length ? (
        <EmptyState
          className={styles.empty}
          icon="team"
          title={t('owners.emptyTitle')}
          body={t('owners.emptyBody')}
          action={button}
        />
      ) : (
        <>
          <ul className={styles.list} aria-label={t('owners.title')}>
            {active.map((a) => (
              <li key={a.userId} className={styles.row}>
                <span className={styles.avatar} aria-hidden="true">
                  {a.name
                    .split(/\s+/)
                    .map((p) => p[0])
                    .slice(0, 2)
                    .join('')}
                </span>
                <div className={styles.body}>
                  <strong>{a.name}</strong>
                  <p className={styles.meta}>{a.email}</p>
                  <p className={styles.meta}>
                    {t('owners.projects', { n: a.projectCount })} ·{' '}
                    <span className={a.engines.online === 0 ? styles.needs : undefined}>
                      {t(
                        a.engines.total === 0
                          ? 'owners.enginesNone'
                          : a.engines.online === a.engines.total
                            ? 'owners.enginesOnline'
                            : a.engines.online === 0
                              ? 'owners.enginesOffline'
                              : 'owners.enginesPartial',
                        { n: a.engines.total, online: a.engines.online },
                      )}
                    </span>{' '}
                    · {t('owners.since', { date: formatDate(a.grantedAt) })}
                  </p>
                </div>
                <MoreMenu label={t('owners.actions', { name: a.name })}>
                  {(close) => (
                    <Button
                      variant="danger"
                      onClick={() => {
                        close();
                        setTarget(a);
                      }}
                    >
                      {t('owners.revoke')}
                    </Button>
                  )}
                </MoreMenu>
              </li>
            ))}
          </ul>
          {pending.length > 0 && (
            <>
              <h3>{t('owners.pending')}</h3>
              <ul className={styles.list} aria-label={t('owners.pending')}>
                {pending.map((i) => (
                  <li key={i.id} className={styles.row}>
                    <div className={styles.body}>
                      <strong>{i.email}</strong>
                      <p className={styles.meta}>{t('owners.expires', { date: formatDate(i.expiresAt) })}</p>
                    </div>
                    <Button
                      size="md"
                      disabled={revoke.isPending}
                      aria-label={t('owners.revokeInvite', { email: i.email })}
                      onClick={() =>
                        revoke.mutate(i.id, {
                          onSuccess: () => toast.show(t('owners.inviteRevoked')),
                          onError: (e) => toast.show(errorMessage(e), 'error'),
                        })
                      }
                    >
                      {t('owners.revokeConfirm')}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {revoked.length > 0 && (
            <Fold summary={t('owners.revokedFold', { n: revoked.length })}>
              <ul className={styles.list} aria-label={t('owners.revokedFold', { n: revoked.length })}>
                {revoked.map((a) => (
                  <li key={a.userId} className={styles.row}>
                    <div className={styles.body}>
                      <strong>{a.name}</strong>
                      <p className={styles.meta}>{a.email}</p>
                      <p className={styles.meta}>
                        {t('owners.revokedLine', { date: formatDate(a.revokedAt!), n: a.pausedProjectCount })}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Fold>
          )}
        </>
      )}
      {target && <RevokeOwnerDialog account={target} onClose={() => setTarget(null)} />}
    </>
  );
}
