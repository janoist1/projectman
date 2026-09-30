import type { FastifyInstance } from 'fastify';
import type { ApiError, ErrorCode } from '@projectman/shared';
import { DomainError } from '../domain/errors';

export function apiError(code: ErrorCode, message: string, details?: unknown): ApiError {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

const FASTIFY_CODES: Record<string, ErrorCode> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'invalid_request',
  FST_ERR_CTP_INVALID_JSON_BODY: 'invalid_json',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'invalid_request',
};

/**
 * Maps any thrown error to an HTTP status and the shared ApiError body. Modules raise
 * DomainError for the client (configuration store errors are translated by ProjectService).
 */
export function toApiError(error: unknown): { status: number; body: ApiError } {
  if (error instanceof DomainError) {
    return { status: error.status, body: apiError(error.code, error.message, error.details) };
  }
  const e = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    const known = typeof e.code === 'string' ? FASTIFY_CODES[e.code] : undefined;
    const code =
      known ??
      (e.statusCode === 404 ? 'not_found' : e.statusCode === 429 ? 'too_many_requests' : 'bad_request');
    return {
      status: e.statusCode,
      body: apiError(code, 'request rejected'),
    };
  }
  return { status: 500, body: apiError('internal_error', 'internal server error') };
}

const SERVER_PREFIXES = ['/api', '/ws', '/hooks', '/mcp'];

/**
 * Consistent ApiError responses for every error and unknown route. With `spaIndex`,
 * unknown GET paths outside the server prefixes return the web app's index.html.
 */
export function registerErrorHandling(app: FastifyInstance, opts: { spaIndex: boolean }): void {
  app.setErrorHandler((error, request, reply) => {
    const { status, body } = toApiError(error);
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    return reply.code(status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const serverRoute = SERVER_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
    if (opts.spaIndex && !serverRoute && (request.method === 'GET' || request.method === 'HEAD')) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send(apiError('not_found', 'route not found'));
  });
}
