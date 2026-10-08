import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../../../api/endpoints';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import { Icon } from '../../../components/Icon';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { useToast } from '../../../components/toastContext';
import { Dialog } from '../../../components/Dialog';
import { SelectField } from '../../../components/Field';
import { ErrorState, LoadingState } from '../../../components/States';
import { formatStamp } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import { SettingsSection } from './SettingsSection';
import styles from './IntegratorSection.module.css';

export function IntegratorSection() {
  const { key, me } = useProject();
  const client = useQueryClient();
  const toast = useToast();
  const queryKey = ['integrator-key', me.userId];
  const query = useQuery({ queryKey, queryFn: api.integratorKey, enabled: me.hostOwner === true });
  const [dialog, setDialog] = useState<'create' | 'revoke' | null>(null);
  const [days, setDays] = useState<30 | 90 | 365 | null>(90);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const create = useMutation({
    mutationFn: async () => {
      const result = await api.createIntegratorKey(days);
      setSecret(result.secret);
      return result.key;
    },
    onSuccess: (result) => {
      client.setQueryData(queryKey, { key: result });
      setCopied(false);
      setCopyFailed(false);
      setDialog(null);
    },
  });
  const revoke = useMutation({
    mutationFn: api.revokeIntegratorKey,
    onSuccess: (result) => {
      client.setQueryData(queryKey, result);
      setDialog(null);
      toast.show(t('integratorKey.revoked'));
    },
  });
  if (!me.hostOwner) return null;
  const info = query.data?.key;
  const expires = info?.expiresAt ? Math.ceil((Date.parse(info.expiresAt) - Date.now()) / 86_400_000) : null;
  const pending = create.isPending || revoke.isPending;
  return (
    <SettingsSection id="settings-integrator" title={t('integratorKey.title')}>
      <p>{t('integratorKey.intro')}</p>
      <div className={styles.rights}>
        <strong>{t('integratorKey.rights')}</strong>
        <p>{t('integratorKey.rightsBody')}</p>
      </div>
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? (
        <ErrorState
          error={query.error}
          message={t('integratorKey.error')}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data ? (
        <>
          {info ? (
            <>
              <p className={styles.status}>
                <Chip tone={info.state === 'active' ? 'ok' : info.state === 'expired' ? 'needs' : 'neutral'}>
                  {t(`integratorKey.states.${info.state}`)}
                </Chip>
                <time dateTime={info.revokedAt ?? info.expiresAt ?? info.createdAt}>
                  {formatStamp(
                    info.state === 'revoked'
                      ? (info.revokedAt ?? info.createdAt)
                      : info.state === 'expired'
                        ? (info.expiresAt ?? info.createdAt)
                        : info.createdAt,
                  )}
                </time>
              </p>
              <dl className={styles.facts}>
                <div>
                  <dt>{t('integratorKey.prefix')}</dt>
                  <dd>
                    <code>{info.prefix}…</code>
                  </dd>
                </div>
                <div>
                  <dt>{t('integratorKey.created')}</dt>
                  <dd>{formatStamp(info.createdAt)}</dd>
                </div>
                <div>
                  <dt>{t('integratorKey.used')}</dt>
                  <dd>{info.lastUsedAt ? formatStamp(info.lastUsedAt) : '—'}</dd>
                </div>
                <div>
                  <dt>{t('integratorKey.expires')}</dt>
                  <dd>{info.expiresAt ? formatStamp(info.expiresAt) : t('integratorKey.never')}</dd>
                </div>
              </dl>
              {info.state === 'active' && expires !== null && expires <= 7 ? (
                <p className={styles.warning} role="status">
                  {t('integratorKey.soon', { n: expires })}
                </p>
              ) : null}
            </>
          ) : (
            <p>{t('integratorKey.none')}</p>
          )}
          <div className={styles.actions}>
            <Button
              onClick={() => {
                create.reset();
                setDialog('create');
              }}
            >
              {t(
                info?.state === 'active'
                  ? 'integratorKey.new'
                  : info
                    ? 'integratorKey.recreate'
                    : 'integratorKey.create',
              )}
            </Button>
            {info?.state === 'active' ? (
              <Button
                variant="danger"
                onClick={() => {
                  revoke.reset();
                  setDialog('revoke');
                }}
              >
                {t('integratorKey.revoke')}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      <p>
        <Link className={styles.activity} to={`/p/${key}/sessions?by=integrator`}>
          <span>{t('integratorKey.activity')}</span>
          <Icon name="arrowRight" size={14} />
        </Link>
      </p>
      <Dialog
        open={dialog !== null}
        onClose={() => {
          if (!pending) setDialog(null);
        }}
        size="sm"
        title={t(
          dialog === 'revoke'
            ? 'integratorKey.revokeTitle'
            : info?.state === 'active'
              ? 'integratorKey.replaceTitle'
              : 'integratorKey.create',
        )}
        description={
          dialog === 'revoke'
            ? t('integratorKey.revokeBody')
            : info?.state === 'active'
              ? t('integratorKey.replaceBody')
              : undefined
        }
        footer={
          <>
            <Button variant="secondary" disabled={pending} onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={dialog === 'revoke' ? 'dangerSolid' : 'primary'}
              loading={pending}
              onClick={() => (dialog === 'revoke' ? revoke.mutate() : create.mutate())}
            >
              {t(dialog === 'revoke' ? 'integratorKey.revoke' : 'integratorKey.create')}
            </Button>
          </>
        }
      >
        {create.isError || revoke.isError ? (
          <ErrorBanner>{errorMessage(create.error ?? revoke.error)}</ErrorBanner>
        ) : null}
        {dialog === 'create' ? (
          <SelectField
            label={t('integratorKey.expiry')}
            value={days ?? 'never'}
            disabled={pending}
            onChange={(event) =>
              setDays(event.target.value === 'never' ? null : (Number(event.target.value) as 30 | 90 | 365))
            }
          >
            <option value="30">{t('integratorKey.days30')}</option>
            <option value="90">{t('integratorKey.days90')}</option>
            <option value="365">{t('integratorKey.year')}</option>
            <option value="never">{t('integratorKey.never')}</option>
          </SelectField>
        ) : null}
      </Dialog>
      <Dialog
        open={secret !== null}
        onClose={() => setSecret(null)}
        title={t('integratorKey.title')}
        size="sm"
        footer={<Button onClick={() => setSecret(null)}>{t('integratorKey.done')}</Button>}
      >
        <p>{t('integratorKey.once')}</p>
        <code className={styles.secret}>{secret}</code>
        {copyFailed ? <ErrorBanner>{t('integratorKey.copyFailed')}</ErrorBanner> : null}
        <Button
          variant="secondary"
          onClick={async () => {
            setCopyFailed(false);
            if (!secret) return;
            try {
              await navigator.clipboard.writeText(secret);
              setCopied(true);
            } catch {
              setCopied(false);
              setCopyFailed(true);
            }
          }}
        >
          {t(copied ? 'integratorKey.copied' : 'integratorKey.copy')}
        </Button>
        <details>
          <summary>{t('integratorKey.how')}</summary>
          <p>{t('integratorKey.instructions')}</p>
        </details>
      </Dialog>
    </SettingsSection>
  );
}
