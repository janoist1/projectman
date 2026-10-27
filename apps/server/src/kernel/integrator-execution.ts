import { AsyncLocalStorage } from 'node:async_hooks';
import { hasSuperOrigin } from '@projectman/shared';
import type {
  Actor,
  ExternalToolOrigin,
  HumanMemberConfig,
  ProjectConfig,
  SuperActor,
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

/**
 * Whether the scope may lend the owner's own authority to a step (PM-1010). False only for an app session
 * working on a member's request (a queue item): that step runs with the session member's own rights.
 */
export function delegatesOwnerAuthority(): boolean {
  const principal = execution.getStore()?.context.principal;
  return !(principal?.source === 'app' && principal.requestOrigin === 'member');
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

/**
 * Where a bearer-MCP tool call came from, built from the live scope (PM-784): the key owner, the project's
 * Operator as the key's super actor and the call's request id. Only a super credential has one; the check of
 * the key, the owner's membership and the Operator runs here again. No public input carries an origin.
 */
export function externalToolOrigin(config: ProjectConfig): ExternalToolOrigin {
  const scope = execution.getStore();
  if (!scope || !scope.active)
    throw forbidden('insufficient_access', 'a bearer tool call needs authenticated execution');
  const { principal, requestId } = scope.context;
  if (principal.mode === 'read') throw forbidden('integrator_read_only', 'a read credential cannot write');
  if (principal.mode !== 'super')
    throw forbidden('integrator_not_allowed', 'only a super credential does this');
  const actor = scope.actorFor(config);
  if (!hasSuperOrigin(actor))
    throw forbidden('integrator_not_allowed', 'the project has no Operator to act as');
  return { ownerUserId: principal.userId, actor: externalActorOf(actor), requestId };
}

function externalActorOf(actor: SuperActor): ExternalToolOrigin['actor'] {
  return {
    kind: 'ai',
    handle: actor.handle,
    via: 'integrator',
    operatorMode: 'super',
    credential: { id: actor.credential.id, prefix: actor.credential.prefix },
  };
}

/** The key owner of the live scope, once the access for `operation` is checked; null outside a scope. */
export function integratorOwnerId(config: ProjectConfig, operation: 'read' | 'write'): string | null {
  const scope = execution.getStore();
  if (!scope) return null;
  assertIntegratorAccess(config, operation);
  return scope.context.principal.userId;
}

/** A decision remains a human action even when reached without an Actor argument. */
export function assertOwnApproval(by?: { via?: 'integrator' | null; superActor?: Actor }): void {
  const context = execution.getStore();
  if (context?.context.principal.mode === 'read')
    throw forbidden('integrator_read_only', 'a read credential cannot decide');
  if (context || by?.via || hasSuperOrigin(by?.superActor))
    throw forbidden('owner_approval_required', 'a decision requires a person using their own login');
}

/** A decision by a person's own login, or by the Operator on the owner's authority (PM-875). */
export function assertOwnOrSuperApproval(by?: { via?: 'integrator' | null; superActor?: Actor }): void {
  const scope = execution.getStore();
  if (scope?.context.principal.mode === 'read')
    throw forbidden('integrator_read_only', 'a read credential cannot decide');
  if (
    scope?.active &&
    scope.context.principal.mode === 'super' &&
    hasSuperOrigin(scope.context.actor) &&
    (!by || hasSuperOrigin(by.superActor))
  )
    return;
  assertOwnApproval(by);
}
