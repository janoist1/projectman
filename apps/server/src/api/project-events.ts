import type { FastifyInstance } from 'fastify';
import { ProjectChangeEventsQuery, routes } from '@projectman/shared';
import type { ProjectChangeEventsResponse } from '@projectman/shared';
import type { ApiServices } from './index';
import { requireAccess } from './context';
import { DomainError } from '../kernel';
import { parseBody } from '../http';

/**
 * The project's durable change journal (PM-761), read with a cursor and long polling. It is for
 * internal members and for the integrator keys that may read; before it answers, the credential and the
 * membership are checked again, so a key revoked or expired (or a member removed) during the wait gets
 * the refusal instead of the entries.
 */
export function registerProjectEventRoutes(app: FastifyInstance, services: ApiServices): void {
  const { domain, auth } = services;
  app.get<{ Params: { key: string } }>(
    routes.projectEvents(':key'),
    async (request, reply): Promise<ProjectChangeEventsResponse> => {
      const key = request.params.key;
      await requireAccess(domain, request, key);
      const query = parseBody(ProjectChangeEventsQuery, request.query);
      const principal = request.principal;
      const authToken = request.authToken;
      const gone = new AbortController();
      reply.raw.once('close', () => gone.abort());
      return domain.changes.poll({
        projectKey: key,
        after: query.after,
        limit: query.limit,
        waitMs: query.waitMs,
        signal: gone.signal,
        recheck: async () => {
          if (principal) auth.assertActive(principal);
          else if (!authToken || !auth.resolve(authToken))
            throw new DomainError('unauthorized', 'login required', { status: 401 });
          await requireAccess(domain, request, key);
        },
        subscribe: principal ? (wake) => auth.onIntegratorKeysChanged(wake) : undefined,
        expiresInMs: principal ? () => auth.integratorKeyExpiresInMs(principal.keyId) : undefined,
      });
    },
  );
}
