import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { McpModule, McpModuleOptions, ToolContext } from '../contracts';
import { nonLocalReason } from './guard';
import { createTeamMcpServer, DEFAULT_TOOL_TIMEOUT_MS, type TeamServerDeps } from './server';

export { TEAM_TOOL_NAMES, type TeamToolName } from './tools';

/**
 * Team tools MCP endpoint (`/mcp/:token`) for AI members' Claude Code sessions.
 *
 * Streamable HTTP in stateless mode: every POST gets a fresh MCP server and transport,
 * bound to the session that owns the token, and is answered with plain JSON (no SSE).
 * GET (server-to-client stream) and DELETE (session end) are answered with 405, which
 * the spec allows and Claude Code's MCP client handles. See README.md.
 */

export interface CreateMcpModuleOptions extends McpModuleOptions {
  /** A tool call is answered with a `timeout` error after this long. Default 60 s. */
  toolTimeoutMs?: number;
}

/** Tool calls are small; anything bigger is refused before it is parsed. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Request headers that are not copied to the web Request handed to the SDK transport. */
const SKIPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'expect',
  'te',
  'trailer',
]);

export function createMcpModule(opts: CreateMcpModuleOptions): McpModule {
  const logger = opts.logger.child({ module: 'mcp' });
  const deps: TeamServerDeps = {
    handler: opts.handler,
    logger,
    toolTimeoutMs: opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
  };
  /** Context resolved by the guard, read by the route handler. */
  const contexts = new WeakMap<FastifyRequest, ToolContext>();

  /** Runs before the body is read: local callers only, and a token that names a live session. */
  async function guard(request: FastifyRequest, reply: FastifyReply) {
    const remoteAddress = request.socket.remoteAddress;
    const reason = nonLocalReason({ remoteAddress, headers: request.headers });
    if (reason) {
      logger.warn({ remoteAddress, reason }, 'rejected a non-local MCP request');
      return sendJsonRpcError(reply, 403, 'Forbidden: the team MCP endpoint only accepts local connections.');
    }
    const { token } = request.params as { token: string };
    const ctx = opts.resolveContext(token);
    if (!ctx) {
      // 404 rather than 401: a 401 makes MCP clients (Claude Code included) start an OAuth flow.
      logger.warn('rejected an MCP request with an unknown token');
      return sendJsonRpcError(reply, 404, 'Unknown or expired team session.');
    }
    contexts.set(request, ctx);
  }

  async function handlePost(request: FastifyRequest, reply: FastifyReply) {
    const ctx = contexts.get(request);
    if (!ctx) return sendJsonRpcError(reply, 404, 'Unknown or expired team session.');
    const server = createTeamMcpServer(ctx, deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(toWebRequest(request));
      reply.code(response.status);
      response.headers.forEach((value, name) => {
        if (name !== 'content-length') reply.header(name, value);
      });
      return reply.send(response.body ? await response.text() : undefined);
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

  return {
    registerRoutes(app: FastifyInstance) {
      // Encapsulated so that the body parser and the guard apply to these routes only.
      app.register(async (scope) => {
        // The raw JSON text goes to the SDK transport (which parses and validates JSON-RPC),
        // whatever body parsing the application configures for its other routes.
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser(
          'application/json',
          { parseAs: 'string', bodyLimit: MAX_BODY_BYTES },
          (_request, body, done) => done(null, body),
        );
        scope.addHook('onRequest', guard);
        // Request logs would contain the token (it is part of the URL): keep them out of the info log.
        const route = { url: '/mcp/:token', logLevel: 'warn', bodyLimit: MAX_BODY_BYTES } as const;
        scope.route({ ...route, method: 'POST', handler: handlePost });
        scope.route({ ...route, method: ['GET', 'DELETE'], handler: handleNotAllowed });
      });
    },
  };
}

/** Converts the Fastify request into the web Request the SDK transport works with. */
function toWebRequest(request: FastifyRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || SKIPPED_HEADERS.has(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  // The token is left out of the URL: the transport only passes it on as request info.
  return new Request('http://localhost/mcp', {
    method: request.method,
    headers,
    body: typeof request.body === 'string' ? request.body : null,
  });
}

function sendJsonRpcError(reply: FastifyReply, status: number, message: string) {
  return reply
    .code(status)
    .type('application/json')
    .send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}
