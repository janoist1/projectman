import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  canSeeOperatorSessions,
  MemberHandle,
  ReadTeamMessagesRequest,
  routes,
  SESSION_CHAT_WINDOW,
  SESSION_CHAT_WINDOW_MAX,
  SendMessageRequest,
  SendTeamMessageRequest,
  TaskKey,
  UpdateSessionRequest,
  StopSessionRequest,
} from '@projectman/shared';
import type { Session, SessionDetail, TeamMessagesView, TeamThreadsView } from '@projectman/shared';
import { notFound } from '../kernel';
import type { ApiDomain } from './ports';
import { teamMessageParticipant, visibleSession } from '../core/projects';
import type { Viewer } from '../core/projects';
import { actorOf, requireAccess, senderOf } from './context';
import { parseBody } from '../http';

type ProjectParams = { Params: { key: string } };
type SessionParams = { Params: { key: string; sessionId: string } };

const ChatWindowQuery = z.object({
  limit: z.coerce.number().int().min(1).max(SESSION_CHAT_WINDOW_MAX).optional(),
  before: z.string().min(1).optional(),
});

const MessagesQuery = z.object({
  taskKey: TaskKey.optional(),
  member: MemberHandle.optional(),
  threadWith: MemberHandle.optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * The Operator's sessions and the PM's conversations with others are for the owner and the admin only
 * (PM-475, PM-1080): to anyone else they do not exist.
 */
function assertMaySeeSession(domain: ApiDomain, viewer: Viewer, sessionId: string): void {
  if (!canSeeOperatorSessions(viewer) && domain.sessions.isRestrictedSession(sessionId))
    throw notFound('session', sessionId);
}

export function registerSessionRoutes(app: FastifyInstance, domain: ApiDomain): void {
  /** Session with its chat, parsed from the Claude Code transcript. */
  app.get<SessionParams>(routes.session(':key', ':sessionId'), async (request): Promise<SessionDetail> => {
    const { key, sessionId } = request.params;
    const access = await requireAccess(domain, request, key);
    assertMaySeeSession(domain, access, sessionId);
    const { limit, before } = parseBody(ChatWindowQuery, request.query);
    const detail = await domain.sessions.detail(key, sessionId, {
      limit: limit ?? SESSION_CHAT_WINDOW,
      ...(before === undefined ? {} : { before }),
    });
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
    const message = await domain.sessionMessages.sendToSession(
      key,
      sessionId,
      body.text,
      senderOf(access),
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
    // Who a read-only or contact-restricted member may write to is the messaging service's rule (PM-475, PM-985).
    const access = await requireAccess(domain, request, key);
    const body = parseBody(SendTeamMessageRequest, request.body);
    // `attachmentIds` ride along in `body`: the messaging service checks and binds them.
    if (body.taskKey) domain.tasks.get(key, body.taskKey);
    return reply.code(202).send(
      await domain.messaging.send(key, senderOf(access), body, {
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
    return domain.messages.threads(key, access.handle);
  });

  app.get<ProjectParams>(routes.teamMessages(':key'), async (request): Promise<TeamMessagesView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key);
    const query = parseBody(MessagesQuery, request.query);
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
