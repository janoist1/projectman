import type { AgentProvider, ProviderLoginStatus } from '@projectman/shared';
import { t } from '../../i18n/t';
import { ProviderLoginSteps } from '../team/ProviderWarning';

/** Shared provider state text for settings and project creation. */
export function providerStatusText(provider: AgentProvider, entry?: ProviderLoginStatus): string {
  if (!entry || entry.loggedIn === null) return t('providerSettings.unknown');
  if (entry.loggedIn)
    return t(provider === 'nanogpt' ? 'providerSettings.nanogptSet' : 'providerSettings.ready');
  if (provider === 'nanogpt')
    return t(
      entry.problem === 'no_key'
        ? 'providerSettings.nanogptNoKeyState'
        : 'providerSettings.nanogptIncompleteState',
    );
  return t(
    entry.problem === 'not_logged_in'
      ? 'providerSettings.notLoggedIn'
      : entry.problem === 'cli_missing'
        ? 'projects.create.cliMissing'
        : entry.problem === 'cli_too_old'
          ? 'projects.create.cliTooOld'
          : 'providerSettings.notReady',
  );
}

export function ProviderTodo({
  provider,
  entry,
  canManageKeys,
}: {
  provider: AgentProvider;
  entry?: ProviderLoginStatus;
  canManageKeys: boolean;
}) {
  if (!entry || entry.loggedIn === null) return <>{t('projects.create.providerUnknownHelp')}</>;
  if (entry.loggedIn) return null;
  const versions = {
    cliVersion: entry.cliVersion ?? t('common.dash'),
    minCliVersion: entry.minCliVersion ?? t('common.dash'),
  };
  if (provider === 'nanogpt') {
    if (entry.problem === 'no_key')
      return <>{t(canManageKeys ? 'providerSettings.nanogptFirstUse' : 'providerSettings.nanogptOwner')}</>;
    if (
      entry.problem === 'cli_missing' ||
      entry.problem === 'cli_too_old' ||
      entry.problem === 'chatgpt_login'
    )
      return (
        <>
          {t(`providerSettings.nanogptFixes.${entry.problem}`, versions)}
          {entry.problem === 'chatgpt_login' ? (
            <>
              {' '}
              <code>providers/nanogpt/codex-home/auth.json</code>
            </>
          ) : null}
        </>
      );
    return null;
  }
  if (entry.problem === 'not_logged_in') return <ProviderLoginSteps provider={provider} />;
  if (entry.problem === 'cli_missing')
    return (
      <>
        {t('projects.create.installProvider', { cli: t(`projects.create.cliNames.${provider}`) })}{' '}
        <code>{t(`providerSettings.loginCommands.${provider}`)}</code>
      </>
    );
  if (entry.problem === 'cli_too_old')
    return (
      <>
        {t('projects.create.updateProvider', { ...versions, cli: t(`projects.create.cliNames.${provider}`) })}
      </>
    );
  return null;
}
