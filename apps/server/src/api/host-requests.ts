import type { FastifyInstance } from 'fastify';
import { AnswerHostRequestRequest, HostRequestState, routes } from '@projectman/shared';
import { instanceUser } from './context';
import type { ApiDomain } from './ports';
import { invalid } from '../kernel';
import { parseBody } from '../http';

/**
 * The host's side of the requests the project managers of other owners' projects open (PM-1064). The service
 * decides who the host is; a personal login and the host's integrator key reach it alike.
 */
export function registerHostRequestRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.get(routes.hostRequests(), async (request) => {
    const user = await instanceUser(domain, request, 'read');
    const { state } = request.query as { state?: string };
    const parsed =
      state === undefined ? { success: true as const, data: undefined } : HostRequestState.safeParse(state);
    if (!parsed.success) throw invalid('invalid_request', 'Unknown request state');
    return domain.hostRequests.listForHost(user.id, parsed.data);
  });
  app.post<{ Params: { id: string } }>(routes.answerHostRequest(':id'), async (request) => {
    const user = await instanceUser(domain, request, 'write');
    const body = parseBody(AnswerHostRequestRequest, request.body);
    return domain.hostRequests.answer(user.id, request.params.id, body, request.principal ? 'super' : 'web');
  });
}
