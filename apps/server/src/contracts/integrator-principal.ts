import type { SuperActor } from '@projectman/shared';

/**
 * The authenticated integrator key behind a request (PM-757). It is made only by the key check of the
 * server (`auth`), from a stored key: no request body, header or JSON can be parsed into one, so an `Actor`
 * that merely says "super" is never authority. `mode` is what the key was issued for; every key issued so far is
 * `legacy` (the owner's actor through the integrator key, `via` alone), and `super` and `read` keys arrive
 * with the token lifecycle (PM-758). `userId` is the token owner, whose current project membership is the
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
