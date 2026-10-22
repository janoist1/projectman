import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OPERATOR_GRANT_DURATIONS, OPERATOR_MACHINE_OPERATIONS } from '@projectman/shared';
import type { OperatorGrantDuration } from '@projectman/shared';
import { api } from '../../../api/endpoints';
import { useProject } from '../../../app/contexts';
import { isApiError } from '../../../api/client';
import { useOperatorGrant } from '../../../api/queries';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import { Dialog } from '../../../components/Dialog';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { SelectField } from '../../../components/Field';
import { Fold } from '../../../components/Fold';
import { ErrorState } from '../../../components/States';
import { useToast } from '../../../components/toastContext';
import { formatStamp } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import styles from './IntegratorSection.module.css';

export function OperatorGrantCard() {
  const { me } = useProject();
  const query = useOperatorGrant();
  const client = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<'grant' | 'extend' | 'revoke' | null>(null);
  const [duration, setDuration] = useState<OperatorGrantDuration>('until_revoked');
  const grant = query.data?.grant;
  const active = grant?.active && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now());
  const today =
    active && grant.expiresAt && new Date(grant.expiresAt).toDateString() === new Date().toDateString();
  const time = grant?.expiresAt
    ? new Date(grant.expiresAt).toLocaleTimeString('hu', { hour: '2-digit', minute: '2-digit' })
    : '';
  const expiry = grant?.expiresAt
    ? today
      ? t('operatorGrant.todayChip', { time })
      : t('operatorGrant.until', { time: formatStamp(grant.expiresAt) })
    : t('operatorGrant.untilRevoked');
  const mutation = useMutation({
    mutationFn: () => (dialog === 'revoke' ? api.revokeOperatorGrant() : api.createOperatorGrant(duration)),
    onSuccess: () => finish(false),
    onError: (error) => {
      if (dialog === 'revoke' && isApiError(error) && error.status === 404 && error.code === 'not_found')
        finish(true);
    },
  });
  function finish(alreadyInactive: boolean) {
    toast.show(
      t(
        alreadyInactive
          ? 'operatorGrant.alreadyInactive'
          : dialog === 'revoke'
            ? 'operatorGrant.revokedToast'
            : 'operatorGrant.grantedToast',
      ),
    );
    setDialog(null);
    void client.invalidateQueries({ queryKey: ['operator-grant'] });
    void client.invalidateQueries({ queryKey: ['operator-grant-audit'] });
  }
  const open = (value: 'grant' | 'extend' | 'revoke') => {
    mutation.reset();
    setDuration('until_revoked');
    setDialog(value);
  };
  return (
    <div className={styles.keyRow} id="operator-grant">
      <h3>{t('operatorGrant.heading')}</h3>
      {query.isPending ? (
        <div role="status" aria-label={t('operatorGrant.heading')} className={styles.skeleton}>
          <span />
          <span />
        </div>
      ) : null}
      {query.isError ? (
        <ErrorState
          error={query.error}
          message={t('operatorGrant.error')}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {grant ? (
        <>
          <div className={styles.status}>
            {active ? (
              <Chip
                tone="accent"
                title={t('operatorGrant.chip', {
                  expiry: today ? t('operatorGrant.todayChip', { time }) : expiry,
                })}
              >
                {t('superMode.badge')}
              </Chip>
            ) : (
              <span className={styles.dot} />
            )}
            <strong>{t(active ? 'operatorGrant.active' : 'operatorGrant.inactive')}</strong>
          </div>
          {active ? (
            <dl className={styles.facts}>
              <div>
                <dt>{t('operatorGrant.granted')}</dt>
                <dd>
                  {grant.grantedAt ? formatStamp(grant.grantedAt) : '—'}
                  {grant.grantedBy && grant.grantedBy !== me.name ? ` · ${grant.grantedBy}` : ''}
                </dd>
              </div>
              <div>
                <dt>{t('operatorGrant.expires')}</dt>
                <dd>{expiry}</dd>
              </div>
              <div>
                <dt>{t('operatorGrant.used')}</dt>
                <dd>{grant.lastUsedAt ? formatStamp(grant.lastUsedAt) : t('operatorGrant.unused')}</dd>
              </div>
            </dl>
          ) : (
            <p>{t('operatorGrant.inactiveHint')}</p>
          )}
          {today ? (
            <div className={styles.warning} role="status">
              <span>{t('operatorGrant.today', { time })}</span>
              {grant.canManage ? (
                <Button variant="secondary" onClick={() => open('extend')}>
                  {t('operatorGrant.extend')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {grant.canManage ? (
            <div className={styles.actions}>
              <Button
                variant={active ? 'danger' : 'primary'}
                onClick={() => open(active ? 'revoke' : 'grant')}
              >
                {t(active ? 'operatorGrant.revoke' : 'operatorGrant.grant')}
              </Button>
            </div>
          ) : (
            <p role="status">{t('operatorGrant.ownerOnly')}</p>
          )}
        </>
      ) : null}
      <Fold summary={t('operatorGrant.capabilities')}>
        <p>{t('operatorGrant.capabilitiesBody')}</p>
        <ul>
          {OPERATOR_MACHINE_OPERATIONS.map((id) => (
            <li key={id}>{t(`operatorGrant.operations.${id}`)}</li>
          ))}
        </ul>
        <p>{t('operatorGrant.commandPolicy')}</p>
        <strong>{t('operatorGrant.reservedTitle')}</strong>
        <p>{t('operatorGrant.reserved')}</p>
      </Fold>
      <Dialog
        open={dialog !== null}
        onClose={() => {
          if (!mutation.isPending) setDialog(null);
        }}
        size="sm"
        title={t(
          dialog === 'revoke'
            ? 'operatorGrant.revokeTitle'
            : dialog === 'extend'
              ? 'operatorGrant.extendTitle'
              : 'operatorGrant.grantTitle',
        )}
        footer={
          <>
            <Button variant="secondary" disabled={mutation.isPending} onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={dialog === 'revoke' ? 'dangerSolid' : 'primary'}
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {t(
                dialog === 'revoke'
                  ? 'operatorGrant.revokeSubmit'
                  : dialog === 'extend'
                    ? 'operatorGrant.extendSubmit'
                    : 'operatorGrant.submit',
              )}
            </Button>
          </>
        }
      >
        <div className={styles.grantDialog}>
          <p>{t(dialog === 'revoke' ? 'operatorGrant.revokeBody' : 'operatorGrant.grantBody')}</p>
          {dialog !== 'revoke' ? (
            <>
              <p>{t('operatorGrant.grantReserved')}</p>
              <SelectField
                label={t('operatorGrant.duration')}
                value={duration}
                disabled={mutation.isPending}
                onChange={(event) => setDuration(event.target.value as OperatorGrantDuration)}
              >
                {OPERATOR_GRANT_DURATIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`operatorGrant.durations.${value}`)}
                  </option>
                ))}
              </SelectField>
            </>
          ) : null}
          {mutation.isError ? <ErrorBanner>{errorMessage(mutation.error)}</ErrorBanner> : null}
        </div>
      </Dialog>
    </div>
  );
}
