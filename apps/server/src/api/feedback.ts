import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CloseFeedbackRequest,
  CreateTaskFromFeedbackRequest,
  FeedbackCommentRequest,
  FeedbackLaunchRequest,
  FeedbackMarkId,
  LinkFeedbackRequest,
  routes,
  TaskKey,
} from '@projectman/shared';
import type {
  CreateTaskFromFeedbackResponse,
  FeedbackInboxResponse,
  FeedbackLaunchResponse,
  FeedbackMarkDetail,
  FeedbackSettingsView,
  FeedbackSummary,
} from '@projectman/shared';
import type { ApiDomain } from './ports';
import { DomainError, invalid } from '../kernel';
import { actorOf, requireAccess } from './context';
import { parseBody } from '../http';

type MarkParams = { Params: { key: string; markId: string } };
type ProjectParams = { Params: { key: string } };

const ListQuery = z.object({ task: TaskKey.optional() });
const ScreenshotQuery = z.object({ thumb: z.enum(['0', '1']).optional() });
const HandleParam = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

// The same policy as the attachment responses: nothing loads, no script runs.
const CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox; frame-ancestors 'none'";

export function markIdOf(raw: string): string {
  const parsed = FeedbackMarkId.safeParse(raw);
  if (!parsed.success)
    throw new DomainError('feedback_mark_not_found', `mark not found: ${raw}`, { status: 404 });
  return parsed.data;
}

/**
 * The feedback marks of a project over REST, for the app (PM-506): the login's cookie, at least
 * viewer access. The service decides what each member may do and see; a client never learns the key
 * or the title of an internal card from any of these.
 */
export function registerFeedbackRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.get<ProjectParams>(routes.feedback(':key'), async (request): Promise<FeedbackInboxResponse> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'viewer' });
    const { task } = parseBody(ListQuery, request.query);
    return domain.feedback.list(key, actorOf(access), task ? { taskKey: task } : {});
  });

  app.get<ProjectParams>(routes.feedbackSummary(':key'), async (request): Promise<FeedbackSummary> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'viewer' });
    return domain.feedback.summary(key, actorOf(access));
  });

  app.get<ProjectParams>(routes.feedbackSettings(':key'), async (request): Promise<FeedbackSettingsView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    return domain.feedback.settings(key, actorOf(access));
  });

  app.post<ProjectParams>(routes.feedbackLaunch(':key'), async (request, reply) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'viewer' });
    const body = parseBody(FeedbackLaunchRequest, request.body);
    // The code is good for the app that asked: the page it was asked from.
    const appOrigin = request.headers.origin;
    if (!appOrigin) throw invalid('invalid_request', 'the launch needs the Origin of the app');
    const launched = await domain.feedback.launch(key, actorOf(access), body, appOrigin);
    return reply.code(201).send(launched satisfies FeedbackLaunchResponse);
  });

  app.post<{ Params: { key: string; handle: string } }>(
    routes.feedbackMarkerLogout(':key', ':handle'),
    async (request, reply) => {
      const key = request.params.key;
      const access = await requireAccess(domain, request, key, { minimum: 'admin' });
      const handle = HandleParam.safeParse(request.params.handle);
      if (!handle.success) throw invalid('invalid_request', 'not a member handle');
      await domain.feedback.logoutMarker(key, actorOf(access), handle.data);
      return reply.code(204).send();
    },
  );

  app.get<MarkParams>(
    routes.feedbackMark(':key', ':markId'),
    async (request): Promise<FeedbackMarkDetail> => {
      const { key, markId } = request.params;
      const access = await requireAccess(domain, request, key, { minimum: 'viewer' });
      return domain.feedback.detail(key, markIdOf(markId), actorOf(access));
    },
  );

  app.get<MarkParams>(routes.feedbackScreenshot(':key', ':markId'), async (request, reply) => {
    const { key, markId } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'viewer' });
    const { thumb } = parseBody(ScreenshotQuery, request.query);
    const { stream, size, mediaType } = await domain.feedback.openScreenshot(
      key,
      markIdOf(markId),
      actorOf(access),
      thumb === '1',
    );
    reply
      .header('content-type', mediaType)
      .header('content-length', size)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', CONTENT_SECURITY_POLICY)
      .header('cross-origin-resource-policy', 'same-origin')
      .header('cache-control', 'private, no-store');
    if (request.method === 'HEAD') {
      stream.destroy();
      return reply.send(Readable.from([]));
    }
    return reply.send(stream);
  });

  app.post<MarkParams>(routes.feedbackComments(':key', ':markId'), async (request, reply) => {
    const { key, markId } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'viewer' });
    const body = parseBody(FeedbackCommentRequest, request.body);
    const detail = await domain.feedback.comment(key, markIdOf(markId), actorOf(access), body.body);
    return reply.code(201).send(detail satisfies FeedbackMarkDetail);
  });

  app.post<MarkParams>(routes.feedbackRead(':key', ':markId'), async (request, reply) => {
    const { key, markId } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'viewer' });
    await domain.feedback.markRead(key, markIdOf(markId), actorOf(access));
    return reply.code(204).send();
  });

  app.post<MarkParams>(routes.feedbackTask(':key', ':markId'), async (request, reply) => {
    const { key, markId } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'viewer' });
    const body = parseBody(CreateTaskFromFeedbackRequest, request.body);
    const created = await domain.feedback.createTask(key, markIdOf(markId), actorOf(access), body);
    return reply.code(201).send(created satisfies CreateTaskFromFeedbackResponse);
  });

  app.post<MarkParams>(
    routes.feedbackLink(':key', ':markId'),
    async (request): Promise<FeedbackMarkDetail> => {
      const { key, markId } = request.params;
      const access = await requireAccess(domain, request, key, { minimum: 'viewer' });
      const body = parseBody(LinkFeedbackRequest, request.body);
      return domain.feedback.link(key, markIdOf(markId), actorOf(access), body);
    },
  );

  app.post<MarkParams>(
    routes.feedbackClose(':key', ':markId'),
    async (request): Promise<FeedbackMarkDetail> => {
      const { key, markId } = request.params;
      const access = await requireAccess(domain, request, key, { minimum: 'viewer' });
      const body = parseBody(CloseFeedbackRequest, request.body ?? {});
      return domain.feedback.close(key, markIdOf(markId), actorOf(access), body.reply);
    },
  );

  app.post<MarkParams>(
    routes.feedbackReopen(':key', ':markId'),
    async (request): Promise<FeedbackMarkDetail> => {
      const { key, markId } = request.params;
      const access = await requireAccess(domain, request, key, { minimum: 'viewer' });
      return domain.feedback.reopen(key, markIdOf(markId), actorOf(access));
    },
  );
}
