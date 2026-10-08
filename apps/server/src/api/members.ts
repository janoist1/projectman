import type { FastifyInstance } from 'fastify';
import {
  HireMemberRequest,
  AddHumanMemberRequest,
  RetireMemberRequest,
  routes,
  UpdateMemberRequest,
} from '@projectman/shared';
import type { MemberProfile, MemberView } from '@projectman/shared';
import { forbidden } from '../domain';
import type { Domain } from '../domain';
import { actorOf, authorOf, requireAccess } from './context';
import { parseBody } from './validation';

type ProjectParams = { Params: { key: string } };
type MemberParams = { Params: { key: string; handle: string } };

export function registerMemberRoutes(app: FastifyInstance, domain: Domain): void {
  app.get<ProjectParams>(routes.members(':key'), async (request): Promise<MemberView[]> => {
    const access = await requireAccess(domain, request, request.params.key);
    return domain.members.rosterOf(request.params.key, access);
  });

  app.get<MemberParams>(routes.memberProfile(':key', ':handle'), async (request): Promise<MemberProfile> => {
    const { key, handle } = request.params;
    const access = await requireAccess(domain, request, key);
    return domain.profiles.profile(key, handle, access);
  });

  app.get<MemberParams>(routes.memberMemories(':key', ':handle'), async (request) => {
    const { key, handle } = request.params;
    await requireAccess(domain, request, key, { internal: true });
    return { memory: await domain.sessions.memory(key, handle) };
  });

  app.post<MemberParams>(routes.startConversation(':key', ':handle'), async (request, reply) => {
    const { key, handle } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    return reply.code(202).send(await domain.messageStarts.startConversation(key, handle, actorOf(access)));
  });

  app.delete<MemberParams>(routes.removeHuman(':key', ':handle'), async (request, reply) => {
    const { key, handle } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    if (handle === access.handle) throw forbidden('cannot_remove_self', 'Cannot remove yourself');
    await domain.members.removeHuman(key, handle, { actor: actorOf(access), author: authorOf(request) });
    return reply.code(204).send();
  });

  app.post<ProjectParams>(routes.addHumanMember(':key'), async (request, reply) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(AddHumanMemberRequest, request.body);
    const member = await domain.members.addHuman(key, body, {
      actor: actorOf(access),
      author: authorOf(request),
    });
    return reply.code(201).send(member);
  });

  /** Hires an AI member for a role an AI may hold; the requesting human sponsors it (runs on their subscription). */
  app.post<ProjectParams>(routes.members(':key'), async (request, reply) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(HireMemberRequest, request.body);
    const hired = await domain.members.hire(key, body, {
      actor: actorOf(access),
      author: authorOf(request),
      sponsor: await domain.members.sponsorFor(access),
    });
    const view = (await domain.members.roster(key)).find((m) => m.handle === hired.handle);
    return reply.code(201).send(view);
  });

  /** Changes a member: display name; a human's roles; an AI member's specialty, model and schedule. */
  app.patch<MemberParams>(routes.member(':key', ':handle'), async (request): Promise<MemberView> => {
    const { key, handle } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(UpdateMemberRequest, request.body);
    return domain.members.update(key, handle, body, { actor: actorOf(access), author: authorOf(request) });
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
