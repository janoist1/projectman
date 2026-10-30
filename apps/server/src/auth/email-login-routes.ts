import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  EmailLoginCodeRequest,
  EmailLoginVerifyRequest,
  PasswordCodeRequest,
  PasswordResetRequest,
  routes,
} from '@projectman/shared';
import type { Me } from '@projectman/shared';
import { parseBody } from '../http';
import { clientAddress, DomainError, unavailable } from '../kernel';
import type { EmailLoginService } from '../services/email-login';
import type { AuthService } from './auth-service';

/**
 * The e-mail login of invited clients (PM-670): a code request and its redemption, and the same pair for
 * setting a password (PM-946). All are public
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
    startSessionFor(
      request: FastifyRequest,
      reply: FastifyReply,
      user: { id: string; name: string; email: string },
    ): Promise<Me>;
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

  app.post(routes.passwordCodeRequest(), async (request, reply) => {
    const service = available();
    const body = parseBody(PasswordCodeRequest, request.body);
    try {
      return reply
        .code(202)
        .send(service.requestCode(body, clientAddress(request, clientIpHeader), 'password'));
    } catch (err) {
      return withRetryAfter(err, reply);
    }
  });

  // The body is checked first, so a too short password never spends the code. The password is hashed and
  // stored only after the code is redeemed, and that ends every session of the account (PM-946).
  app.post(routes.passwordReset(), async (request, reply) => {
    const service = available();
    const body = parseBody(PasswordResetRequest, request.body);
    let userId: string;
    try {
      ({ userId } = await service.redeemPasswordCode(body, clientAddress(request, clientIpHeader)));
    } catch (err) {
      return withRetryAfter(err, reply);
    }
    const user = auth.user(userId);
    if (!user)
      throw new DomainError('email_login_no_access', 'this address has no access to log in', { status: 403 });
    await auth.setPassword(userId, body.password);
    return startSessionFor(request, reply, user);
  });
}
