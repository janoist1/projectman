import type { AgentProvider, ProviderLoginStatus } from '@projectman/shared';
import { t } from '../../i18n/t';
import styles from './memberForm.module.css';

export function ProviderLoginSteps({ provider }: { provider: AgentProvider }) {
  if (provider === 'nanogpt') return null;
  return (
    <>
      {t(`providerSettings.loginSteps.${provider}`)}{' '}
      <code>{t(`providerSettings.loginCommands.${provider}`)}</code>
    </>
  );
}

/** Shared warning, with an alert only in the member dialog. NanoGPT extends this in PM-330. */
export function ProviderWarning({
  provider,
  status,
  inDialog = false,
}: {
  provider: AgentProvider;
  status?: ProviderLoginStatus;
  inDialog?: boolean;
}) {
  if (status?.loggedIn !== false) return null;
  const needsLogin = !status.problem || status.problem === 'not_logged_in';
  return (
    <p className={styles.warning} role={inDialog ? 'alert' : undefined}>
      {t(needsLogin ? 'providerSettings.loginWarning' : 'providerSettings.notReadyWarning', {
        provider: t(`providers.${provider}`),
      })}
      {needsLogin ? (
        <>
          {' '}
          <ProviderLoginSteps provider={provider} />
        </>
      ) : null}
    </p>
  );
}
