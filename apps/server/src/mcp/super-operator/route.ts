import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ExternalMcpBackend } from '../../contracts';
import {
  MAX_BODY_BYTES,
  sendJsonRpcError,
  sendTransportResponse,
  toWebRequest,
  useRawJsonBody,
} from '../http';
import { createExternalMcpServer, type ExternalCallState } from './server';

export interface ExternalRouteDeps {
  backend: ExternalMcpBackend;
  logger: FastifyBaseLogger;
  toolTimeoutMs: number;
}

/** The credential never goes on to the SDK as request info, and a cookie is not a credential here. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie'];

const UNAUTHORIZED = {
  error: { code: 'integrator_key_invalid', message: 'Integrator key is invalid, revoked or expired' },
};

/**
 * The bearer endpoint `POST /mcp` of the integrator (PM-760). The app's auth hook has already accepted a `pmi_`
 * bearer (HTTPS or local only) and set `request.principal`; this route serves nothing without it, so a cookie, a
 * member token or no credential gets a 401, never a tool.
 *
 * It is stateless in the strict sense: no MCP session id, no server-to-client stream, and every HTTP request is
 * authenticated afresh (the hook resolved the key just now; the handler re-checks it for each tool call, so a
 * revoke or an expiry between two requests, or two batched calls, takes effect at once).
 */
export function registerExternalRoutes(app: FastifyInstance, deps: ExternalRouteDeps): void {
  const unauthorized = (reply: FastifyReply) => reply.code(401).send(UNAUTHORIZED);

  async function requirePrincipal(request: FastifyRequest, reply: FastifyReply) {
    if (!request.principal) return unauthorized(reply);
  }

  async function handlePost(request: FastifyRequest, reply: FastifyReply) {
    const principal = request.principal;
    if (!principal) return unauthorized(reply);
    const state: ExternalCallState = { unauthorized: false };
    const server = createExternalMcpServer({ principal, requestId: request.id }, state, deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(toWebRequest(request, CREDENTIAL_HEADERS));
      // A key found revoked or expired while the call ran is an authentication failure of the request.
      if (state.unauthorized) return unauthorized(reply);
      return await sendTransportResponse(reply, response);
    } finally {
      await server.close();
    }
  }

  async function handleNotAllowed(_request: FastifyRequest, reply: FastifyReply) {
    reply.header('allow', 'POST');
    return sendJsonRpcError(
      reply,
      405,
      'Method not allowed: this MCP endpoint is stateless and only accepts POST.',
    );
  }

  app.register(async (scope) => {
    useRawJsonBody(scope);
    scope.addHook('onRequest', requirePrincipal);
    const route = { url: '/mcp', bodyLimit: MAX_BODY_BYTES } as const;
    scope.route({ ...route, method: 'POST', handler: handlePost });
    scope.route({ ...route, method: ['GET', 'DELETE'], handler: handleNotAllowed });
  });
}
