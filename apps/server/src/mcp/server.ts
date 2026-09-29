import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { FastifyBaseLogger } from 'fastify';
import { TeamToolError, type TeamToolsHandler, type ToolContext } from '../contracts';
import { TEAM_INSTRUCTIONS, TEAM_TOOLS, type TeamTool } from './tools';

export const SERVER_INFO = { name: 'projectman-team', version: '1.0.0' } as const;

/**
 * A handler that has not answered after this long gets a `timeout` tool error, so a hung
 * call cannot leave the Claude session waiting forever (Claude Code's own MCP tool timeout
 * is practically unlimited). The handler keeps running; a late outcome is only logged.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export interface TeamServerDeps {
  handler: TeamToolsHandler;
  logger: FastifyBaseLogger;
  toolTimeoutMs: number;
}

/** Error codes seen by the model: the TeamToolError codes plus our own. */
export type ToolErrorCode = TeamToolError['code'] | 'timeout' | 'internal';

class ToolTimeoutError extends Error {
  constructor(ms: number) {
    super(`team tool timed out after ${ms} ms`);
    this.name = 'ToolTimeoutError';
  }
}

// Only used for elicitation, which the team server never does; shared so that the
// per-request servers do not each build their own validator.
const jsonSchemaValidator = new AjvJsonSchemaValidator();

/**
 * Builds an MCP server bound to one calling session. The endpoint is stateless: a fresh
 * server is created for every HTTP request, with the context resolved from its token.
 */
export function createTeamMcpServer(ctx: ToolContext, deps: TeamServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: TEAM_INSTRUCTIONS, jsonSchemaValidator });
  for (const tool of TEAM_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args) => runTool(tool, ctx, args, deps),
    );
  }
  server.server.onerror = (err) => deps.logger.debug({ err }, 'MCP protocol error');
  return server;
}

export function toolError(code: ToolErrorCode, message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error [${code}]: ${message}` }], isError: true };
}

async function runTool(
  tool: TeamTool,
  ctx: ToolContext,
  args: Record<string, unknown>,
  deps: TeamServerDeps,
): Promise<CallToolResult> {
  const log = { tool: tool.name, sessionId: ctx.sessionId, member: ctx.member, projectKey: ctx.projectKey };
  const startedAt = Date.now();
  const call = tool.run({ ctx, args, handler: deps.handler });
  try {
    const text = await withTimeout(call, deps.toolTimeoutMs);
    deps.logger.debug({ ...log, ms: Date.now() - startedAt }, 'team tool call');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (err instanceof TeamToolError) {
      deps.logger.debug({ ...log, code: err.code, detail: err.message }, 'team tool refused');
      return toolError(err.code, err.message);
    }
    if (err instanceof ToolTimeoutError) {
      deps.logger.warn({ ...log, ms: deps.toolTimeoutMs }, 'team tool timed out');
      call.then(
        () => deps.logger.warn(log, 'team tool finished after its timeout'),
        (lateErr: unknown) =>
          deps.logger.error({ ...log, err: lateErr }, 'team tool failed after its timeout'),
      );
      const limit =
        deps.toolTimeoutMs < 1000 ? `${deps.toolTimeoutMs} ms` : `${Math.round(deps.toolTimeoutMs / 1000)} s`;
      return toolError(
        'timeout',
        `The team service did not answer within ${limit}. The action may still complete: check its ` +
          'effect (e.g. with get_task) before retrying.',
      );
    }
    deps.logger.error({ ...log, err }, 'team tool failed');
    return toolError(
      'internal',
      `${tool.name} failed because of an internal error. Try again later; if it keeps failing, tell a human.`,
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
