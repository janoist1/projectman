import type { OwnerAccountView } from '@projectman/shared';
import { useRevokeOwnerAccount } from '../../../api/queries';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { useToast } from '../../../components/toastContext';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';

export function RevokeOwnerDialog({ account, onClose }: { account: OwnerAccountView; onClose: () => void }) {
  const revoke = useRevokeOwnerAccount();
  const toast = useToast();
  return (
    <Dialog
      open
      role="alertdialog"
      size="sm"
      title={t('owners.revokeTitle', { name: account.name })}
      onClose={() => {
        if (!revoke.isPending) onClose();
      }}
      error={revoke.isError ? <ErrorBanner>{errorMessage(revoke.error)}</ErrorBanner> : undefined}
      footer={
        <>
          <Button autoFocus size="md" disabled={revoke.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size="md"
            variant="dangerSolid"
            loading={revoke.isPending}
            onClick={() =>
              revoke.mutate(account.userId, {
                onSuccess: () => {
                  toast.show(t('owners.revokedToast', { name: account.name }));
                  onClose();
                },
              })
            }
          >
            {t('owners.revokeConfirm')}
          </Button>
        </>
      }
    >
      <ul>
        <li>{t('owners.revokeProjects', { n: account.projectCount })}</li>
        <li>{t('owners.revokeKeys')}</li>
        <li>{t('owners.revokeNew')}</li>
        <li>{t('owners.revokeData')}</li>
      </ul>
    </Dialog>
  );
}
