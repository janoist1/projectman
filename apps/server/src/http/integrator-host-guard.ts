import type { FastifyInstance } from 'fastify';
import { apiError } from './errors';
import { hostnameOf } from './feedback-host-guard';

/** The explicit machine hostname; an invalid value stops startup. No URL, port or wildcard. */
export function parseIntegratorHostname(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value))
    throw new Error('invalid PROJECTMAN_INTEGRATOR_HOSTNAME: expected a hostname without a port or path');
  return value;
}

/**
 * Runs before cookies and authentication. The tunnel proves Access's audience; this second lock
 * keeps a machine credential off the human board, including during the private staging deploy.
 */
export function registerIntegratorHostGuard(
  app: FastifyInstance,
  options: { integratorHostname?: string; publicBoard: boolean },
): void {
  const hostname = options.integratorHostname
    ? parseIntegratorHostname(options.integratorHostname)
    : undefined;
  if (!hostname && !options.publicBoard) return;
  app.addHook('onRequest', async (request, reply) => {
    const path = (request.raw.url ?? '').split('?')[0]!;
    const route = request.routeOptions.url;
    const machine = hostname !== undefined && hostnameOf(request.headers.host) === hostname;
    const bearer = /^Bearer(?:\s|$)/i.test(request.headers.authorization ?? '');
    const notFound = () => {
      reply.header('cache-control', 'no-store');
      reply.header('x-content-type-options', 'nosniff');
      if (request.headers.upgrade !== undefined) reply.raw.once('finish', () => request.raw.socket.end());
      return reply.code(404).send(apiError('not_found', 'route not found'));
    };
    if (machine) {
      reply.header('cache-control', 'no-store');
      reply.header('x-content-type-options', 'nosniff');
      const api = path.startsWith('/api/') && route?.startsWith('/api/');
      const mcp = path === '/mcp' && route === '/mcp';
      if ((!api && !mcp) || /(?:\\|\/\/|\/(?:\.|\.\.)(?:\/|$))/.test(path)) return notFound();
      if (!bearer)
        return reply
          .code(401)
          .send(apiError('integrator_key_invalid', 'Integrator key is required on the machine host'));
      return;
    }
    if (path === '/mcp' || route === '/mcp') return notFound();
    if (bearer && (path.startsWith('/api/') || route?.startsWith('/api/')))
      return reply
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .code(403)
        .send(apiError('integrator_host_required', 'Integrator keys require the machine host'));
  });
}
