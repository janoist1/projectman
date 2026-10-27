import type {
  Actor,
  ExternalToolOrigin,
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
  /**
   * Where the credential comes from (PM-888): a stored `key` (the default) or the in-app Operator `app`, whose
   * `keyId` is its session's id. An `app` principal is made only by the server's own issuer and is valid only
   * while `OperatorAppSessions.active` says so; no stored key stands behind it.
   */
  readonly source?: 'key' | 'app';
  /** Server-issued session member; present only for app principals (PM-1041). */
  readonly member?: string;
}

/**
 * Whether the in-app Operator's session may still act as the owner on the shared super-operation path
 * (PM-888): the session runs, it is the project's Operator in its own general conversation, and an owner
 * request is open.
 */
export interface OperatorAppSessions {
  active(principal: IntegratorPrincipal): boolean;
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
  /**
   * The live principal of a stored key (PM-784), for work that outlives the call that started it: a queued
   * document write. Null when the key is revoked, expired or no longer the one stored (id, owner, prefix);
   * the mode is the key's own. It records no use of the key.
   */
  reactivate?(stored: { userId: string; keyId: string; prefix: string }): IntegratorPrincipal | null;
}

/**
 * Runs the later steps of a bearer-MCP write under a fresh authenticated scope (PM-784). `action` gets
 * `assertActive`, which re-checks the key, the owner's membership and the Operator and throws when any of
 * them is gone; the runner itself throws the same way before `action` starts.
 */
export interface DocWriteExternalRunner {
  run<T>(
    projectKey: string,
    origin: ExternalToolOrigin,
    action: (assertActive: () => Promise<void>) => Promise<T>,
  ): Promise<T>;
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
