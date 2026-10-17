import type {
  Actor,
  HumanMemberConfig,
  ProjectConfig,
  SuperActor,
  SuperMutationInput,
} from '@projectman/shared';

/**
 * The authenticated integrator key behind a request (PM-757). It is made only by the key check of the
 * server (`auth`), from a stored key: no request body, header or JSON can be parsed into one, so an `Actor`
 * that merely says "super" is never authority. `mode` is what the stored key was issued for: old keys remain
 * `legacy` (the owner's actor through the integrator key, `via` alone); explicit `super` and `read` keys
 * have their own execution policy (PM-758). `userId` is the token owner, whose current project membership is the
 * access basis; it is checked again when the principal is bound to a project.
 */
export interface IntegratorPrincipal {
  readonly kind: 'integrator';
  readonly userId: string;
  readonly keyId: string;
  readonly prefix: string;
  readonly mode: 'legacy' | 'super' | 'read';
}

/**
 * Who a super-mode operation acts as, once a principal is bound to a project: the project's Operator with
 * the credential's id and prefix, and the request the operation belongs to. The core takes this from the
 * authenticated execution context; it never builds one from a request.
 */
export interface SuperExecutionContext {
  readonly projectKey: string;
  readonly actor: SuperActor;
  readonly requestId: string;
  readonly handoffId?: string | null;
}

/** Server-owned credential scope. No field is accepted from an operation's JSON arguments. */
export interface IntegratorExecutionContext {
  readonly principal: IntegratorPrincipal;
  readonly email: string;
  readonly requestId: string;
  readonly projectKey?: string | null;
}

export interface AuthenticatedIntegratorExecutionContext {
  readonly principal: IntegratorPrincipal;
  readonly projectKey: string | null;
  readonly actor: Actor;
  readonly requestId: string;
  readonly handoffId?: string | null;
}

export interface IntegratorCredentialAuthority {
  assertActive(principal: IntegratorPrincipal): void;
  user(id: string): { email: string } | null;
}

export interface SuperMutationAuthorizer {
  assertAllowed(input: SuperMutationInput): Promise<void>;
}
export type { SuperMutationCommand, OwnerReservedEffect } from '@projectman/shared';

/** Internal live capability; the authenticated DTO alone never grants authority. */
export interface IntegratorExecutionScope {
  readonly context: AuthenticatedIntegratorExecutionContext;
  active: boolean;
  actorFor(config: ProjectConfig | null): Actor;
  assertAccess(
    config: ProjectConfig,
    operation: 'read' | 'write' | 'approval' | 'key_management',
    actor?: Actor,
  ): HumanMemberConfig | undefined;
  assertMutation(input: SuperMutationInput): void;
  authorizeMutation(input: SuperMutationInput): Promise<void>;
}
