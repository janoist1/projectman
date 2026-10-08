import type { FastifyInstance } from 'fastify';
import { CreateInviteRequest, routes } from '@projectman/shared';
import type { Me } from '@projectman/shared';
import {
  clientAddress,
  createAttemptLimiter,
  MAX_FAILED_ATTEMPTS_ALL_CLIENTS,
  meOf,
  startSession,
} from '../auth';
import type { AuthService } from '../auth';
import type { Domain } from '../domain';
import { currentUser, requireAccess, requireOwnLogin } from './context';
import { parseBody } from './validation';

type ProjectParams = { Params: { key: string } };
type TokenParams = { Params: { token: string } };

/** Admins manage a project's invitations; the invite link itself is public (and rate-limited). */
export function registerInvitationRoutes(
  app: FastifyInstance,
  deps: { domain: Domain; auth: AuthService; clientIpHeader?: string },
): void {
  const { domain, auth, clientIpHeader } = deps;
  const { invitations } = domain;
  // Invitation tokens can only be guessed by trying: failed inspections and acceptances count.
  const attempts = createAttemptLimiter({
    max: 10,
    sharedMax: MAX_FAILED_ATTEMPTS_ALL_CLIENTS,
    windowMs: 15 * 60_000,
    message: 'too many invitation attempts; try again later',
  });

  app.post<ProjectParams>(routes.invitations(':key'), async (request, reply) => {
    const access = await requireAccess(domain, request, request.params.key, { minimum: 'admin' });
    requireOwnLogin(access, 'invitations');
    const body = parseBody(CreateInviteRequest, request.body);
    const invite = await invitations.create(request.params.key, body, currentUser(request));
    return reply.code(201).send(invite);
  });
  app.get<ProjectParams>(routes.invitations(':key'), async (request) => {
    await requireAccess(domain, request, request.params.key, { minimum: 'admin' });
    return { invitations: invitations.list(request.params.key) };
  });
  app.delete<{ Params: { key: string; id: string } }>(
    routes.invitation(':key', ':id'),
    async (request, reply) => {
      await requireAccess(domain, request, request.params.key, { minimum: 'admin' });
      await invitations.revoke(request.params.key, request.params.id);
      return reply.code(204).send();
    },
  );
  app.get<TokenParams>(routes.invite(':token'), async (request) => {
    const release = attempts.reserve(clientAddress(request, clientIpHeader));
    const invite = await invitations.inspect(request.params.token);
    release();
    return invite;
  });
  app.post<TokenParams>(routes.acceptInvite(':token'), async (request, reply): Promise<Me> => {
    requireOwnLogin(request, 'members');
    const release = attempts.reserve(clientAddress(request, clientIpHeader));
    const user = await invitations.accept(request.params.token, request.body, request.user);
    release();
    startSession(auth, request, reply, user.id);
    return meOf(domain, user);
  });
}
