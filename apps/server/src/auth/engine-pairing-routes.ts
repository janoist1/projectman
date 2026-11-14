import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PairingCodeRequest, routes, StartEnginePairingRequest } from '@projectman/shared';
import { apiError, parseBody } from '../http';
import { clientAddress, DomainError, forbidden, isLocalRequest, requestProtocol } from '../kernel';
import type { EnginePairingService, PairingApprover } from './engine-pairing';

/**
 * The device pairing's doors (PM-1437), registered only in cloud mode. The machine's (`/engine/pairings`) have no
 * login, the access layer's engine audience guards them; the web's (`/api/pairings/*`) need the approver's own login.
 */
export function registerEnginePairingRoutes(
  app: FastifyInstance,
  deps: { pairing: EnginePairingService; clientIpHeader?: string },
): void {
  const { pairing, clientIpHeader } = deps;
  const notFound = (reply: FastifyReply) => reply.code(404).send(apiError('not_found', 'route not found'));
  const withRetryAfter = (error: unknown, reply: FastifyReply): never => {
    if (error instanceof DomainError && error.code === 'too_many_attempts') {
      const seconds = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (seconds) reply.header('retry-after', String(seconds));
    }
    throw error;
  };

  app.post(routes.enginePairings(), async (request, reply) => {
    if (!(isLocalRequest(request) || requestProtocol(request) === 'https'))
      throw new DomainError('unauthorized', 'Engine pairing requires HTTPS', { status: 401 });
    const body = parseBody(StartEnginePairingRequest, request.body);
    try {
      return reply.code(201).send(pairing.start(body, clientAddress(request, clientIpHeader)));
    } catch (err) {
      return withRetryAfter(err, reply);
    }
  });
  // The machine polls every few seconds: its requests log at warn only.
  app.get<{ Params: { id: string } }>(
    routes.enginePairing(':id'),
    { logLevel: 'warn' },
    async (request, reply) => {
      const status = pairing.poll(request.params.id, request.headers.authorization);
      return status ? status : notFound(reply);
    },
  );
  app.delete<{ Params: { id: string } }>(routes.enginePairing(':id'), async (request, reply) =>
    pairing.cancel(request.params.id, request.headers.authorization)
      ? reply.code(204).send()
      : notFound(reply),
  );

  /** The approver: their own login only, never an integrator key. */
  const approver = (request: FastifyRequest): PairingApprover => {
    if (request.via || request.principal)
      throw forbidden('integrator_not_allowed', 'a device pairing is approved with the own login only');
    if (!request.user) throw new DomainError('unauthorized', 'login required', { status: 401 });
    return { userId: request.user.id, address: clientAddress(request, clientIpHeader) };
  };
  const web = (
    url: string,
    action: (by: PairingApprover, code: string) => ReturnType<EnginePairingService['lookup']>,
  ) =>
    app.post(url, async (request, reply) => {
      const by = approver(request);
      const { code } = parseBody(PairingCodeRequest, request.body);
      try {
        return action(by, code);
      } catch (err) {
        return withRetryAfter(err, reply);
      }
    });
  web(routes.pairingLookup(), (by, code) => pairing.lookup(by, code));
  web(routes.pairingApprove(), (by, code) => pairing.approve(by, code));
  web(routes.pairingDeny(), (by, code) => pairing.deny(by, code));
}
