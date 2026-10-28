import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SetEmailContactRequest, routes } from '@projectman/shared';
import type { ApiDomain } from './ports';
import { requireAccess } from './context';
import { parseBody } from '../http';

type ProjectParams = { Params: { key: string } };
type ContactParams = { Params: { key: string; handle: string } };

const LogQuery = z.object({ before: z.string().min(1).optional() });

export function registerEmailChannelRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.get<ProjectParams>(routes.emailChannel(':key'), async (request) => {
    const key = request.params.key;
    await requireAccess(domain, request, key, { minimum: 'admin' });
    return domain.emailChannel.view(key);
  });

  app.put<ContactParams>(routes.emailContact(':key', ':handle'), async (request) => {
    const { key, handle } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(SetEmailContactRequest, request.body);
    return domain.emailChannel.setContact(key, handle, body.wants, {
      handle: access.handle,
    });
  });

  app.get<ProjectParams>(routes.emailLog(':key'), async (request) => {
    const key = request.params.key;
    await requireAccess(domain, request, key, { minimum: 'admin' });
    const query = LogQuery.parse(request.query);
    return domain.emailChannel.log(key, query.before ?? null);
  });
}
