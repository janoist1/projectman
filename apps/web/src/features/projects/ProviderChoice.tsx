import { useRef, useState } from 'react';
import { AgentProvider } from '@projectman/shared';
import { useProviders } from '../../api/queries';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';
import { NanogptKeyDialog } from '../settings/NanogptKeyDialog';
import { ProviderTodo, providerStatusText } from '../settings/ProviderStatus';
import statusStyles from '../settings/sections/ProvidersSection.module.css';
import styles from './CreateProjectPage.module.css';

export function ProviderChoice({
  query,
  value,
  onChange,
}: {
  query: ReturnType<typeof useProviders>;
  value: AgentProvider;
  onChange: (provider: AgentProvider) => void;
}) {
  const [keyOpen, setKeyOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const nanoRadio = useRef<HTMLInputElement>(null);
  const entries = query.isError ? [] : (query.data?.providers ?? []);
  const selected = entries.find((entry) => entry.provider === value);
  const anyReady = entries.some((entry) => entry.loggedIn === true);
  const checkedAt = entries
    .map((entry) => entry.checkedAt)
    .sort()
    .at(-1);
  return (
    <section className={styles.section} aria-labelledby="providers-title">
      <div className={styles.sectionHeader}>
        <h2 id="providers-title">{t('projects.create.providersTitle')}</h2>
        <Button
          size="sm"
          variant="secondary"
          icon="refresh"
          loading={query.isFetching && !query.isPending}
          aria-disabled={query.isPending || query.isFetching || undefined}
          onClick={async () => {
            if (query.isPending || query.isFetching) return;
            setAnnouncement('');
            const result = await query.refetch();
            setAnnouncement(
              t('projects.create.rechecked', {
                statuses: AgentProvider.options
                  .map(
                    (provider) =>
                      `${t(`providers.${provider}`)} ${providerStatusText(provider, result.isError ? undefined : result.data?.providers.find((entry) => entry.provider === provider))}`,
                  )
                  .join(', '),
              }),
            );
          }}
        >
          {t('projects.create.recheck')}
        </Button>
      </div>
      <p className={styles.help}>{t('projects.create.providersHelp')}</p>
      <fieldset className={styles.fieldset} aria-busy={query.isPending}>
        <legend>{t('projects.create.providerLegend')}</legend>
        <div className={styles.providerList}>
          {AgentProvider.options.map((provider) => {
            const entry = entries.find((row) => row.provider === provider);
            const statusId = `provider-${provider}-status`;
            const todoId = `provider-${provider}-todo`;
            return (
              <div
                key={provider}
                className={styles.providerRow}
                data-selected={value === provider || undefined}
              >
                <label className={styles.providerName}>
                  <input
                    ref={provider === 'nanogpt' ? nanoRadio : undefined}
                    type="radio"
                    name="starter-provider"
                    value={provider}
                    checked={value === provider}
                    onChange={() => onChange(provider)}
                    aria-describedby={`${statusId}${query.isPending ? '' : ` ${todoId}`}`}
                  />
                  {t(`providers.${provider}`)}
                </label>
                <span className={styles.providerMeta}>{t(`providerSettings.runsOn.${provider}`)}</span>
                <div id={statusId} className={styles.providerState}>
                  {query.isPending ? (
                    <span className={statusStyles.skeleton}>
                      <span className="visually-hidden">{t('providerSettings.checking')}</span>
                    </span>
                  ) : (
                    <span
                      key={providerStatusText(provider, entry)}
                      className={`${statusStyles.state} ${styles.state}`}
                      data-tone={
                        entry?.loggedIn === true ? 'ready' : entry?.loggedIn === false ? 'needs' : 'neutral'
                      }
                    >
                      <span className={statusStyles.dot} aria-hidden="true" />
                      {providerStatusText(provider, entry)}
                    </span>
                  )}
                </div>
                {!query.isPending ? (
                  <div id={todoId} className={styles.todo}>
                    <ProviderTodo
                      provider={provider}
                      entry={entry}
                      canManageKeys={query.data?.canManageKeys === true}
                    />
                    {provider === 'nanogpt' &&
                    entry?.loggedIn === false &&
                    entry.problem === 'no_key' &&
                    query.data?.canManageKeys ? (
                      <Button size="sm" onClick={() => setKeyOpen(true)}>
                        {t('nanogptKey.add')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </fieldset>
      {!query.isPending && checkedAt ? (
        <p className={styles.muted}>
          {t('projects.create.checkedAt', {
            time: new Date(checkedAt).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }),
          })}
        </p>
      ) : null}
      {query.isError ? <p className={styles.queryError}>{t('projects.create.providersError')}</p> : null}
      {!query.isPending && !query.isError && selected?.loggedIn === false ? (
        <div className={styles.warning} role="note">
          <strong>
            {t(anyReady ? 'projects.create.selectedNotReady' : 'projects.create.noneReady', {
              provider: t(`providers.${value}`),
            })}
          </strong>{' '}
          {t(anyReady ? 'projects.create.selectedNotReadyHelp' : 'projects.create.noneReadyHelp', {
            provider: t(`providers.${value}`),
          })}
        </div>
      ) : null}
      <span role="status" className="visually-hidden">
        {announcement}
      </span>
      <NanogptKeyDialog
        open={keyOpen}
        onClose={() => setKeyOpen(false)}
        onSaved={() => {
          void query.refetch();
          setAnnouncement(t('nanogptKey.saved'));
          requestAnimationFrame(() => nanoRadio.current?.focus());
        }}
      />
    </section>
  );
}
