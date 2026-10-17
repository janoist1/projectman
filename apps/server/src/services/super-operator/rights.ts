import { superAccessVerdict } from '@projectman/shared';
import type { HumanMemberConfig, ProjectConfig } from '@projectman/shared';
import type { IntegratorCredentialAuthority, IntegratorPrincipal } from '../../contracts';
import { forbidden } from '../../kernel';

/**
 * The integrator's rights, read again at the moment they matter (PM-764). An execution scope is bound to one
 * project and ends with its request, so a job that outlives the request, or one that touches the hub (every
 * project of the instance), asks here directly: the key is still active, its owner still is an owner of each
 * project, and the mode still allows the operation. A revoked key therefore starts no further side effect.
 */
export interface SuperRights {
  /** Throws unless `principal` may perform `operation` in every one of `projectKeys` right now. */
  assertNow(
    principal: IntegratorPrincipal,
    projectKeys: readonly string[],
    operation: 'read' | 'write',
  ): Promise<void>;
  /** Every project of the instance: what a change of the hub affects. */
  allProjectKeys(): string[];
}

export function createSuperRights(deps: {
  credentials: IntegratorCredentialAuthority;
  config(projectKey: string): Promise<ProjectConfig>;
  projectKeys(): string[];
}): SuperRights {
  return {
    allProjectKeys: () => deps.projectKeys(),
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
          ownerMembership: owner?.access === 'owner',
        });
        if (!verdict.allowed) throw forbidden(verdict.code, 'the credential cannot perform this operation');
      }
      deps.credentials.assertActive(principal);
    },
  };
}
