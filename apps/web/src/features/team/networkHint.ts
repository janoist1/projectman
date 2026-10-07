import { DEFAULT_AGENT_PROVIDER } from '@projectman/shared';
import type { AgentProvider, Approver } from '@projectman/shared';
import { t } from '../../i18n/t';

/**
 * The help text under the "Outbound network" checkbox (PM-355). A Claude member with the network off gets
 * a plain refusal for another address (the owner's decision: the CLI cannot ask per address); the other
 * CLIs ask, and the "who decides" setting says who answers; with nobody deciding the system refuses.
 */
export function networkHint(input: {
  network: boolean;
  provider?: AgentProvider;
  approver?: Approver;
}): string {
  if (input.network) return t('permissionControls.networkHints.on');
  if ((input.provider ?? DEFAULT_AGENT_PROVIDER) === 'claude')
    return t('permissionControls.networkHints.offRefused');
  return input.approver === 'none'
    ? t('permissionControls.networkHints.offNone')
    : t('permissionControls.networkHints.off');
}
