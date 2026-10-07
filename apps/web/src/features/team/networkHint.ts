import { DEFAULT_AGENT_PROVIDER } from '@projectman/shared';
import type { AgentProvider, Approver } from '@projectman/shared';
import { t } from '../../i18n/t';

/**
 * The help text under the "Outbound network" checkbox (PM-355). With the network off, only a Codex member
 * asks for another address, and the "who decides" setting says who answers. A Claude member (the owner's
 * decision: the CLI cannot ask per address), any other provider, and a Codex member with nobody deciding
 * get a plain refusal.
 */
export function networkHint(input: {
  network: boolean;
  provider?: AgentProvider;
  approver?: Approver;
}): string {
  if (input.network) return t('permissionControls.networkHints.on');
  const asks = (input.provider ?? DEFAULT_AGENT_PROVIDER) === 'codex' && input.approver !== 'none';
  return t(`permissionControls.networkHints.${asks ? 'off' : 'offRefused'}`);
}
