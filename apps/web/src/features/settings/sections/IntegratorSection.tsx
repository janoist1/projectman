import { useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IntegratorAccessKeyInfo } from '@projectman/shared';
import { Link } from 'react-router';
import { api } from '../../../api/endpoints';
import { useOperatorGrant } from '../../../api/queries';
import { queryKeys } from '../../../api/queryKeys';
import { isApiError } from '../../../api/client';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { useToast } from '../../../components/toastContext';
import { Dialog } from '../../../components/Dialog';
import { Fold } from '../../../components/Fold';
import { SelectField } from '../../../components/Field';
import { ErrorState, LoadingState } from '../../../components/States';
import { formatStamp } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import { SettingsSection } from './SettingsSection';
import styles from './IntegratorSection.module.css';
import { OperatorGrantCard } from './OperatorGrantCard';

export function IntegratorSection() {
  const { key, me } = useProject();
  const client = useQueryClient();
  const toast = useToast();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const ownLogin = me.hostOwner === true && !me.via;
  const queryKey = ['integrator-keys', me.userId];
  const query = useQuery({ queryKey, queryFn: api.integratorKeys, enabled: ownLogin });
  const grant = useOperatorGrant();
  const grantAudit = useQuery({
    queryKey: queryKeys.operatorGrantAudit,
    queryFn: api.operatorGrantAudit,
    enabled: me.hostOwner === true,
    retry: false,
  });
  const [dialog, setDialog] = useState<'create' | 'revoke' | null>(null);
  const [mode, setMode] = useState<'super' | 'read'>('super');
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [target, setTarget] = useState<IntegratorAccessKeyInfo | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);
  const audit = useInfiniteQuery({
    queryKey: ['integrator-key-audit', me.userId],
    enabled: ownLogin,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.integratorKeyAudit(pageParam),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });
  const create = useMutation({
    // Only metadata reaches the mutation cache; the secret stays in component state.
    mutationFn: async () => {
      const result = await api.createIntegratorAccessKey(mode, days);
      setSecret(result.secret);
      return result.key;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey });
      void client.invalidateQueries({ queryKey: ['integrator-key-audit'] });
      setCopied(false);
      setCopyFailed(false);
      setDialog(null);
    },
  });
  const revoke = useMutation({
    mutationFn: () => api.revokeIntegratorAccessKey(target!.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey });
      setDialog(null);
      void client.invalidateQueries({ queryKey: ['integrator-key-audit'] });
      toast.show(t('integratorKey.revoked'));
    },
  });
  if (!me.hostOwner) return null;
  const pending = create.isPending || revoke.isPending;
  const keys = query.data?.keys ?? [];
  const active = keys.filter((info) => info.state === 'active');
  const past = keys.filter((info) => info.state !== 'active');
  const replacing = active.find((info) => info.mode === mode);
  const activity = (prefix = '') =>
    `/p/${key}/sessions?by=super${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}`;
  const openCreate = () => {
    create.reset();
    revoke.reset();
    setMode('super');
    setDays(7);
    setDialog('create');
  };
  const rememberTrigger = () => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const fallbackFocus = () => root.current?.querySelector<HTMLElement>('button, a') ?? null;
  const row = (info: IntegratorAccessKeyInfo) => {
    const remaining = info.expiresAt ? Date.parse(info.expiresAt) - Date.now() : Infinity;
    return (
      <li key={info.id} className={styles.keyRow} data-past={info.state !== 'active'}>
        <div className={styles.status}>
          <Chip tone={info.state === 'active' ? 'ok' : info.state === 'expired' ? 'needs' : 'neutral'}>
            {t(`integratorKey.states.${info.state}`)}
          </Chip>
          <Chip tone="outline">{t(`integratorKey.modes.${info.mode}`)}</Chip>
          <code>{info.prefix}…</code>
        </div>
        {info.state === 'active' ? (
          <dl className={styles.facts}>
            <div>
              <dt>{t('integratorKey.created')}</dt>
              <dd>{formatStamp(info.createdAt)}</dd>
            </div>
            <div>
              <dt>{t('integratorKey.used')}</dt>
              <dd>
                {info.lastUsedAt ? formatStamp(info.lastUsedAt) : '—'}
                {info.lastUsedChannel ? (
                  <span className={styles.muted}>
                    {' '}
                    · {t(`integratorKey.channels.${info.lastUsedChannel}`)}
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>{t('integratorKey.expires')}</dt>
              <dd>{info.expiresAt ? formatStamp(info.expiresAt) : t('integratorKey.never')}</dd>
            </div>
          </dl>
        ) : null}
        {info.state !== 'active' ? (
          <p className={styles.muted}>
            {t(`integratorKey.states.${info.state}`)}:{' '}
            {formatStamp(info.revokedAt ?? info.expiresAt ?? info.createdAt)}
          </p>
        ) : null}
        {info.state === 'active' && info.mode === 'super' && remaining <= 86_400_000 ? (
          <p className={styles.warning} role="status">
            {t(remaining < 86_400_000 ? 'integratorKey.today' : 'integratorKey.soon', { n: 1 })}
          </p>
        ) : null}
        {info.state === 'active' && info.mode === 'legacy' ? (
          <p className={styles.muted}>{t('integratorKey.legacy')}</p>
        ) : null}
        <div className={styles.actions}>
          {ownLogin && info.state === 'active' ? (
            <>
              <Button
                variant="danger"
                onClick={() => {
                  rememberTrigger();
                  revoke.reset();
                  create.reset();
                  setTarget(info);
                  setDialog('revoke');
                }}
              >
                {t('integratorKey.revoke')}
              </Button>
              {info.mode === 'legacy' ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    rememberTrigger();
                    openCreate();
                  }}
                >
                  {t('integratorKey.upgrade')}
                </Button>
              ) : null}
            </>
          ) : null}
          <Link to={activity(info.prefix)}>{t('integratorKey.activity')}</Link>
        </div>
      </li>
    );
  };
  const grantEntries = grantAudit.data?.entries ?? [];
  const log = [
    ...grantEntries
      .filter((entry) => entry.action !== 'replaced')
      .map((entry) => ({
        id: `${entry.grantId}-${entry.action}`,
        at: entry.at,
        text:
          entry.action === 'expired'
            ? t('operatorGrant.auditExpired')
            : entry.action === 'revoked'
              ? t('operatorGrant.auditRevoked', { by: entry.by })
              : t(
                  grantEntries.some((other) => other.action === 'replaced' && other.at === entry.at)
                    ? 'operatorGrant.auditExtended'
                    : 'operatorGrant.auditGranted',
                  {
                    by: entry.by,
                    expiry: entry.expiresAt
                      ? t('operatorGrant.until', { time: formatStamp(entry.expiresAt) })
                      : t('operatorGrant.untilRevoked'),
                  },
                ),
      })),
    ...(audit.data?.pages.flatMap((page) => page.entries) ?? []).map((entry) => ({
      id: `key-${entry.seq}`,
      at: entry.at,
      text: `${entry.prefix}… · ${t(`integratorKey.auditActions.${entry.action}`)}`,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <SettingsSection id="settings-integrator" title={t('operatorGrant.title')}>
      <div ref={root} className={styles.content}>
        <p>{t('operatorGrant.intro')}</p>
        <OperatorGrantCard />
        <div className={styles.keyRow}>
          <h3>{t('operatorGrant.clientTitle')}</h3>
          <p>{t('integratorKey.intro')}</p>
          {grant.data?.active === false && active.some((info) => info.mode === 'super') ? (
            <p className={styles.info}>{t('operatorGrant.clientInactive')}</p>
          ) : null}
          {!ownLogin ? <p role="status">{t('integratorKey.ownerOnly')}</p> : null}
          {ownLogin && query.isPending ? <LoadingState /> : null}
          {query.isError ? (
            <ErrorState
              error={query.error}
              message={t('integratorKey.error')}
              onRetry={() => void query.refetch()}
            />
          ) : null}
          {query.data ? (
            <>
              {!active.length ? (
                <div className={styles.empty}>
                  <strong>{t(keys.length ? 'integratorKey.noValid' : 'integratorKey.none')}</strong>
                  <p>{t('integratorKey.emptyHint')}</p>
                </div>
              ) : null}
              {active.length ? <ul className={styles.keys}>{active.map(row)}</ul> : null}
              <Button
                variant="primary"
                onClick={() => {
                  rememberTrigger();
                  openCreate();
                }}
              >
                {t(keys.length ? 'integratorKey.new' : 'integratorKey.create')}
              </Button>
              {past.length ? (
                <Fold summary={t('integratorKey.past', { n: past.length })}>
                  <ul className={styles.keys}>{past.map(row)}</ul>
                </Fold>
              ) : null}
            </>
          ) : null}
          <Fold summary={t('integratorKey.connection')}>
            <p>{t('integratorKey.connectionBody')}</p>
            <p>
              {t('integratorKey.mcpAddress')}: <code>{window.location.origin}/mcp</code>
            </p>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`${window.location.origin}/mcp`);
                  setAddressCopied(true);
                } catch {
                  toast.show(t('integratorKey.copyFailed'), 'error');
                }
              }}
            >
              {t(addressCopied ? 'integratorKey.copied' : 'integratorKey.copy')}
            </Button>
          </Fold>
        </div>
        <div className={styles.keyRow}>
          <h3>{t('operatorGrant.audit')}</h3>
          {grantAudit.isError && !(isApiError(grantAudit.error) && grantAudit.error.status === 403) ? (
            <ErrorState error={grantAudit.error} onRetry={() => void grantAudit.refetch()} />
          ) : null}
          {!log.length && !audit.isLoading && !grantAudit.isLoading ? (
            <p>{t('operatorGrant.auditEmpty')}</p>
          ) : null}
          {log.length ? (
            <ul className={styles.audit}>
              {log.map((entry) => (
                <li key={entry.id}>
                  <time dateTime={entry.at}>{formatStamp(entry.at)}</time> · {entry.text}
                </li>
              ))}
            </ul>
          ) : null}
          {ownLogin ? (
            <div>
              {audit.isLoading ? <LoadingState /> : null}
              {audit.isError ? <ErrorState error={audit.error} onRetry={() => void audit.refetch()} /> : null}
              {audit.hasNextPage ? (
                <Button
                  variant="secondary"
                  loading={audit.isFetchingNextPage}
                  onClick={() => void audit.fetchNextPage()}
                >
                  {t('superMode.more')}
                </Button>
              ) : null}
            </div>
          ) : null}
          <Fold summary={t('superMode.activity')}>
            <Link to={activity()}>{t('superMode.activity')}</Link>
          </Fold>
        </div>
      </div>
      <Dialog
        open={dialog !== null}
        onClose={() => {
          if (!pending) setDialog(null);
        }}
        size="sm"
        returnFocusRef={trigger}
        returnFocusFallback={fallbackFocus}
        title={
          dialog === 'revoke'
            ? t('integratorKey.revokeTitle', { prefix: target?.prefix ?? '' })
            : t('integratorKey.new')
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
              {t(dialog === 'revoke' ? 'integratorKey.revoke' : 'integratorKey.submit')}
            </Button>
          </>
        }
      >
        {dialog === 'revoke' ? (
          <p>{t(target?.mode === 'read' ? 'integratorKey.revokeReadBody' : 'integratorKey.revokeBody')}</p>
        ) : null}
        {create.isError || revoke.isError ? (
          <ErrorBanner>{errorMessage(create.error ?? revoke.error)}</ErrorBanner>
        ) : null}
        {dialog === 'create' ? (
          <>
            <fieldset className={styles.modes}>
              <legend>{t('integratorKey.purpose')}</legend>
              {(['super', 'read'] as const).map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="integrator-mode"
                    value={value}
                    checked={mode === value}
                    disabled={pending}
                    onChange={() => setMode(value)}
                  />
                  <span>
                    <strong>{t(`integratorKey.modes.${value}`)}</strong>
                    <span className={styles.muted}>{t(`integratorKey.${value}Hint`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <SelectField
              label={t('integratorKey.expiry')}
              value={days}
              disabled={pending}
              onChange={(event) => setDays(Number(event.target.value) as 1 | 7 | 30)}
            >
              {([1, 7, 30] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`integratorKey.days${value}`)}
                </option>
              ))}
            </SelectField>
            {replacing ? (
              <p className={styles.warning} role="status">
                {t(mode === 'read' ? 'integratorKey.replaceReadBody' : 'integratorKey.replaceBody', {
                  prefix: replacing.prefix,
                })}
              </p>
            ) : null}
          </>
        ) : null}
      </Dialog>
      <Dialog
        open={secret !== null}
        closeOnBackdrop={false}
        onClose={() => setSecret(null)}
        title={t(mode === 'read' ? 'integratorKey.readSecretTitle' : 'integratorKey.superSecretTitle')}
        size="sm"
        returnFocusRef={trigger}
        returnFocusFallback={fallbackFocus}
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            {t('integratorKey.done')}
          </Button>
        }
      >
        <p>{t('integratorKey.once')}</p>
        {copyFailed ? <ErrorBanner>{t('integratorKey.copyFailed')}</ErrorBanner> : null}
        <div className={styles.secretRow}>
          <code className={styles.secret}>{secret}</code>
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
        </div>
        {copied ? (
          <p role="status" className={styles.srOnly}>
            {t('integratorKey.copied')}
          </p>
        ) : null}
      </Dialog>
    </SettingsSection>
  );
}
