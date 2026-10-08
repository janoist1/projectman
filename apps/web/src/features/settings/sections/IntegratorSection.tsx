import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../../../api/endpoints';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { SelectField } from '../../../components/Field';
import { ErrorState, LoadingState } from '../../../components/States';
import { formatStamp } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import { SettingsSection } from './SettingsSection';

export function IntegratorSection() {
  const { key, me } = useProject();
  const client = useQueryClient();
  const queryKey = ['integrator-key', me.userId];
  const query = useQuery({ queryKey, queryFn: api.integratorKey, enabled: me.hostOwner === true });
  const [dialog, setDialog] = useState<'create' | 'revoke' | null>(null);
  const [days, setDays] = useState<30 | 90 | 365 | null>(90);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: async () => {
      const result = await api.createIntegratorKey(days);
      setSecret(result.secret);
      return result.key;
    },
    onSuccess: (result) => {
      client.setQueryData(queryKey, { key: result });
      setCopied(false);
      setDialog(null);
    },
  });
  const revoke = useMutation({
    mutationFn: api.revokeIntegratorKey,
    onSuccess: (result) => {
      client.setQueryData(queryKey, result);
      setDialog(null);
    },
  });
  if (!me.hostOwner) return null;
  const info = query.data?.key;
  const expires = info?.expiresAt ? Math.ceil((Date.parse(info.expiresAt) - Date.now()) / 86_400_000) : null;
  const pending = create.isPending || revoke.isPending;
  return (
    <SettingsSection id="settings-integrator" title={t('integratorKey.title')}>
      <p>{t('integratorKey.intro')}</p>
      <h3>{t('integratorKey.rights')}</h3>
      <p>{t('integratorKey.rightsBody')}</p>
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
              <p>
                {t(info.state === 'active' ? 'integratorKey.active' : `integratorKey.states.${info.state}`)}
              </p>
              <dl>
                <dt>{t('integratorKey.prefix')}</dt>
                <dd>
                  <code>{info.prefix}…</code>
                </dd>
                <dt>{t('integratorKey.created')}</dt>
                <dd>{formatStamp(info.createdAt)}</dd>
                <dt>{t('integratorKey.used')}</dt>
                <dd>{info.lastUsedAt ? formatStamp(info.lastUsedAt) : '—'}</dd>
                <dt>{t('integratorKey.expires')}</dt>
                <dd>{info.expiresAt ? formatStamp(info.expiresAt) : t('integratorKey.never')}</dd>
              </dl>
              {info.state === 'active' && expires !== null && expires <= 7 ? (
                <p role="status">{t('integratorKey.soon', { n: expires })}</p>
              ) : null}
            </>
          ) : (
            <p>{t('integratorKey.none')}</p>
          )}
          <Button
            onClick={() => {
              create.reset();
              setDialog('create');
            }}
          >
            {t(info ? 'integratorKey.new' : 'integratorKey.create')}
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
        </>
      ) : null}
      <p>
        <Link to={`/p/${key}/sessions?by=integrator`}>{t('integratorKey.activity')}</Link>
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
          <p role="alert">{errorMessage(create.error ?? revoke.error)}</p>
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
        <code style={{ overflowWrap: 'anywhere' }}>{secret}</code>
        <Button
          variant="secondary"
          onClick={() => {
            if (secret)
              void navigator.clipboard
                .writeText(secret)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
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
