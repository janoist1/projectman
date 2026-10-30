import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { EmailLoginCodeRequest, EmailLoginVerifyRequest, routes } from '@projectman/shared';
import type { Me } from '@projectman/shared';
import { parseBody } from '../http';
import { clientAddress, DomainError, unavailable } from '../kernel';
import type { EmailLoginService } from '../services/email-login';
import type { AuthService, AuthUser } from './auth-service';

/**
 * The e-mail login of invited clients (PM-670): a code request and its redemption. Both are public
 * routes (same-origin only, like the other login routes). Without the service, or before the first setup,
 * both answer `email_login_unavailable` before they look at the body.
 */
export function registerEmailLoginRoutes(
  app: FastifyInstance,
  deps: {
    auth: AuthService;
    emailLogin: EmailLoginService | null;
    clientIpHeader?: string;
    /** Starts the session of the user (the old one is revoked) and returns the `Me` the login answers. */
    startSessionFor(request: FastifyRequest, reply: FastifyReply, user: AuthUser): Promise<Me>;
  },
): void {
  const { auth, emailLogin, clientIpHeader, startSessionFor } = deps;

  const available = (): EmailLoginService => {
    if (!emailLogin || auth.needsSetup())
      throw unavailable('email_login_unavailable', 'the e-mail login is not available');
    return emailLogin;
  };

  /** The 429 carries the wait in a header as well as in its details. */
  const withRetryAfter = (error: unknown, reply: { header(name: string, value: string): unknown }): never => {
    if (error instanceof DomainError && error.code === 'email_login_rate_limited') {
      const seconds = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (seconds) reply.header('retry-after', String(seconds));
    }
    throw error;
  };

  app.post(routes.emailLoginRequest(), async (request, reply) => {
    const service = available();
    const body = parseBody(EmailLoginCodeRequest, request.body);
    try {
      return reply.code(202).send(service.requestCode(body, clientAddress(request, clientIpHeader)));
    } catch (err) {
      return withRetryAfter(err, reply);
    }
  });

  app.post(routes.emailLoginVerify(), async (request, reply) => {
    const service = available();
    const body = parseBody(EmailLoginVerifyRequest, request.body);
    let userId: string;
    try {
      ({ userId } = await service.verify(body, clientAddress(request, clientIpHeader)));
    } catch (err) {
      return withRetryAfter(err, reply);
    }
    const user = auth.user(userId);
    if (!user)
      throw new DomainError('email_login_no_access', 'this address has no access to log in', { status: 403 });
    return startSessionFor(request, reply, user);
  });
}
