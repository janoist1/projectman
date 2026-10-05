import { useRef } from 'react';
import type { ReactNode } from 'react';
import { AgentProvider, DEFAULT_AGENT_PROVIDER } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { useProviders } from '../../../api/queries';
import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import { ProviderLoginSteps } from '../../team/ProviderWarning';
import { SettingsSection } from './SettingsSection';
import styles from './ProvidersSection.module.css';

/** Slot-based row so provider-specific status, instructions and actions can evolve independently. */
export function ProviderRow({
  provider,
  count,
  status,
  todo,
  actions,
}: {
  provider: AgentProvider;
  count: number;
  status: ReactNode;
  todo?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className={styles.row}>
      <strong>{t(`providers.${provider}`)}</strong>
      <span className={styles.meta}>
        {t(`providerSettings.runsOn.${provider}`)} ·{' '}
        {t(count ? 'providerSettings.memberCount' : 'providerSettings.noMembers', { count })}
      </span>
      <div className={styles.status}>
        {status}
        {actions}
      </div>
      {todo ? <div className={styles.todo}>{todo}</div> : null}
    </li>
  );
}

export function ProvidersSection({ config }: { config: ProjectConfig }) {
  const query = useProviders();
  const list = useRef<HTMLUListElement>(null);
  const focusAfterRetry = useRef(false);
  return (
    <SettingsSection
      id="settings-providers"
      title={t('providerSettings.boxTitle')}
      meta={<span className={styles.meta}>{t('providerSettings.boxMeta')}</span>}
    >
      {query.isError ? (
        <div>
          <p>{t('providerSettings.loadError')}</p>
          <Button
            onClick={async () => {
              focusAfterRetry.current = true;
              const result = await query.refetch();
              if (result.isSuccess) list.current?.focus();
            }}
          >
            {t('providerSettings.retry')}
          </Button>
        </div>
      ) : (
        <ul
          className={styles.list}
          aria-label={t('providerSettings.boxTitle')}
          aria-busy={query.isPending}
          tabIndex={-1}
          ref={(element) => {
            list.current = element;
            if (element && focusAfterRetry.current) {
              element.focus();
              focusAfterRetry.current = false;
            }
          }}
        >
          {AgentProvider.options.map((provider) => {
            const count = config.team.members.filter(
              (member) => member.kind === 'ai' && (member.provider ?? DEFAULT_AGENT_PROVIDER) === provider,
            ).length;
            const entry = query.data?.providers.find((row) => row.provider === provider);
            const missing = entry?.loggedIn === false;
            const needsLogin = missing && entry.problem === 'not_logged_in';
            const tone = entry?.loggedIn === true ? 'ready' : missing && count ? 'needs' : 'neutral';
            return (
              <ProviderRow
                key={provider}
                provider={provider}
                count={count}
                status={
                  query.isPending ? (
                    <span className={styles.skeleton}>
                      <span className="visually-hidden">{t('providerSettings.checking')}</span>
                    </span>
                  ) : (
                    <span className={styles.state} data-tone={tone}>
                      <span className={styles.dot} aria-hidden="true" />
                      {t(
                        entry?.loggedIn === true
                          ? 'providerSettings.ready'
                          : needsLogin
                            ? 'providerSettings.notLoggedIn'
                            : missing
                              ? 'providerSettings.notReady'
                              : 'providerSettings.unknown',
                      )}
                    </span>
                  )
                }
                todo={
                  needsLogin && provider !== 'nanogpt' ? (
                    <span className={count ? styles.needs : undefined}>
                      <ProviderLoginSteps provider={provider} />
                    </span>
                  ) : undefined
                }
              />
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
}
