import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  canSeeOperatorSessions,
  MemberHandle,
  operatorOf,
  ReadTeamMessagesRequest,
  routes,
  SendMessageRequest,
  SendTeamMessageRequest,
  TaskKey,
  UpdateSessionRequest,
  StopSessionRequest,
} from '@projectman/shared';
import type { Session, SessionDetail, TeamMessagesView, TeamThreadsView } from '@projectman/shared';
import { notFound } from '../kernel';
import type { ApiDomain } from './ports';
import { forbidden } from '../kernel';
import { canSeeTask, teamMessageParticipant, visibleSession } from '../core/projects';
import type { Viewer } from '../core/projects';
import { actorOf, requireAccess } from './context';
import { parseBody } from '../http';

type ProjectParams = { Params: { key: string } };
type SessionParams = { Params: { key: string; sessionId: string } };

const MessagesQuery = z.object({
  taskKey: TaskKey.optional(),
  member: MemberHandle.optional(),
  threadWith: MemberHandle.optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** The Operator's sessions are for the owner and the admin only (PM-475): to anyone else they do not exist. */
function assertMaySeeSession(domain: ApiDomain, viewer: Viewer, sessionId: string): void {
  if (!canSeeOperatorSessions(viewer) && domain.sessions.isOperatorSession(sessionId))
    throw notFound('session', sessionId);
}

export function registerSessionRoutes(app: FastifyInstance, domain: ApiDomain): void {
  /** Session with its chat, parsed from the Claude Code transcript. */
  app.get<SessionParams>(routes.session(':key', ':sessionId'), async (request): Promise<SessionDetail> => {
    const { key, sessionId } = request.params;
    const access = await requireAccess(domain, request, key, { internal: true });
    assertMaySeeSession(domain, access, sessionId);
    const detail = await domain.sessions.detail(key, sessionId);
    return { ...detail, session: visibleSession(access, detail.session, (id) => domain.messages.get(id)) };
  });

  /**
   * An owner sets the session's own permission mode and approver (PM-170); `null` goes back to the
   * member's. Nobody else may: not an admin, and not an AI member (which has no web access).
   */
  app.patch<SessionParams>(routes.session(':key', ':sessionId'), async (request): Promise<Session> => {
    const { key, sessionId } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'owner' });
    assertMaySeeSession(domain, access, sessionId);
    const body = parseBody(UpdateSessionRequest, request.body);
    return domain.sessions.updatePermissions(key, sessionId, body, actorOf(access));
  });

  /** A human writes into the session (plain text); a stopped session is resumed for it. */
  app.post<SessionParams>(routes.sessionMessages(':key', ':sessionId'), async (request, reply) => {
    const { key, sessionId } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    assertMaySeeSession(domain, access, sessionId);
    const body = parseBody(SendMessageRequest, request.body);
    const message = await domain.messaging.sendToSession(
      key,
      sessionId,
      body.text,
      access.handle,
      actorOf(access),
    );
    return reply.code(202).send(message);
  });

  app.post<SessionParams>(routes.stopSession(':key', ':sessionId'), async (request): Promise<Session> => {
    const { key, sessionId } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    assertMaySeeSession(domain, access, sessionId);
    const body = parseBody(StopSessionRequest, request.body ?? {});
    const stopped = await domain.sessions.stop(key, sessionId, {
      kind: body.purpose ?? 'manual',
      by: actorOf(access),
      ...(body.note ? { note: body.note } : {}),
    });
    return visibleSession(access, stopped, (id) => domain.messages.get(id));
  });

  app.post<ProjectParams>(routes.sendTeamMessage(':key'), async (request, reply) => {
    const key = request.params.key;
    // A read-only member talks to the Operator alone (PM-475); the team's other members are not theirs to write to.
    const access = await requireAccess(domain, request, key);
    const body = parseBody(SendTeamMessageRequest, request.body);
    // `attachmentIds` ride along in `body`: the messaging service checks and binds them.
    if (access.access === 'viewer') {
      const operator = operatorOf(await domain.projects.config(key));
      if (!operator || body.to.some((handle) => handle !== operator.handle))
        throw forbidden('insufficient_access', 'Developer or client access required');
    }
    if (body.taskKey && !canSeeTask(access, domain.tasks.get(key, body.taskKey)))
      throw notFound('task', body.taskKey);
    return reply.code(202).send(
      await domain.messaging.send(key, access.handle, body, {
        workerCheck: !body.despiteWorkers,
        actor: actorOf(access),
        operatorSignal: body.operatorSignal,
      }),
    );
  });

  app.post<{ Params: { key: string; id: string } }>(
    routes.readTeamMessage(':key', ':id'),
    async (request) => {
      const { key, id } = request.params;
      const access = await requireAccess(domain, request, key);
      return domain.messages.markRead(key, id, access.handle, await domain.members.humanHandles(key));
    },
  );

  /** Opening a conversation marks its unread incoming messages read in one request (PM-78). */
  app.post<ProjectParams>(routes.readTeamMessages(':key'), async (request): Promise<TeamMessagesView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key);
    const body = parseBody(ReadTeamMessagesRequest, request.body);
    const messages = domain.messages.markReadMany(
      key,
      body.ids,
      access.handle,
      await domain.members.humanHandles(key),
    );
    return { messages, unreadCount: domain.messages.countUnread(key, access.handle) };
  });

  /** The viewer's conversations with the other members: each one's latest message and unread count (PM-78). */
  app.get<ProjectParams>(routes.teamThreads(':key'), async (request): Promise<TeamThreadsView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key);
    return {
      threads: domain.messages.threads(key, access.handle),
      unreadCount: domain.messages.countUnread(key, access.handle),
    };
  });

  app.get<ProjectParams>(routes.teamMessages(':key'), async (request): Promise<TeamMessagesView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key);
    const query = parseBody(MessagesQuery, request.query);
    // A card the viewer may not see has no thread for them (the POST refuses it the same way); an
    // unknown key stays an empty list, which the free-text "all messages" filter relies on.
    const task = query.taskKey ? domain.tasks.find(key, query.taskKey) : null;
    if (task && !canSeeTask(access, task)) throw notFound('task', query.taskKey!);
    return {
      messages: domain.messages.list(key, {
        taskKey: query.taskKey,
        member: query.member,
        participant: teamMessageParticipant(access),
        between: query.threadWith ? [access.handle, query.threadWith] : undefined,
        limit: query.limit,
        unreadFor: query.unreadOnly === 'true' ? access.handle : undefined,
      }),
      unreadCount: domain.messages.countUnread(key, access.handle),
    };
  });
}
