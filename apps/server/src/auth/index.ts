import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CreateIntegratorKeyRequest, LoginRequest, routes, SetupRequest } from '@projectman/shared';
import type { Me, SetupStatus } from '@projectman/shared';
import { apiError } from '../api/errors';
import { parseBody } from '../api/validation';
import type { Domain } from '../domain';
import { DomainError, forbidden } from '../domain/errors';
import { createAttemptLimiter, MAX_FAILED_ATTEMPTS_ALL_CLIENTS } from './attempt-limiter';
import { AuthService } from './auth-service';
import type { AuthUser } from './auth-service';
import { clientAddress, isLocalRequest, requestProtocol, sameOrigin } from './local-request';

export { createAttemptLimiter, MAX_FAILED_ATTEMPTS_ALL_CLIENTS } from './attempt-limiter';
export type { AttemptLimiter } from './attempt-limiter';
export { AuthService, SESSION_TTL_MS } from './auth-service';
export type { AuthUser } from './auth-service';
export { clientAddress, isLocalRequest } from './local-request';
export { loadOrCreateSecret } from './secret';

declare module 'fastify' {
  interface FastifyRequest {
    /** The logged-in user (set by the auth guard), or null. */
    user: AuthUser | null;
    /** Token of the login session (from the signed cookie), or null. */
    authToken: string | null;
    via: 'integrator' | null;
  }
}

export const SESSION_COOKIE = 'pm_session';

/** /api routes reachable without a login. /hooks and /mcp authenticate with their own tokens. */
const PUBLIC_ROUTES = new Set([
  `GET ${routes.invite(':token')}`,
  `POST ${routes.acceptInvite(':token')}`,
  `GET ${routes.setupStatus()}`,
  `POST ${routes.setup()}`,
  `POST ${routes.login()}`,
  `POST ${routes.logout()}`,
]);

/** Failed logins per client address and window (and all clients together: attempt-limiter). */
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Checks both the raw path and the matched route pattern, so neither encoding tricks nor catch-all routes slip through. */
function needsLogin(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0] ?? '';
  const route = request.routeOptions.url;
  if (path === routes.websocket() || route === routes.websocket()) return true;
  if (!path.startsWith('/api/') && !route?.startsWith('/api/')) return false;
  return !PUBLIC_ROUTES.has(`${request.method} ${route ?? path}`);
}

/** The user and their memberships, as every login answers and GET /api/auth/me returns. */
export async function meOf(domain: Domain, user: AuthUser, auth?: AuthService): Promise<Me> {
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    handles: await domain.handlesFor(user.email),
    projects: await domain.projectsFor(user.email),
    instanceOwner: await domain.instanceOwner(user.email),
    ...(auth ? { hostOwner: auth.isHostOwner(user.id) } : {}),
  };
}

/**
 * Logs the user in on this response: the presented session is revoked (sessions rotate on
 * every login) and a new signed session cookie is set.
 */
export function startSession(
  auth: AuthService,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): void {
  if (request.authToken) auth.revoke(request.authToken);
  reply.setCookie(SESSION_COOKIE, auth.createSession(userId), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    secure: requestProtocol(request) === 'https',
    maxAge: Math.floor(auth.sessionTtlMs / 1000),
  });
}

/**
 * Login with a signed, httpOnly session cookie. The first-run setup creates the owner and
 * is allowed only while no user exists and only from this machine. Everything under /api
 * (except setup, login and the public invitation routes) and /ws requires the cookie.
 */
export function registerAuth(
  app: FastifyInstance,
  deps: { auth: AuthService; domain: Domain; clientIpHeader?: string },
): void {
  const { auth, domain, clientIpHeader } = deps;
  const loginAttempts = createAttemptLimiter({
    max: MAX_FAILED_LOGINS,
    sharedMax: MAX_FAILED_ATTEMPTS_ALL_CLIENTS,
    windowMs: FAILED_LOGIN_WINDOW_MS,
    message: 'too many failed logins; try again later',
  });

  app.decorateRequest('user', null);
  app.decorateRequest('authToken', null);
  app.decorateRequest('via', null);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    // No page of ours may be framed (clickjacking): the CSP directive for current browsers, the
    // old header for the rest. The attachment routes set their own CSP and repeat the directive.
    reply.header('content-security-policy', "frame-ancestors 'none'");
    reply.header('x-frame-options', 'DENY');
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    if (
      request.url.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !sameOrigin(request)
    ) {
      return reply.code(403).send(apiError('invalid_origin', 'same-origin request required'));
    }
    const bearer = request.headers.authorization;
    if (request.url.startsWith('/api/') && bearer && /^Bearer(?:\s|$)/i.test(bearer)) {
      if (!(isLocalRequest(request) || requestProtocol(request) === 'https'))
        return reply
          .code(401)
          .send(apiError('integrator_https_required', 'Integrator key requires HTTPS or a local connection'));
      const secret = bearer.match(/^Bearer (pmi_[A-Za-z0-9_-]+)$/i)?.[1];
      const user = secret ? auth.resolveIntegratorKey(secret) : null;
      if (!user)
        return reply
          .code(401)
          .send(apiError('integrator_key_invalid', 'Integrator key is invalid, revoked or expired'));
      request.user = user;
      request.via = 'integrator';
    }
    const raw = request.via ? null : request.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      const user = unsigned.valid ? auth.resolve(unsigned.value) : null;
      if (user && unsigned.valid) {
        request.user = user;
        request.authToken = unsigned.value;
      }
    }
    if (!request.user && needsLogin(request)) {
      return reply.code(401).send(apiError('unauthorized', 'login required'));
    }
  });

  app.get(routes.setupStatus(), async (): Promise<SetupStatus> => ({ needsSetup: auth.needsSetup() }));

  app.post(routes.setup(), async (request, reply) => {
    if (!isLocalRequest(request)) {
      throw forbidden(
        'setup_requires_localhost',
        'the first setup must be done on the machine running projectman',
      );
    }
    const body = parseBody(SetupRequest, request.body);
    const user = await auth.createFirstUser(body);
    startSession(auth, request, reply, user.id);
    return reply.code(201).send(await meOf(domain, user, auth));
  });

  app.post(routes.login(), async (request, reply) => {
    const body = parseBody(LoginRequest, request.body);
    // Reserved before the expensive hash: concurrent attempts must count too.
    const release = loginAttempts.reserve(clientAddress(request, clientIpHeader));
    const user = await auth.verifyPassword(body.email, body.password);
    if (!user) {
      throw new DomainError('invalid_credentials', 'wrong email or password', { status: 401 });
    }
    release();
    startSession(auth, request, reply, user.id);
    return meOf(domain, user, auth);
  });

  app.post(routes.logout(), async (request, reply) => {
    if (request.authToken) auth.revoke(request.authToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get(routes.me(), async (request) => ({
    ...(await meOf(domain, request.user!)),
    hostOwner: auth.isHostOwner(request.user!.id),
    ...(request.via ? { via: request.via } : {}),
  }));

  const keyOwner = (request: FastifyRequest): string => {
    if (request.via)
      throw forbidden('integrator_not_allowed', 'Only the owner may manage this key using their own login');
    if (!request.user || !auth.isHostOwner(request.user.id))
      throw forbidden('owner_only', 'Only the host owner may manage this key');
    return request.user.id;
  };
  app.get(routes.integratorKey(), async (request) => ({ key: auth.integratorKey(keyOwner(request)) }));
  app.post(routes.integratorKey(), async (request, reply) => {
    const userId = keyOwner(request);
    const body = parseBody(CreateIntegratorKeyRequest, request.body ?? {});
    const created = auth.createIntegratorKey(userId, body.expiresInDays);
    app.log.info({ prefix: created.key.prefix, userId }, 'Integrator key created');
    return reply.code(201).send(created);
  });
  app.delete(routes.integratorKey(), async (request) => {
    const userId = keyOwner(request);
    const key = auth.revokeIntegratorKey(userId);
    if (!key) throw new DomainError('not_found', 'No active integrator key', { status: 404 });
    app.log.info({ prefix: key.prefix, userId }, 'Integrator key revoked');
    return { key };
  });
}
