import type { FastifyRequest } from 'fastify';

/** Invitation tokens also travel in SPA URLs and login return targets. Never write them to request logs. */
export function serializeRequest(request: FastifyRequest) {
  const url = request.url
    .split('?')[0]!
    .replace(
      /^(\/api\/invites\/|\/invite\/|\/api\/owner-invites\/|\/owner-invite\/|\/hooks\/|\/mcp\/)[^/]+/i,
      '$1[redacted]',
    );
  return {
    method: request.method,
    url,
    version:
      typeof request.headers['accept-version'] === 'string' ? request.headers['accept-version'] : undefined,
    hostname: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}
