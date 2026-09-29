import type { AgentProvider } from '@projectman/shared';
import { t } from '../i18n/t';
import { Chip } from './Chip';

export function ProviderBadge({ provider = 'claude' }: { provider?: AgentProvider }) {
  return <Chip tone="outline">{t(`providers.${provider}`)}</Chip>;
}
