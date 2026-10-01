import type { FastifyInstance } from 'fastify';
import { BoundaryId, routes } from '@projectman/shared';
import type { EgressAllowance, RuntimeBoundaryStatus } from '@projectman/shared';
import type { Domain } from '../domain';
import { requireAccess } from './context';
import { parseBody } from './validation';

type Params = { Params: { key: string; id: string } };

/**
 * The VM boundary (PM-140): its verdict for every logged-in member (codes and times only, as the
 * provider status), and the network destinations opened for a project's members, which owners
 * list and close.
 */
export function registerRuntimeBoundaryRoutes(app: FastifyInstance, domain: Domain): void {
  app.get(routes.runtimeBoundary(), async (): Promise<RuntimeBoundaryStatus> => {
    const boundary = domain.runtimeBoundary;
    if (boundary) return boundary.status();
    return {
      mode: 'off',
      ready: false,
      checkedAt: domain.ctx.now().toISOString(),
      problems: ['not_configured'],
      launcher: 'off',
      egress: 'off',
      readiness: null,
    };
  });
  app.get<{ Params: { key: string } }>(routes.egressAllowances(':key'), async (request): Promise<EgressAllowance[]> => {
    const { key } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'owner' });
    return domain.egress.listAllowances(key, access.handle);
  });
  app.post<Params>(routes.revokeEgressAllowance(':key', ':id'), async (request): Promise<EgressAllowance> => {
    const { key, id } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'owner' });
    return domain.egress.revokeAllowance(key, parseBody(BoundaryId, id), access.handle);
  });
}
