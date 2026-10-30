import type { FastifyInstance } from 'fastify';
import { routes, SaveNtfyChannelRequest } from '@projectman/shared';
import { currentUser } from './context';
import type { ApiDomain } from './ports';
import { parseBody } from '../http';

export function registerNtfyRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.get(routes.pushNtfy(), async (request) => domain.ntfy.overview(currentUser(request).id));
  app.put(routes.pushNtfy(), async (request) =>
    domain.ntfy.save(
      currentUser(request).id,
      parseBody(SaveNtfyChannelRequest, request.body ?? {}),
      request.headers.origin,
    ),
  );
  app.delete(routes.pushNtfy(), async (request, reply) => {
    domain.ntfy.remove(currentUser(request).id);
    return reply.code(204).send();
  });
  app.post(routes.pushNtfyTopic(), async (request) => domain.ntfy.renewTopic(currentUser(request).id));
  app.post(routes.pushNtfyTest(), async (request) => domain.ntfy.test(currentUser(request).id));
}
