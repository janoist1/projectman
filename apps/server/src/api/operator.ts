import type { FastifyInstance } from 'fastify';
import { routes, TASK_CREATE_MIN_ACCESS } from '@projectman/shared';
import type { Domain } from '../domain';
import { forbidden } from '../kernel';
import { requireAccess } from './context';

type ProjectParams = { Params: { key: string } };

export function registerOperatorRoutes(app: FastifyInstance, deps: { domain: Domain }): void {
  const { domain } = deps;
  app.post<{ Params: { key: string; signalId: string } }>(
    routes.dismissOperatorSignal(':key', ':signalId'),
    async (request) => {
      const { key, signalId } = request.params;
      const access = await requireAccess(domain, request, key, { internal: true });
      if (access.access !== 'owner' || access.via)
        throw forbidden('operator_owner_only', "only the owner's own login may dismiss a signal");
      return domain.operatorSignals.decision(key, signalId, access.handle, false);
    },
  );

  app.get<ProjectParams>(routes.projectManager(':key'), async (request) => {
    await requireAccess(domain, request, request.params.key, { minimum: TASK_CREATE_MIN_ACCESS });
    return domain.projectManagerChannels.view(request.params.key);
  });

  /**
   * The viewer's own conversation with the Operator and the log of its steps: any person's own login (PM-475);
   * the owners share one, everyone else has theirs, read only. The integrator key never sees it (PM-463).
   */
  app.get<ProjectParams>(routes.operator(':key'), async (request) => {
    const access = await requireAccess(domain, request, request.params.key);
    if (access.via)
      throw forbidden('operator_owner_only', "only a person's own login may see the Operator's conversation");
    return domain.projectManagerChannels.operatorView(request.params.key, access.handle);
  });
}
