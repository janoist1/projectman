import type { FastifyInstance } from 'fastify';
import { InvolvementQuery, routes } from '@projectman/shared';
import type { Domain } from '../domain';
import { requireAccess } from './context';
import { parseBody } from './validation';

export function registerInvolvementRoutes(app: FastifyInstance, domain: Domain): void {
  app.get<{ Params: { key: string } }>(routes.involvements(':key'), async (request) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { internal: true });
    return domain.involvements.list(key, parseBody(InvolvementQuery, request.query), access);
  });
}
