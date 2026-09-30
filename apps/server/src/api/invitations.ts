import type { FastifyInstance, FastifyReply } from 'fastify';
import { CreateInviteRequest, routes } from '@projectman/shared';
import type { Me } from '@projectman/shared';
import { createAttemptLimiter } from '../auth/attempt-limiter';
import type { AuthService, AuthUser } from '../auth/auth-service';
import type { Domain } from '../domain';
import { InvitationService } from '../domain/invitations';
import { requireAccess } from './context';
import { parseBody } from './validation';

export function registerInvitationRoutes(
  app: FastifyInstance,
  deps: {
    domain: Domain;
    auth: AuthService;
    me: (user: AuthUser) => Promise<Me>;
    setSessionCookie: (reply: FastifyReply, token: string) => unknown;
  },
): void {
  const service = new InvitationService(deps.domain, deps.auth);
  // Invitation tokens can only be guessed by trying: failed inspections and acceptances count.
  const attempts = createAttemptLimiter({
    max: 10,
    windowMs: 15 * 60_000,
    message: 'too many invitation attempts; try again later',
  });

  app.post<{ Params: { key: string } }>(routes.invitations(':key'), async (request, reply) => {
    await requireAccess(deps.domain, request, request.params.key, { minimum: 'admin' });
    const invite = await service.create(
      request.params.key,
      parseBody(CreateInviteRequest, request.body),
      request.user!,
    );
    return reply.code(201).send(invite);
  });
  app.get<{ Params: { key: string } }>(routes.invitations(':key'), async (request) => {
    await requireAccess(deps.domain, request, request.params.key, { minimum: 'admin' });
    return { invitations: service.list(request.params.key) };
  });
  app.delete<{ Params: { key: string; id: string } }>(
    routes.invitation(':key', ':id'),
    async (request, reply) => {
      await requireAccess(deps.domain, request, request.params.key, { minimum: 'admin' });
      await service.revoke(request.params.key, request.params.id);
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { token: string } }>(routes.invite(':token'), async (request) => {
    const release = attempts.reserve(request.ip);
    const invite = await service.inspect(request.params.token);
    release();
    return invite;
  });
  app.post<{ Params: { token: string } }>(routes.acceptInvite(':token'), async (request, reply) => {
    const release = attempts.reserve(request.ip);
    const user = await service.accept(request.params.token, request.body, request.user);
    release();
    if (request.authToken) deps.auth.revoke(request.authToken);
    deps.setSessionCookie(reply, deps.auth.createSession(user.id));
    return deps.me(user);
  });
}
