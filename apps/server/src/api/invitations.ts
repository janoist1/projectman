import type { FastifyInstance, FastifyReply } from 'fastify';
import { CreateInviteRequest, routes } from '@projectman/shared';
import type { Me } from '@projectman/shared';
import type { AuthService, AuthUser } from '../auth/auth-service';
import type { Domain } from '../domain';
import { DomainError } from '../domain/errors';
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
  const attempts = new Map<string, { count: number; resetAt: number }>();
  const rateLimit = (ip: string) => {
    const now = Date.now();
    // Bound memory even when requests arrive from many addresses.
    for (const [key, value] of attempts) if (value.resetAt <= now) attempts.delete(key);
    const entry = attempts.get(ip) ?? { count: 0, resetAt: now + 15 * 60_000 };
    if (entry.count >= 10)
      throw new DomainError('too_many_attempts', 'too many invitation attempts; try again later', {
        status: 429,
      });
    entry.count++;
    attempts.set(ip, entry);
  };

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
    rateLimit(request.ip);
    return service.inspect(request.params.token);
  });
  app.post<{ Params: { token: string } }>(routes.acceptInvite(':token'), async (request, reply) => {
    rateLimit(request.ip);
    const user = await service.accept(request.params.token, request.body, request.user);
    deps.setSessionCookie(reply, deps.auth.createSession(user.id));
    return deps.me(user);
  });
}
