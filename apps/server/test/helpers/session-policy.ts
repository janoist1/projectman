import { buildSessionPolicy as build } from '../../src/domain/session-policy';

type PolicyInput = Parameters<typeof build>[0];

/**
 * `buildSessionPolicy` for tests that do not look at the member's outbound network (PM-355): the
 * network is on, the default, unless the test says otherwise.
 */
export function buildSessionPolicy(
  input: Omit<PolicyInput, 'outboundNetwork'> & { outboundNetwork?: boolean },
) {
  return build({ outboundNetwork: true, ...input });
}
