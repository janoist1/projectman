import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CreateFeedbackMarkRequest,
  FeedbackCommentRequest,
  FeedbackSessionRequest,
  routes,
} from '@projectman/shared';
import type {
  FeedbackMarkDetail,
  FeedbackSessionResponse,
  FeedbackWidgetListResponse,
} from '@projectman/shared';
import { clientAddress, createAttemptLimiter } from '../auth';
import type { Domain, FeedbackWidgetSession } from '../domain';
import { DomainError } from '../domain';
import { markIdOf } from './feedback';
import { apiError, toApiError } from './errors';
import { parseBody } from './validation';

declare module 'fastify' {
  interface FastifyRequest {
    /** The tool session of a widget API request (set by that API's guard), or null. */
    feedbackSession: FeedbackWidgetSession | null;
  }
}

/** The body of `POST /marks` carries a screenshot; every other request of the API is small. */
const MARK_BODY_LIMIT = 3 * 1024 * 1024;
const SMALL_BODY_LIMIT = 64 * 1024;

/** Wrong codes per client address and window. */
const MAX_FAILED_CODES = 10;
const FAILED_CODE_WINDOW_MS = 15 * 60 * 1000;

const ListQuery = z.object({
  since: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
});

type MarkParams = { Params: { markId: string } };

const bearerOf = (request: FastifyRequest): string =>
  /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? '';

/**
 * The public widget API of the feedback tool (PM-506, PM-509): the script the customer's page embeds,
 * and `/feedback/api/v1`, which that script calls across origins. It is not under `/api`, whose guard
 * would refuse the cross-origin writes and take every bearer for an integrator key. Instead it guards
 * itself, in an `onRequest` hook, so that a request that is not allowed is refused before its body
 * (up to 3 MiB for a mark) is read:
 *
 * 1. the `Origin` must be the address of some project's surface (403 `feedback_origin_not_allowed`,
 *    with no CORS header, so the browser shows the page nothing); credentials are never allowed;
 * 2. a preflight is answered here;
 * 3. every request but the code exchange carries a bearer session that is checked on the spot
 *    (401 `feedback_session_invalid`).
 *
 * Nothing here is cached by a browser or a proxy.
 */
export function registerFeedbackWidgetRoutes(
  app: FastifyInstance,
  deps: { domain: Domain; clientIpHeader?: string; widgetFile: string | null },
): void {
  const { domain, clientIpHeader, widgetFile } = deps;
  const widget = domain.feedbackWidget;
  const failedCodes = createAttemptLimiter({
    max: MAX_FAILED_CODES,
    windowMs: FAILED_CODE_WINDOW_MS,
    message: 'too many wrong codes; try again later',
  });

  app.get(routes.feedbackWidgetScript(), async (_request, reply) => {
    const size = widgetFile
      ? await stat(widgetFile).then(
          (s) => (s.isFile() ? s.size : null),
          () => null,
        )
      : null;
    if (!widgetFile || size === null) return reply.code(404).send(apiError('not_found', 'route not found'));
    reply
      .header('content-type', 'text/javascript; charset=utf-8')
      .header('content-length', size)
      .header('cache-control', 'public, max-age=300')
      .header('cross-origin-resource-policy', 'cross-origin');
    return reply.send(createReadStream(widgetFile));
  });

  void app.register(
    async (scope) => {
      scope.decorateRequest('feedbackSession', null);

      scope.setErrorHandler((error, request, reply) => {
        const { status, body } = toApiError(error);
        if (status >= 500) request.log.error({ err: error }, 'request failed');
        if (error instanceof DomainError && error.code === 'feedback_rate_limited') {
          const seconds = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
          if (seconds) reply.header('retry-after', seconds);
        }
        return reply.code(status).send(body);
      });
      scope.setNotFoundHandler((_request, reply) =>
        reply.code(404).send(apiError('not_found', 'route not found')),
      );

      scope.addHook('onRequest', async (request, reply) => {
        reply.header('cache-control', 'no-store').header('vary', 'Origin');
        const origin = request.headers.origin;
        if (typeof origin !== 'string' || !(await widget.originAllowed(origin)))
          return reply
            .code(403)
            .send(apiError('feedback_origin_not_allowed', 'this address may not use the tool'));
        // Never `access-control-allow-credentials`: the session is a bearer in a header, not a cookie.
        reply
          .header('access-control-allow-origin', origin)
          .header('access-control-expose-headers', 'retry-after');
        if (request.method === 'OPTIONS')
          return reply
            .code(204)
            .header('access-control-allow-methods', 'GET, POST, DELETE')
            .header('access-control-allow-headers', 'authorization, content-type')
            .header('access-control-max-age', '600')
            .send();
        // The code exchange is the one request that has no session yet.
        if (
          request.method === 'POST' &&
          request.routeOptions.url === `${routes.feedbackWidgetApi('/sessions')}`
        )
          return;
        request.feedbackSession = await widget.authenticate(bearerOf(request), origin);
      });

      const sessionOf = (request: FastifyRequest): FeedbackWidgetSession => request.feedbackSession!;

      scope.options('/*', async (_request, reply) => reply.code(204).send());

      scope.post('/sessions', { bodyLimit: SMALL_BODY_LIMIT }, async (request, reply) => {
        // Reserved first and given back only on success: every refusal counts against the address.
        const release = failedCodes.reserve(clientAddress(request, clientIpHeader));
        const parsed = FeedbackSessionRequest.safeParse(request.body);
        const userAgent = request.headers['user-agent'];
        const session = await widget.exchange({
          code: parsed.success ? parsed.data.code : '',
          origin: request.headers.origin!,
          userAgent: typeof userAgent === 'string' ? userAgent : null,
        });
        release();
        return reply.code(201).send(session satisfies FeedbackSessionResponse);
      });

      scope.delete('/sessions/current', async (request, reply) => {
        widget.endSession(sessionOf(request));
        return reply.code(204).send();
      });

      scope.get('/marks', async (request): Promise<FeedbackWidgetListResponse> => {
        const { since } = parseBody(ListQuery, request.query);
        return widget.list(sessionOf(request), since ?? null);
      });

      scope.post('/marks', { bodyLimit: MARK_BODY_LIMIT }, async (request, reply) => {
        const body = parseBody(CreateFeedbackMarkRequest, request.body);
        const mark = await widget.createMark(sessionOf(request), body);
        return reply.code(201).send(mark satisfies FeedbackMarkDetail);
      });

      scope.get<MarkParams>('/marks/:markId', async (request): Promise<FeedbackMarkDetail> =>
        widget.detail(sessionOf(request), markIdOf(request.params.markId)),
      );

      scope.post<MarkParams>(
        '/marks/:markId/comments',
        { bodyLimit: SMALL_BODY_LIMIT },
        async (request, reply) => {
          const body = parseBody(FeedbackCommentRequest, request.body);
          const mark = await widget.comment(sessionOf(request), markIdOf(request.params.markId), body.body);
          return reply.code(201).send(mark satisfies FeedbackMarkDetail);
        },
      );

      scope.post<MarkParams>(
        '/marks/:markId/read',
        { bodyLimit: SMALL_BODY_LIMIT },
        async (request, reply) => {
          await widget.markRead(sessionOf(request), markIdOf(request.params.markId));
          return reply.code(204).send();
        },
      );
    },
    { prefix: routes.feedbackWidgetApi() },
  );
}
