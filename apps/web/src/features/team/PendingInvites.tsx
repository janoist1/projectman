import { useInvitations, useRevokeInvite } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { humanRoleName } from '../../lib/roles';
import styles from '../invites/Invites.module.css';

export function PendingInvites() {
  const { key, can } = useProject();
  const invites = useInvitations(key, can.manageTeam);
  const revoke = useRevokeInvite(key);
  const toast = useToast();
  if (!can.manageTeam) return null;
  const pending =
    invites.data?.invitations.filter(
      (invite) => !invite.acceptedAt && !invite.revokedAt && Date.parse(invite.expiresAt) > Date.now(),
    ) ?? [];
  return (
    <section className={styles.pending} aria-labelledby="pending-invites">
      <h2 id="pending-invites">{t('invites.pending')}</h2>
      {invites.isPending ? (
        <LoadingState compact />
      ) : invites.isError ? (
        <ErrorState error={invites.error} onRetry={() => void invites.refetch()} />
      ) : pending.length === 0 ? (
        <p>{t('invites.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {pending.map((invite) => (
            <li key={invite.id}>
              <div>
                <strong>{invite.displayName ?? invite.email}</strong>
                <p>
                  {invite.email} · {humanRoleName(invite.access)}
                </p>
                <p>{t('invites.expires', { date: new Date(invite.expiresAt).toLocaleString('hu-HU') })}</p>
              </div>
              <Button
                aria-label={t('invites.revokeFor', { email: invite.email })}
                loading={revoke.isPending && revoke.variables === invite.id}
                disabled={revoke.isPending}
                onClick={() =>
                  revoke.mutate(invite.id, { onSuccess: () => toast.show(t('invites.revoked')) })
                }
              >
                {t('invites.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {revoke.isError ? <ErrorState compact error={revoke.error} /> : null}
    </section>
  );
}
