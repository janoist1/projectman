import { AsyncLocalStorage } from 'node:async_hooks';
import { hasSuperOrigin } from '@projectman/shared';
import type {
  Actor,
  HumanMemberConfig,
  ProjectConfig,
  SuperMutationCommand,
  SuperMutationInput,
} from '@projectman/shared';
import type { IntegratorExecutionScope } from '../contracts';
import { forbidden } from './errors';

const execution = new AsyncLocalStorage<IntegratorExecutionScope | undefined>();

/** Only the authenticated facade establishes this scope; actor metadata never establishes authority. */
export function runIntegratorExecution<T>(scope: IntegratorExecutionScope, run: () => T): T {
  return execution.run(scope, () => {
    try {
      const result = run();
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function')
        return Promise.resolve(result).finally(() => {
          scope.active = false;
        }) as T;
      scope.active = false;
      return result;
    } catch (error) {
      scope.active = false;
      throw error;
    }
  });
}

export function integratorExecution() {
  return execution.getStore()?.context;
}

/** Existing autonomous system work receives no delegated request authority. */
export function withoutIntegratorExecution<T>(run: () => T): T {
  return execution.run(undefined, run);
}

/** Rechecks current membership and provenance at domain entry, including direct calls (PM-759). */
export function assertIntegratorAccess(
  config: ProjectConfig,
  operation: 'read' | 'write' | 'approval' | 'key_management',
  actor?: Actor,
): HumanMemberConfig | undefined {
  const scope = execution.getStore();
  if (!scope) {
    if (hasSuperOrigin(actor))
      throw forbidden('insufficient_access', 'a super actor needs authenticated execution');
    return undefined;
  }
  if (!scope.active) throw forbidden('insufficient_access', 'the authenticated execution has ended');
  return scope.assertAccess(config, operation, actor);
}

/** Synchronous final check in the domain's unit of work, against the exact current state. */
export function assertSuperMutation(
  previous: ProjectConfig | null,
  command: SuperMutationCommand,
  actor?: Actor,
): void {
  const scope = execution.getStore();
  if (!scope) {
    if (hasSuperOrigin(actor))
      throw forbidden('insufficient_access', 'a super actor needs authenticated execution');
    return;
  }
  if (!scope.active) throw forbidden('insufficient_access', 'the authenticated execution has ended');
  scope.assertMutation({
    previous,
    command,
    actor: actor ?? scope.actorFor(previous),
    projectKey: previous?.project.key ?? null,
  });
}

export async function authorizeSuperMutation(input: SuperMutationInput): Promise<void> {
  const scope = execution.getStore();
  if (!scope) {
    if (hasSuperOrigin(input.actor))
      throw forbidden('insufficient_access', 'a super actor needs authenticated execution');
    return;
  }
  if (!scope.active) throw forbidden('insufficient_access', 'the authenticated execution has ended');
  await scope.authorizeMutation(input);
  if (!scope.active) throw forbidden('insufficient_access', 'the authenticated execution has ended');
  scope.assertMutation(input);
}

/** A decision remains a human action even when reached without an Actor argument. */
export function assertOwnApproval(by?: { via?: 'integrator' | null; superActor?: Actor }): void {
  const context = execution.getStore();
  if (context?.context.principal.mode === 'read')
    throw forbidden('integrator_read_only', 'a read credential cannot decide');
  if (context || by?.via || hasSuperOrigin(by?.superActor))
    throw forbidden('owner_approval_required', 'a decision requires a person using their own login');
}
