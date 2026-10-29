import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CreateIntegratorAccessKeyRequest,
  IntegratorKeyAuditQuery,
  LoginRequest,
  routes,
  SetupRequest,
} from '@projectman/shared';
import type { IntegratorChannel, Me, SetupStatus } from '@projectman/shared';
import type { IntegratorPrincipal } from '../contracts';
import { apiError, parseBody } from '../http';
import { DomainError, forbidden } from '../kernel';
import { createAttemptLimiter, MAX_FAILED_ATTEMPTS_ALL_CLIENTS } from '../kernel';
import { AuthService } from './auth-service';
import type { AuthUser } from './auth-service';
import { clientAddress, isLocalRequest, requestProtocol, sameOrigin } from '../kernel';
import type { SetupCode } from './setup-code';
import type { EmailLoginService } from '../services/email-login';
import { registerEmailLoginRoutes } from './email-login-routes';

export { createAttemptLimiter, MAX_FAILED_ATTEMPTS_ALL_CLIENTS } from '../kernel';
export { AuthService, SESSION_TTL_MS } from './auth-service';
export type { AuthUser } from './auth-service';
export { OwnerAccountService } from './owner-accounts';
export { clientAddress, isLocalRequest, requestProtocol } from '../kernel';
export { createSetupCode, MAX_SETUP_CODE_FAILURES } from './setup-code';
export { deriveEmailLoginKey, deriveEmailReplyKey, loadOrCreateSecret } from './secret';
export {
  assertPublicBoardReady,
  parsePublicBoardEnv,
  PUBLIC_BOARD_REQUIRES_CLOUD,
  PUBLIC_BOARD_REQUIRES_EMAIL_LOGIN,
  PUBLIC_BOARD_REQUIRES_SETUP,
  PublicBoardNotReadyError,
} from './public-board';

export interface AuthDomain {
  handlesFor(email: string): Promise<Record<string, string>>;
  projectsFor(email: string): Promise<Me['projects']>;
  instanceOwner(email: string): Promise<boolean>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The logged-in user (set by the auth guard), or null. */
    user: AuthUser | null;
    /** Token of the login session (from the signed cookie), or null. */
    authToken: string | null;
    via: 'integrator' | null;
    /** The authenticated integrator key (PM-757), set only by the key check below; null for a login. */
    principal: IntegratorPrincipal | null;
  }
}

export const SESSION_COOKIE = 'pm_session';

/** The CLI header is self-reported telemetry, never authority or evidence of a human caller. */
export function integratorChannel(request: Pick<FastifyRequest, 'url' | 'headers'>): IntegratorChannel {
  const path = request.url.split('?')[0] ?? '';
  if (path === '/mcp') return 'mcp';
  return path.startsWith('/api/') && request.headers['x-projectman-client'] === 'cli' ? 'cli' : 'rest';
}

/** /api routes reachable without a login. /hooks and /mcp authenticate with their own tokens. */
const PUBLIC_ROUTES = new Set([
  `GET ${routes.invite(':token')}`,
  `POST ${routes.acceptInvite(':token')}`,
  `GET ${routes.ownerInvite(':token')}`,
  `POST ${routes.acceptOwnerInvite(':token')}`,
  `GET ${routes.setupStatus()}`,
  `POST ${routes.setup()}`,
  `POST ${routes.login()}`,
  `POST ${routes.emailLoginRequest()}`,
  `POST ${routes.emailLoginVerify()}`,
  `POST ${routes.logout()}`,
]);

/** Failed logins per client address and window (and all clients together: attempt-limiter). */
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * The prefixes whose routes the edge sets apart by the raw path: the API (origin check), the engine's doors and the
 * internal doors of the agents (`/hooks/`, the member MCP `/mcp/<token>`), which the tunnel answers 404 by the raw
 * path; the bare `/mcp` of the integrator (PM-760) is no prefix of them.
 */
const LITERAL_PREFIXES = ['/api/', '/engine/', '/hooks/', '/mcp/'];

/** True when the matched route sits under one of the literal prefixes but the request did not spell it that way. */
function spelledDifferently(request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  if (!route) return false;
  return LITERAL_PREFIXES.some((prefix) => route.startsWith(prefix) && !request.url.startsWith(prefix));
}

/** Checks both the raw path and the matched route pattern, so neither encoding tricks nor catch-all routes slip through. */
function needsLogin(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0] ?? '';
  const route = request.routeOptions.url;
  if (path === routes.websocket() || route === routes.websocket()) return true;
  if (!path.startsWith('/api/') && !route?.startsWith('/api/')) return false;
  return !PUBLIC_ROUTES.has(`${request.method} ${route ?? path}`);
}

/** The user and their memberships, as every login answers and GET /api/auth/me returns. */
export async function meOf(domain: AuthDomain, user: AuthUser, auth?: AuthService): Promise<Me> {
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    handles: await domain.handlesFor(user.email),
    projects: await domain.projectsFor(user.email),
    instanceOwner: await domain.instanceOwner(user.email),
    ...(auth ? { hostOwner: auth.isHostOwner(user.id), ownerAccount: auth.isOwnerAccount(user.id) } : {}),
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
  deps: {
    auth: AuthService;
    domain: AuthDomain;
    clientIpHeader?: string;
    /** `cloud` mode: a non-local first setup is possible, with the setup code (PM-317). */
    cloud?: boolean;
    /** The board runs publicly (PM-672): the setup status says so, so a check can read the running server. */
    publicBoard?: boolean;
    setupCode?: SetupCode;
    /** The e-mail login of invited clients (PM-670); null or absent: it is unavailable. */
    emailLogin?: EmailLoginService | null;
  },
): void {
  const {
    auth,
    domain,
    clientIpHeader,
    cloud = false,
    publicBoard = false,
    setupCode,
    emailLogin = null,
  } = deps;
  const loginAttempts = createAttemptLimiter({
    max: MAX_FAILED_LOGINS,
    sharedMax: MAX_FAILED_ATTEMPTS_ALL_CLIENTS,
    windowMs: FAILED_LOGIN_WINDOW_MS,
    message: 'too many failed logins; try again later',
  });

  app.decorateRequest('user', null);
  app.decorateRequest('authToken', null);
  app.decorateRequest('via', null);
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    // No page of ours may be framed (clickjacking): the CSP directive for current browsers, the
    // old header for the rest. The attachment routes set their own CSP and repeat the directive.
    reply.header('content-security-policy', "frame-ancestors 'none'");
    reply.header('x-frame-options', 'DENY');
    // The router decodes a path (`/%65ngine/link` is `/engine/link`), but the tunnel rules, the origin check
    // below and the guards on the host match the raw one: a route under these prefixes answers only a request
    // that spells the prefix out (PM-672).
    if (spelledDifferently(request)) return reply.code(404).send(apiError('not_found', 'route not found'));
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    if (
      request.url.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !sameOrigin(request)
    ) {
      return reply.code(403).send(apiError('invalid_origin', 'same-origin request required'));
    }
    const bearer = request.headers.authorization;
    const path = request.routeOptions.url ?? request.url.split('?')[0]!;
    if ((request.url.startsWith('/api/') || path === '/mcp') && bearer && /^Bearer(?:\s|$)/i.test(bearer)) {
      if (!(isLocalRequest(request) || requestProtocol(request) === 'https'))
        return reply
          .code(401)
          .send(apiError('integrator_https_required', 'Integrator key requires HTTPS or a local connection'));
      const secret = bearer.match(/^Bearer (pmi_[A-Za-z0-9_-]+)$/i)?.[1];
      const principal = secret ? auth.resolveIntegratorCredential(secret, integratorChannel(request)) : null;
      if (!principal)
        return reply
          .code(401)
          .send(apiError('integrator_key_invalid', 'Integrator key is invalid, revoked or expired'));
      // The bearer MCP endpoint (`/mcp`) filters its tools by the key's mode itself (PM-760).
      if (
        path.startsWith('/api/auth/') ||
        path === routes.me() ||
        path === routes.logout() ||
        path === '/api/setup'
      )
        return reply
          .code(403)
          .send(apiError('integrator_not_allowed', 'Integrator execution policy is not available'));
      request.user = auth.user(principal.userId);
      request.via = 'integrator';
      request.principal = principal;
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

  app.get(routes.setupStatus(), async (): Promise<SetupStatus> => {
    const needsSetup = auth.needsSetup();
    return {
      needsSetup,
      ...(cloud && needsSetup ? { needsSetupCode: true } : {}),
      ...(emailLogin && !needsSetup ? { emailLoginEnabled: true } : {}),
      ...(publicBoard ? { publicBoard: true } : {}),
    };
  });

  registerEmailLoginRoutes(app, {
    auth,
    emailLogin,
    clientIpHeader,
    startSessionFor: async (request, reply, user) => {
      startSession(auth, request, reply, user.id);
      return meOf(domain, user, auth);
    },
  });

  app.post(routes.setup(), async (request, reply) => {
    const local = isLocalRequest(request);
    if (!local && !cloud) {
      throw forbidden(
        'setup_requires_localhost',
        'the first setup must be done on the machine running projectman',
      );
    }
    const body = parseBody(SetupRequest, request.body);
    // Cloud mode: a request that does not come from the machine needs the one-time setup code from the
    // server log. A missing code is not a guess and does not count; a wrong one does, for all clients
    // together, and the tenth voids the code. Once an owner exists there is no code and the answer is
    // already_set_up (from createFirstUser), not a code error.
    if (!local && auth.needsSetup()) {
      const result = body.setupCode === undefined ? 'missing' : (setupCode?.verify(body.setupCode) ?? 'void');
      if (result !== 'ok') {
        throw forbidden(
          'setup_code_invalid',
          result === 'void'
            ? 'the setup code is void; restart the server to get a new one'
            : 'the setup code is missing or wrong',
        );
      }
    }
    const user = await auth.createFirstUser({ name: body.name, email: body.email, password: body.password });
    setupCode?.consume();
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
    ...(await meOf(domain, request.user!, auth)),
    ...(request.via ? { via: request.via } : {}),
  }));

  const keyOwner = (request: FastifyRequest): string => {
    if (request.via)
      throw forbidden('integrator_not_allowed', 'Only the owner may manage this key using their own login');
    // A passwordless (e-mail login) account never holds an integrator key (PM-670); an owner account may (PM-1063).
    if (!request.user || !auth.keyHolderAllowed(request.user.id))
      throw forbidden('owner_only', 'Only an owner may manage this key');
    return request.user.id;
  };
  app.get(routes.integratorKeys(), async (request) => ({
    keys: auth.integratorAccessKeys(keyOwner(request)),
  }));
  app.post(routes.integratorKeys(), async (request, reply) => {
    const userId = keyOwner(request);
    const body = parseBody(CreateIntegratorAccessKeyRequest, request.body);
    const created = auth.createIntegratorAccessKey(userId, body);
    app.log.info({ prefix: created.key.prefix, mode: created.key.mode, userId }, 'Integrator key created');
    return reply.code(201).send(created);
  });
  app.delete<{ Params: { id: string } }>(routes.integratorAccessKey(':id'), async (request) => {
    const userId = keyOwner(request);
    const key = auth.revokeIntegratorAccessKey(userId, request.params.id);
    if (!key) throw new DomainError('not_found', 'Integrator key not found', { status: 404 });
    app.log.info({ prefix: key.prefix, mode: key.mode, userId }, 'Integrator key revoked');
    return { key };
  });
  app.get(routes.integratorKeyAudit(), async (request) => {
    const userId = keyOwner(request);
    return auth.integratorKeyAudit(userId, parseBody(IntegratorKeyAuditQuery, request.query));
  });
}
