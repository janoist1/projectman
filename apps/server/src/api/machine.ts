import type { FastifyInstance } from 'fastify';
import { routes, StopOrphansRequest } from '@projectman/shared';
import type { MachineView, StopOrphansResult } from '@projectman/shared';
import type { Domain } from '../domain';
import { requireInstanceOwner } from './context';
import { parseBody } from './validation';

/**
 * The machine display (PM-320): how loaded the machine is and which session uses it, and the orphan
 * processes of finished sessions with their command lines. For the instance's owner alone.
 */
export function registerMachineRoutes(app: FastifyInstance, domain: Domain): void {
  app.get<{ Querystring: { panel?: string } }>(routes.machine(), async (request): Promise<MachineView> => {
    await requireInstanceOwner(domain, request);
    // `?panel=1`: the panel is open, so it is measured more often.
    return domain.machine.view({ panel: request.query.panel === '1' });
  });

  app.post(routes.machineOrphansStop(), async (request): Promise<StopOrphansResult> => {
    const user = await requireInstanceOwner(domain, request);
    const body = parseBody(StopOrphansRequest, request.body);
    return { results: await domain.machine.stopOrphans(body.orphans, user.id) };
  });
}
