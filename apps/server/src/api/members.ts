import type { FastifyInstance } from 'fastify';
import { HireMemberRequest, RetireMemberRequest, routes } from '@projectman/shared';
import type { MemberView } from '@projectman/shared';
import type { Domain } from '../domain';
import { actorOf, authorOf, requireAccess, sponsorFor } from './context';
import { parseBody } from './validation';

type ProjectParams = { Params: { key: string } };
type MemberParams = { Params: { key: string; handle: string } };

export function registerMemberRoutes(app: FastifyInstance, domain: Domain): void {
  app.get<ProjectParams>(routes.members(':key'), async (request): Promise<MemberView[]> => {
    await requireAccess(domain, request, request.params.key);
    return domain.members.roster(request.params.key);
  });

  /** Hires an AI member; the requesting human sponsors it (runs on their subscription). */
  app.post<ProjectParams>(routes.members(':key'), async (request, reply) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(HireMemberRequest, request.body);
    const hired = await domain.members.hire(key, body, {
      actor: actorOf(access),
      author: authorOf(request),
      sponsor: await sponsorFor(domain, access),
    });
    const view = (await domain.members.roster(key)).find((m) => m.handle === hired.handle);
    return reply.code(201).send(view);
  });

  /** Retires an AI member, handing its tasks over. */
  app.delete<MemberParams>(routes.member(':key', ':handle'), async (request, reply) => {
    const { key, handle } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(RetireMemberRequest, request.body);
    await domain.members.retire(
      key,
      handle,
      { handoverTo: body.handoverTo },
      { actor: actorOf(access), author: authorOf(request) },
    );
    return reply.code(204).send();
  });
}
