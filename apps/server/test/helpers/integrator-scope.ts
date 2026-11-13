import { connectedActorOf, memberOf } from '@projectman/shared';
import type { Actor, ConnectedActor, HumanMemberConfig, ProjectConfig } from '@projectman/shared';
import { forbidden, runIntegratorExecution } from '../../src/kernel';

const CREDENTIAL = { id: 'ikey_test_1', prefix: 'pmi_aaaaaaaa' };

/** The owner's connected Claude acting in person (decision 66), or on a queue item issued by `issuer`. */
export function connectedClaude(holder = 'owner', issuer?: string): ConnectedActor {
  return connectedActorOf(holder, CREDENTIAL, issuer === undefined ? {} : { issuer });
}

/**
 * Runs `run` inside a live authenticated integrator execution of `actor`, the way the bearer endpoint does.
 * The owner access check passes for the first `accessChecks` calls (default: always) and is refused after
 * that, as a withdrawn owner right would be.
 */
export function inIntegratorExecution<T>(
  actor: Actor,
  run: () => T,
  opts: { holder?: string; accessChecks?: number; hostOwner?: boolean } = {},
): T {
  let checks = 0;
  return runIntegratorExecution(
    {
      active: true,
      hostOwner: opts.hostOwner ?? true,
      context: {
        principal: {
          kind: 'integrator',
          userId: 'user-1',
          keyId: CREDENTIAL.id,
          prefix: CREDENTIAL.prefix,
          mode: 'super',
        },
        projectKey: 'AR',
        actor,
        requestId: 'req-release',
      },
      actorFor: () => actor,
      assertAccess: (config: ProjectConfig) => {
        checks += 1;
        if (opts.accessChecks !== undefined && checks > opts.accessChecks)
          throw forbidden('insufficient_access', 'the owner right is gone');
        return memberOf(config, opts.holder ?? 'owner') as HumanMemberConfig;
      },
      assertMutation: () => {},
      authorizeMutation: async () => {},
    },
    run,
  );
}
