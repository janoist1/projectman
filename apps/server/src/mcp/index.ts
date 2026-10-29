import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { McpModule, McpModuleOptions, ToolContext } from '../contracts';
import { nonLocalReason } from '../kernel';
import {
  MAX_BODY_BYTES,
  sendJsonRpcError,
  sendTransportResponse,
  toWebRequest,
  useRawJsonBody,
} from './http';
import { createTeamMcpServer, DEFAULT_TOOL_TIMEOUT_MS, type TeamServerDeps } from './server';
import { registerExternalRoutes } from './super-operator/route';

export { FeedbackTools } from './feedback';
export { OperatorTools } from './operator';
export { MemberTools } from './members';
export { TaskTools } from './tasks';
export { AttachmentTools } from './attachments';
export { MergeTools } from './merges';
export { ReleaseTools } from './releases';
export { ToolCaller } from './caller';
export { GithubTools } from './github';
export { ScreenshotTools } from './full-tests';
export { ProjectDocTools } from './project-docs';
export { SystemFeedbackTools } from './system-feedback';
export { HistoryTools } from './history';
export { TeamToolsService } from './team-tools';
export { InboxTools } from './inbox';
export { MessageTools } from './messages';
export { AdmissionTools } from './admission';
export { WatcherTools } from './watchers';
export { SessionTools } from './sessions';
export { EmailChannelTools } from './email-channel';
export { HostRequestTools } from './host-requests';
export { ExternalTools } from './super-operator/handler';

export { TEAM_TOOLS, TEAM_TOOL_NAMES, toolOutputText } from './tools';
export { visibleTeamTools } from './server';

/**
 * Team tools MCP endpoint (`/mcp/:token`) for AI members' Claude Code sessions.
 *
 * Streamable HTTP in stateless mode: every POST gets a fresh MCP server and transport,
 * bound to the session that owns the token, and is answered with plain JSON (no SSE).
 * GET (server-to-client stream) and DELETE (session end) are answered with 405, which
 * the spec allows and Claude Code's MCP client handles. See README.md.
 */

interface CreateMcpModuleOptions extends McpModuleOptions {
  /** A tool call is answered with a `timeout` error after this long. Default `TEAM_TOOL_TIMEOUT_MS`. */
  toolTimeoutMs?: number;
}

export function createMcpModule(opts: CreateMcpModuleOptions): McpModule {
  const logger = opts.logger.child({ module: 'mcp' });
  const deps: TeamServerDeps = {
    audienceOf: opts.audienceOf,
    handler: opts.handler,
    logger,
    toolTimeoutMs: opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
  };
  const external = opts.external
    ? { backend: opts.external, logger, toolTimeoutMs: deps.toolTimeoutMs }
    : undefined;
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
    const live = opts.resolveContext((request.params as { token: string }).token);
    if (!ctx || !live || live.sessionId !== ctx.sessionId)
      return sendJsonRpcError(reply, 404, 'Unknown or expired team session.');
    const server = createTeamMcpServer(ctx, deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await sendTransportResponse(reply, await transport.handleRequest(toWebRequest(request)));
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
        useRawJsonBody(scope);
        scope.addHook('onRequest', guard);
        // Request logs would contain the token (it is part of the URL): keep them out of the info log.
        const route = { url: '/mcp/:token', logLevel: 'warn', bodyLimit: MAX_BODY_BYTES } as const;
        scope.route({ ...route, method: 'POST', handler: handlePost });
        scope.route({ ...route, method: ['GET', 'DELETE'], handler: handleNotAllowed });
      });
      if (external) registerExternalRoutes(app, external);
    },
  };
}
