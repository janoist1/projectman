import type { FastifyInstance } from 'fastify';
import { InvolvementQuery, routes } from '@projectman/shared';
import type { ApiDomain } from './ports';
import { requireAccess } from './context';
import { parseBody } from '../http';

export function registerInvolvementRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.get<{ Params: { key: string } }>(routes.involvements(':key'), async (request) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key);
    return domain.involvements.list(key, parseBody(InvolvementQuery, request.query), access);
  });
}
