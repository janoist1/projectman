import { useState } from 'react';
import type { ReactNode } from 'react';
import { useHostRequests, useOwnerAccounts, useOwnerInvitations } from '../../../api/queries';
import { Button } from '../../../components/Button';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { t } from '../../../i18n/t';
import { SettingsSection } from '../sections/SettingsSection';
import { HostRequestsCard } from './HostRequestsCard';
import { OwnerAccountsCard } from './OwnerAccountsCard';
import { InviteOwnerDialog } from './InviteOwnerDialog';
import styles from './owners.module.css';

function CardState({
  pending,
  failed,
  retry,
  message,
  children,
}: {
  pending: boolean;
  failed: boolean;
  retry: () => void;
  message: string;
  children: ReactNode;
}) {
  if (pending)
    return (
      <div className={styles.skeleton} aria-busy="true">
        <div />
        <div />
      </div>
    );
  if (failed)
    return (
      <>
        <ErrorBanner>{message}</ErrorBanner>
        <Button size="md" onClick={retry}>
          {t('app.retry')}
        </Button>
      </>
    );
  return children;
}

export function OwnersSection() {
  const [invite, setInvite] = useState(false);
  const accounts = useOwnerAccounts(true);
  const invitations = useOwnerInvitations(true);
  const requests = useHostRequests('all', true);
  const showRequests =
    requests.isPending ||
    requests.isError ||
    accounts.isPending ||
    accounts.isError ||
    accounts.data?.accounts.some((a) => a.revokedAt === null) ||
    Boolean(requests.data?.requests.length);
  return (
    <div className={styles.stack}>
      {showRequests && (
        <SettingsSection
          id="settings-host-requests"
          title={t('hostRequests.title')}
          meta={<p className={styles.meta}>{t('hostRequests.meta')}</p>}
        >
          <CardState
            pending={requests.isPending}
            failed={requests.isError}
            retry={() => void requests.refetch()}
            message={t('hostRequests.loadFailed')}
          >
            <HostRequestsCard requests={requests.data?.requests ?? []} />
          </CardState>
        </SettingsSection>
      )}
      <SettingsSection
        id="settings-owners"
        title={t('owners.title')}
        meta={
          <>
            <p className={`${styles.meta} ${styles.headingMeta}`}>{t('owners.meta')}</p>
            {(Boolean(accounts.data?.accounts.length) ||
              invitations.data?.invitations.some(
                (i) => !i.acceptedAt && !i.revokedAt && Date.parse(i.expiresAt) > Date.now(),
              )) && (
              <Button size="md" icon="plus" onClick={() => setInvite(true)}>
                {t('owners.invite')}
              </Button>
            )}
          </>
        }
      >
        <CardState
          pending={accounts.isPending || invitations.isPending}
          failed={accounts.isError || invitations.isError}
          retry={() => {
            void accounts.refetch();
            void invitations.refetch();
          }}
          message={t('owners.loadFailed')}
        >
          <OwnerAccountsCard
            accounts={accounts.data?.accounts ?? []}
            invitations={invitations.data?.invitations ?? []}
            onInvite={() => setInvite(true)}
          />
        </CardState>
      </SettingsSection>
      {invite && <InviteOwnerDialog onClose={() => setInvite(false)} />}
    </div>
  );
}
