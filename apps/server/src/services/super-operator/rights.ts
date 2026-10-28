import { superAccessVerdict } from '@projectman/shared';
import type { HumanMemberConfig, ProjectConfig } from '@projectman/shared';
import type { IntegratorCredentialAuthority, IntegratorPrincipal } from '../../contracts';
import { forbidden } from '../../kernel';

/**
 * The integrator's rights, read again at the moment they matter (PM-764). An execution scope is bound to one
 * project and ends with its request, so a job that outlives the request asks here directly: the key is still
 * active, its owner still is an owner of each project, and the mode still allows the operation. The hub's
 * administration is the host's alone (`assertHost`, PM-1063). A revoked key therefore starts no further side effect.
 */
export interface SuperRights {
  /** Throws unless `principal` may perform `operation` in every one of `projectKeys` right now. */
  assertNow(
    principal: IntegratorPrincipal,
    projectKeys: readonly string[],
    operation: 'read' | 'write',
  ): Promise<void>;
  /**
   * Throws `host_only` unless the key is still active and its holder is the instance's host owner (PM-1063): the
   * hub's administration and machine are the host's, whatever projects another owner's key holds.
   */
  assertHost(principal: IntegratorPrincipal): void;
}

export function createSuperRights(deps: {
  credentials: IntegratorCredentialAuthority;
  config(projectKey: string): Promise<ProjectConfig>;
}): SuperRights {
  return {
    assertHost(principal) {
      deps.credentials.assertActive(principal);
      if (!deps.credentials.isHostOwner?.(principal.userId))
        throw forbidden('host_only', 'only the host owner’s key may use the administration of the hub');
    },
    async assertNow(principal, projectKeys, operation) {
      deps.credentials.assertActive(principal);
      const user = deps.credentials.user(principal.userId);
      if (!user) throw forbidden('insufficient_access', 'the credential owner does not exist');
      const email = user.email.trim().toLowerCase();
      for (const key of new Set(projectKeys)) {
        const config = await deps.config(key);
        const owner = config.team.members.find(
          (member): member is HumanMemberConfig =>
            member.kind === 'human' && member.email?.trim().toLowerCase() === email,
        );
        const verdict = superAccessVerdict(config, {
          mode: principal.mode,
          operation,
          ownerMembership:
            owner?.access === 'owner' && !!deps.credentials.keyCoversProject?.(principal.userId, key),
        });
        if (!verdict.allowed) throw forbidden(verdict.code, 'the credential cannot perform this operation');
      }
      deps.credentials.assertActive(principal);
    },
  };
}
