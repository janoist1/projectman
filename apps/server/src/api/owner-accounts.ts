import type { FastifyInstance } from 'fastify';
import { CreateOwnerInviteRequest, routes } from '@projectman/shared';
import type { Me, OwnerAccountsView } from '@projectman/shared';
import {
  clientAddress,
  createAttemptLimiter,
  MAX_FAILED_ATTEMPTS_ALL_CLIENTS,
  meOf,
  startSession,
} from '../auth';
import type { AuthService, OwnerAccountService } from '../auth';
import type { ApiDomain } from './ports';
import { currentUser, requireOwnLogin } from './context';
import { parseBody } from '../http';

type TokenParams = { Params: { token: string } };

/**
 * The owner accounts (PM-1062): the host owner invites an owner, lists the owner accounts and revokes one with
 * their own login; the invite link itself is public (and rate-limited), like a project invitation's.
 */
export function registerOwnerAccountRoutes(
  app: FastifyInstance,
  deps: { domain: ApiDomain; auth: AuthService; ownerAccounts: OwnerAccountService; clientIpHeader?: string },
): void {
  const { domain, auth, ownerAccounts, clientIpHeader } = deps;
  const { ownerInvitations } = domain;
  // Invitation tokens can only be guessed by trying: failed inspections and acceptances count.
  const attempts = createAttemptLimiter({
    max: 10,
    sharedMax: MAX_FAILED_ATTEMPTS_ALL_CLIENTS,
    windowMs: 15 * 60_000,
    message: 'too many invitation attempts; try again later',
  });
  /** The host owner's own login: a key (even the host's) never manages the owners. */
  const host = (request: Parameters<typeof currentUser>[0]) => {
    requireOwnLogin(request, 'members');
    return currentUser(request);
  };

  app.post(routes.ownerInvitations(), async (request, reply) => {
    const user = host(request);
    const body = parseBody(CreateOwnerInviteRequest, request.body);
    return reply.code(201).send(await ownerInvitations.create(body, user));
  });
  app.get(routes.ownerInvitations(), async (request) => {
    return { invitations: ownerInvitations.list(host(request)) };
  });
  app.delete<{ Params: { id: string } }>(routes.ownerInvitation(':id'), async (request, reply) => {
    await ownerInvitations.revoke(request.params.id, host(request));
    return reply.code(204).send();
  });
  app.get(routes.ownerAccounts(), async (request): Promise<OwnerAccountsView> => {
    return { accounts: await ownerAccounts.list(host(request)) };
  });
  app.post<{ Params: { userId: string } }>(routes.revokeOwnerAccount(':userId'), async (request) =>
    ownerAccounts.revoke(request.params.userId, host(request)),
  );

  app.get<TokenParams>(routes.ownerInvite(':token'), async (request) => {
    const release = attempts.reserve(clientAddress(request, clientIpHeader));
    const invite = ownerInvitations.inspect(request.params.token);
    release();
    return invite;
  });
  app.post<TokenParams>(routes.acceptOwnerInvite(':token'), async (request, reply): Promise<Me> => {
    requireOwnLogin(request, 'members');
    const release = attempts.reserve(clientAddress(request, clientIpHeader));
    const user = await ownerInvitations.accept(request.params.token, request.body, request.user);
    release();
    startSession(auth, request, reply, user.id);
    return meOf(domain, user, auth);
  });
}
