import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MemberHandle,
  routes,
  SendMessageRequest,
  SendTeamMessageRequest,
  TaskKey,
} from '@projectman/shared';
import type { Session, SessionDetail, TeamMessagesView } from '@projectman/shared';
import { notFound } from '../domain';
import type { Domain } from '../domain';
import { canSeeTask, teamMessageMember } from '../domain/visibility';
import { requireAccess } from './context';
import { parseBody } from './validation';

type ProjectParams = { Params: { key: string } };
type SessionParams = { Params: { key: string; sessionId: string } };

const MessagesQuery = z.object({
  taskKey: TaskKey.optional(),
  member: MemberHandle.optional(),
  threadWith: MemberHandle.optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function registerSessionRoutes(app: FastifyInstance, domain: Domain): void {
  /** Session with its chat, parsed from the Claude Code transcript. */
  app.get<SessionParams>(routes.session(':key', ':sessionId'), async (request): Promise<SessionDetail> => {
    const { key, sessionId } = request.params;
    await requireAccess(domain, request, key, { internal: true });
    return domain.sessions.detail(key, sessionId);
  });

  /** A human writes into the session (plain text); a stopped session is resumed for it. */
  app.post<SessionParams>(routes.sessionMessages(':key', ':sessionId'), async (request, reply) => {
    const { key, sessionId } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    const body = parseBody(SendMessageRequest, request.body);
    const message = await domain.sessions.sendHumanMessage(key, sessionId, body.text, access.handle);
    return reply.code(202).send(message);
  });

  app.post<SessionParams>(routes.stopSession(':key', ':sessionId'), async (request): Promise<Session> => {
    const { key, sessionId } = request.params;
    await requireAccess(domain, request, key, { minimum: 'developer' });
    return domain.sessions.stop(key, sessionId);
  });

  app.post<ProjectParams>(routes.sendTeamMessage(':key'), async (request, reply) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { messaging: true });
    const body = parseBody(SendTeamMessageRequest, request.body);
    if (body.taskKey && !canSeeTask(access, domain.tasks.get(key, body.taskKey)))
      throw notFound('task', body.taskKey);
    return reply.code(202).send(await domain.sessions.sendTeamMessage(key, access.handle, body));
  });

  app.post<{ Params: { key: string; id: string } }>(
    routes.readTeamMessage(':key', ':id'),
    async (request) => {
      const { key, id } = request.params;
      const access = await requireAccess(domain, request, key);
      return domain.messages.markRead(key, id, access.handle, await domain.members.humanHandles(key));
    },
  );

  app.get<ProjectParams>(routes.teamMessages(':key'), async (request): Promise<TeamMessagesView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key);
    const query = parseBody(MessagesQuery, request.query);
    return {
      messages: domain.messages.list(key, {
        taskKey: query.taskKey,
        member: teamMessageMember(access, query.member),
        between: query.threadWith ? [access.handle, query.threadWith] : undefined,
        limit: query.limit,
        unreadFor: query.unreadOnly === 'true' ? access.handle : undefined,
      }),
      unreadCount: domain.ctx.repos.messages.countUnread(key, access.handle),
    };
  });
}
