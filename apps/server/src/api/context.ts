import type { FastifyRequest } from 'fastify';
import type { Actor, HumanAccess, IntegratorRefusal } from '@projectman/shared';
import type { AuthUser } from '../auth';
import type { ApiDomain } from './ports';
import type { ProjectAccess } from '../core/members';
import {
  DomainError,
  attributedActor,
  forbidden,
  notFound,
  ownerLoginRequired,
  integratorExecution,
} from '../kernel';
import { hasAccess } from '@projectman/shared';
import type { Author } from '../core/projects';

/**
 * The user of a request. A key of the super or read mode (PM-757) is refused here: a route may only serve it
 * through `requireAccess`, which binds it to a project and its Operator. Every route that has not been
 * opened to it that way fails closed instead of acting as the key's owner without the super attribution.
 */
export function currentUser(request: FastifyRequest): AuthUser {
  if (request.principal) throw forbidden('insufficient_access', 'this credential cannot use this endpoint');
  return authenticatedUser(request);
}

/** The user of any authenticated request, whatever its key mode: only for code that has bound the key (`requireAccess`). */
export function authenticatedUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw new DomainError('unauthorized', 'login required', { status: 401 });
  return request.user;
}

/**
 * The user's membership in the project, with at least `minimum` access. Clients see only
 * what is shared with them, so `internal` rejects them; viewers only read, so `messaging`
 * (talking to the team, which clients may do) rejects them.
 */
export async function requireAccess(
  domain: ApiDomain,
  request: FastifyRequest,
  projectKey: string,
  opts: { minimum?: HumanAccess; messaging?: boolean } = {},
): Promise<ProjectAccess> {
  const user = authenticatedUser(request);
  if (!domain.projects.has(projectKey)) throw notFound('project', projectKey);
  const access = await domain.accessFor(projectKey, user.email);
  if (!access) throw forbidden('not_a_member', 'you are not a member of this project');
  if (opts.messaging && access.access === 'viewer') {
    throw forbidden('insufficient_access', 'Developer or client access required');
  }
  if (opts.minimum && !hasAccess(access.access, opts.minimum)) {
    throw forbidden('insufficient_access', `requires ${opts.minimum} access`);
  }
  const principal = request.principal;
  if (!principal) return { ...access, ...(request.via ? { via: request.via } : {}) };
  // A key of the super or read mode (PM-757; the token lifecycle that issues them is PM-758): a read key
  // never writes, and a super key is bound to the project's Operator or refused.
  if (principal.mode === 'read') {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      throw forbidden('integrator_read_only', 'a read-only credential cannot change anything');
  }
  return domain.superOperator.access(
    { principal, email: user.email, requestId: request.id },
    access,
    request.method === 'GET' || request.method === 'HEAD' ? 'read' : 'write',
  );
}

/**
 * What only the owner's own login may do (PM-418): refuses a request made with the integrator key,
 * which acts as the Operator rather than a person. The configuration commit has its own check
 * (`ownerReservedEffect`); this one is for the actions outside it.
 */
export function requireOwnLogin(
  by: { via?: 'integrator' | null; superActor?: unknown },
  category: IntegratorRefusal,
): void {
  if (by.via && !(by.superActor && integratorExecution()?.principal.mode === 'super'))
    throw ownerLoginRequired(category);
}

/**
 * The user who manages the instance as a whole (the owner of every project, as for the instance's
 * pause): the machine display and its command lines are for them alone.
 */
export async function requireInstanceOwner(domain: ApiDomain, request: FastifyRequest): Promise<AuthUser> {
  const user = await instanceUser(
    domain,
    request,
    request.method === 'GET' || request.method === 'HEAD' ? 'read' : 'write',
  );
  if (!(await domain.instanceOwner(user.email)))
    throw forbidden('insufficient_access', 'only an owner of every project may see the machine');
  return user;
}

/** Instance operations bind the integrator credential in every project. */
export async function instanceUser(
  domain: ApiDomain,
  request: FastifyRequest,
  operation: 'read' | 'write',
): Promise<AuthUser> {
  if (!request.principal) return currentUser(request);
  const user = authenticatedUser(request);
  if (request.principal.mode === 'read' && operation === 'write')
    throw forbidden('integrator_read_only', 'a read-only credential cannot change anything');
  for (const project of domain.projects.summaries()) {
    const access = await domain.accessFor(project.key, user.email);
    if (!access) throw forbidden('insufficient_access', 'the credential owner must own every project');
    await domain.superOperator.access(
      { principal: request.principal, email: user.email, requestId: request.id },
      access,
      operation,
    );
  }
  return user;
}

export function actorOf(access: ProjectAccess): Actor {
  return attributedActor(access);
}

/** The handle a request's message is sent from: the Operator in the super mode (PM-757), so it agrees with the actor. */
export function senderOf(access: ProjectAccess): string {
  return access.superActor?.handle ?? access.handle;
}

/**
 * The commit author of a request. A request made with an integrator key (PM-757) needs the access bound by
 * `requireAccess`, which carries the super actor; one without it is refused rather than recorded as the owner.
 */
export function authorOf(request: FastifyRequest, access?: ProjectAccess): Author {
  const user = authenticatedUser(request);
  if (request.principal && !access?.superActor)
    throw forbidden('insufficient_access', 'this credential cannot make this change');
  return {
    name: user.name,
    email: user.email,
    ...(request.via ? { via: request.via } : {}),
    ...(access?.superActor
      ? { superActor: access.superActor, authorizedBy: access.handle, superRequestId: request.id }
      : {}),
  };
}
