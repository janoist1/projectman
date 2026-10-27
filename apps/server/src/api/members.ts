import type { FastifyInstance } from 'fastify';
import {
  HireMemberRequest,
  MemberContextQuery,
  hasOperatorWaiverField,
  AddHumanMemberRequest,
  RenameMemberRequest,
  RetireMemberRequest,
  routes,
  UpdateMemberRequest,
} from '@projectman/shared';
import type { MemberProfile, MemberView } from '@projectman/shared';
import { forbidden } from '../kernel';
import type { ApiDomain } from './ports';
import { actorOf, authorOf, requireAccess } from './context';
import { parseBody } from '../http';

type ProjectParams = { Params: { key: string } };
type MemberParams = { Params: { key: string; handle: string } };

export function registerMemberRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.get<ProjectParams>(routes.members(':key'), async (request): Promise<MemberView[]> => {
    await requireAccess(domain, request, request.params.key);
    return domain.members.roster(request.params.key);
  });

  app.get<MemberParams>(routes.memberProfile(':key', ':handle'), async (request): Promise<MemberProfile> => {
    const { key, handle } = request.params;
    const access = await requireAccess(domain, request, key);
    return domain.profiles.profile(key, handle, access);
  });

  app.get<MemberParams>(routes.memberMemories(':key', ':handle'), async (request) => {
    const { key, handle } = request.params;
    await requireAccess(domain, request, key);
    return { memory: await domain.sessions.memory(key, handle) };
  });

  app.get<MemberParams>(routes.memberContext(':key', ':handle'), async (request) => {
    const { key, handle } = request.params;
    if (request.principal)
      throw forbidden('insufficient_access', "only the owner's own login may preview context");
    const access = await requireAccess(domain, request, key, { minimum: 'owner' });
    if (access.via) throw forbidden('insufficient_access', "only the owner's own login may preview context");
    const query = parseBody(MemberContextQuery, request.query);
    return domain.sessions.previewContext(key, handle, { taskKey: query.task, viewer: access.handle });
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
    await domain.members.removeHuman(key, handle, {
      actor: actorOf(access),
      author: authorOf(request, access),
    });
    return reply.code(204).send();
  });

  app.post<ProjectParams>(routes.addHumanMember(':key'), async (request, reply) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(AddHumanMemberRequest, request.body);
    const member = await domain.members.addHuman(key, body, {
      actor: actorOf(access),
      author: authorOf(request, access),
    });
    return reply.code(201).send(member);
  });

  /** Hires an AI member for a role an AI may hold; the requesting human sponsors it (runs on their subscription). */
  app.post<ProjectParams>(routes.members(':key'), async (request, reply) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    if (hasOperatorWaiverField(request.body))
      throw forbidden('owner_approval_required', 'use the dedicated owner waiver endpoint');
    const body = parseBody(HireMemberRequest, request.body);
    const hired = await domain.members.hire(key, body, {
      actor: actorOf(access),
      author: authorOf(request, access),
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
    return domain.members.update(key, handle, body, {
      actor: actorOf(access),
      author: authorOf(request, access),
    });
  });

  /** Renames an AI member (PM-1025); the owner's own call, refused while the member works. */
  app.post<MemberParams>(routes.memberRename(':key', ':handle'), async (request): Promise<MemberView> => {
    const { key, handle } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'owner' });
    const body = parseBody(RenameMemberRequest, request.body);
    return domain.members.rename(key, handle, body.handle, {
      actor: actorOf(access),
      author: authorOf(request, access),
    });
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
      { actor: actorOf(access), author: authorOf(request, access) },
    );
    return reply.code(204).send();
  });
}
