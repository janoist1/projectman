import type { FastifyInstance } from 'fastify';
import { isErrorCode, routes } from '@projectman/shared';
import type { Domain } from '../domain';
import { DomainError } from '../domain';
import { requireAccess } from './context';

export function registerScheduleRoutes(app: FastifyInstance, domain: Domain): void {
  app.get<{ Params: { key: string } }>(routes.schedules(':key'), async (request) => {
    await requireAccess(domain, request, request.params.key);
    return domain.schedules.view(request.params.key);
  });
  app.post<{ Params: { key: string; handle: string } }>(
    routes.runSchedule(':key', ':handle'),
    async (request, reply) => {
      const { key, handle } = request.params;
      await requireAccess(domain, request, key, { minimum: 'admin' });
      const run = await domain.schedules.runNow(key, handle);
      if (run.status === 'skipped' || run.status === 'failed')
        throw new DomainError(
          isErrorCode(run.reason) ? run.reason : 'session_start_failed',
          'Scheduled run refused',
          {
            status: run.status === 'skipped' ? 409 : 502,
            details: { reason: run.reason, run },
          },
        );
      return reply.code(201).send(run);
    },
  );
}
