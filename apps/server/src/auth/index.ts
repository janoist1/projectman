import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LoginRequest, routes, SetupRequest } from '@projectman/shared';
import type { Me, SetupStatus } from '@projectman/shared';
import { registerInvitationRoutes } from '../api/invitations';
import { apiError } from '../api/errors';
import { parseBody } from '../api/validation';
import type { Domain } from '../domain';
import { DomainError, forbidden } from '../domain/errors';
import { AuthService } from './auth-service';
import type { AuthUser } from './auth-service';
import { isLocalRequest } from './local-request';

export { AuthService, SESSION_TTL_MS } from './auth-service';
export type { AuthUser } from './auth-service';
export { isLocalRequest } from './local-request';
export { loadOrCreateSecret } from './secret';

declare module 'fastify' {
  interface FastifyRequest {
    /** The logged-in user (set by the auth guard), or null. */
    user: AuthUser | null;
    /** Token of the login session (from the signed cookie), or null. */
    authToken: string | null;
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

/**
 * Login with a signed, httpOnly session cookie. The first-run setup creates the owner and
 * is allowed only while no user exists and only from this machine. Everything under /api
 * (except setup and login) and /ws requires the cookie.
 */
export function registerAuth(app: FastifyInstance, deps: { auth: AuthService; domain: Domain }): void {
  const { auth, domain } = deps;
  const failedLogins = new Map<string, { count: number; resetAt: number }>();

  app.decorateRequest('user', null);
  app.decorateRequest('authToken', null);

  app.addHook('onRequest', async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE];
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

  const me = async (user: AuthUser): Promise<Me> => ({
    userId: user.id,
    name: user.name,
    email: user.email,
    handles: await domain.handlesFor(user.email),
    projects: await domain.projectsFor(user.email),
  });

  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      signed: true,
      maxAge: Math.floor(auth.sessionTtlMs / 1000),
    });

  registerInvitationRoutes(app, { auth, domain, me, setSessionCookie });

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
    setSessionCookie(reply, auth.createSession(user.id));
    return reply.code(201).send(await me(user));
  });

  app.post(routes.login(), async (request, reply) => {
    const body = parseBody(LoginRequest, request.body);
    const now = Date.now();
    const failures = failedLogins.get(request.ip);
    if (failures && failures.resetAt > now && failures.count >= MAX_FAILED_LOGINS) {
      throw new DomainError('too_many_attempts', 'too many failed logins; try again later', { status: 429 });
    }
    const user = await auth.verifyPassword(body.email, body.password);
    if (!user) {
      const entry =
        failures && failures.resetAt > now ? failures : { count: 0, resetAt: now + FAILED_LOGIN_WINDOW_MS };
      entry.count += 1;
      failedLogins.set(request.ip, entry);
      throw new DomainError('invalid_credentials', 'wrong email or password', { status: 401 });
    }
    failedLogins.delete(request.ip);
    setSessionCookie(reply, auth.createSession(user.id));
    return me(user);
  });

  app.post(routes.logout(), async (request, reply) => {
    if (request.authToken) auth.revoke(request.authToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get(routes.me(), async (request) => me(request.user!));
}
