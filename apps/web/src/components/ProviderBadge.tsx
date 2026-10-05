import type { AgentProvider, ProviderLoginStatus } from '@projectman/shared';
import { t } from '../i18n/t';
import { Chip } from './Chip';
import { Tooltip } from './Tooltip';

export function ProviderBadge({
  provider = 'claude',
  status,
}: {
  provider?: AgentProvider;
  status?: ProviderLoginStatus;
}) {
  if (status?.loggedIn === false) {
    const name = t(`providers.${provider}`);
    const label = t('providerSettings.badgeNotReady', { provider: name });
    return (
      <Tooltip
        label={label}
        content={t(
          provider === 'nanogpt'
            ? status.problem === 'no_key'
              ? 'providerSettings.nanogptBadgeNoKey'
              : 'providerSettings.nanogptBadgeIncomplete'
            : status.problem === 'not_logged_in'
              ? 'providerSettings.badgeLoginHelp'
              : 'providerSettings.badgeNotReadyHelp',
          { provider: name },
        )}
      >
        <Chip tone="needs">{label}</Chip>
      </Tooltip>
    );
  }
  return <Chip tone="outline">{t(`providers.${provider}`)}</Chip>;
}
