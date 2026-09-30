import type { FastifyInstance } from 'fastify';
import {
  HireMemberRequest,
  AddHumanMemberRequest,
  RetireMemberRequest,
  routes,
  UpdateMemberRequest,
  memberDuties,
  isHumanOnlyLabel,
  labelDefinition,
  labelHolders,
} from '@projectman/shared';
import type { MemberProfile, MemberView } from '@projectman/shared';
import { notFound, forbidden } from '../domain';
import type { Domain } from '../domain';
import { canSeeTask } from '../domain/visibility';
import { actorOf, authorOf, requireAccess, sponsorFor } from './context';
import { parseBody } from './validation';

type ProjectParams = { Params: { key: string } };
type MemberParams = { Params: { key: string; handle: string } };

export function registerMemberRoutes(app: FastifyInstance, domain: Domain): void {
  app.get<ProjectParams>(routes.members(':key'), async (request): Promise<MemberView[]> => {
    await requireAccess(domain, request, request.params.key);
    return domain.members.roster(request.params.key);
  });

  app.get<MemberParams>(routes.memberProfile(':key', ':handle'), async (request): Promise<MemberProfile> => {
    const { key, handle } = request.params;
    const access = await requireAccess(domain, request, key);
    const config = await domain.projects.config(key);
    const original = config.team.members.find((m) => m.handle === handle);
    const member = (await domain.members.roster(key)).find((m) => m.handle === handle);
    if (!original || !member) throw notFound('member', handle);
    const internal = access.access !== 'client';
    const approverStages = config.pipeline.stages
      .filter((s) =>
        s.gate?.conditions.some((c) => {
          const label = c.type === 'has_label' ? labelDefinition(config, c.label) : undefined;
          return (
            label !== undefined && isHumanOnlyLabel(label) && labelHolders(config, label).includes(handle)
          );
        }),
      )
      .map((s) => s.id);
    const awaitingKeys = new Set(
      domain.inbox
        .list(key)
        .filter((i) => i.state === 'open' && i.assignees.includes(handle))
        .map((i) => i.taskKey),
    );
    const tasks = domain.tasks
      .list(key)
      .filter((t) => !['done', 'cancelled'].includes(t.status))
      .filter(
        (t) =>
          canSeeTask(access, t) &&
          (t.assignee === handle ||
            member.currentTaskKeys.includes(t.key) ||
            approverStages.includes(t.stageId) ||
            awaitingKeys.has(t.key)),
      );
    const visibleKeys = new Set(
      domain.tasks
        .list(key)
        .filter((t) => canSeeTask(access, t))
        .map((t) => t.key),
    );
    return {
      member: { ...member, currentTaskKeys: member.currentTaskKeys.filter((k) => visibleKeys.has(k)) },
      duties: memberDuties(config, original),
      tasks,
      inbox: domain.inbox
        .list(key)
        .filter(
          (i) => i.state === 'open' && i.assignees.includes(handle) && (internal || handle === access.handle),
        ),
      timeline: internal ? domain.ctx.repos.timeline.forMember(key, handle) : [],
      sessions: internal
        ? domain.sessions
            .list(key, { member: handle })
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
        : [],
      capacity: original.kind === 'ai' ? original.capacity : null,
      capacityUsed: original.kind === 'ai' && internal ? domain.scheduler.memberLoad(key, handle) : 0,
      ...(original.kind === 'human' && ['owner', 'admin'].includes(access.access) && original.email
        ? { email: original.email }
        : {}),
    };
  });

  app.get<MemberParams>(routes.memberMemories(':key', ':handle'), async (request) => {
    const { key, handle } = request.params;
    await requireAccess(domain, request, key, { internal: true });
    return { memory: await domain.sessions.memory(key, handle) };
  });

  app.post<MemberParams>(routes.startConversation(':key', ':handle'), async (request, reply) => {
    const { key, handle } = request.params;
    await requireAccess(domain, request, key, { minimum: 'developer' });
    return reply.code(202).send(await domain.scheduler.startConversation(key, handle));
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
      sponsor: await sponsorFor(domain, access),
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
