import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { TaskKey } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import { TeamToolError } from '../../contracts';
import type { ExternalCredentialMode, ExternalMcpBackend, IntegratorPrincipal } from '../../contracts';
import { DomainError } from '../../kernel';
import type { ExternalRegisteredTool, ExternalResult } from '../kit';
import { jsonSchemaValidator, SERVER_INFO, ToolTimeoutError, withTimeout } from '../server';
import { TEAM_TOOL_NAMES } from '../tools';
import { externalDenial, externalToolNamed, externalToolsFor } from './registry';

interface ExternalServerDeps {
  backend: ExternalMcpBackend;
  logger: FastifyBaseLogger;
  toolTimeoutMs: number;
}

/** What the route needs to know about the calls of one HTTP request once the server has answered. */
export interface ExternalCallState {
  /** A call found the key revoked or expired: the HTTP answer is 401, never a 200 tool error. */
  unauthorized: boolean;
}

const EXTERNAL_INSTRUCTIONS =
  'Integrator tools of projectman. Authenticate every request with the integrator key. There is no session and no ' +
  'current project: list_projects names the projects of this key, and every other tool takes project_key. ' +
  'A refused call answers {errorCode, message}; the code is the domain’s own. ' +
  'With a super key you are the global Operator: one for all projects, and the owner’s system administrator. ' +
  'On connecting, read your own knowledge with get_operator_instance_knowledge (write it with ' +
  'update_operator_instance_knowledge), then list_integrator_inbox without project_key: the integrator todos of ' +
  'every project come first. You handle machine, system and development matters, and you do little on your own. ' +
  'When a function is missing or broken, bridge the gap for the owner and record it as feedback ' +
  '(record_system_feedback; if this connection does not offer it, tell the owner). ' +
  'Project work is the project’s pm: do it only when the owner explicitly asks you to.';

/** The JSON Schema of a tool does not change: it is built once per tool, not once per request. */
const listed = new Map<string, Tool>();

function toolListing(tool: ExternalRegisteredTool): Tool {
  let entry = listed.get(tool.name);
  if (!entry) {
    entry = {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toJsonSchemaCompat(tool.inputSchema, {
        strictUnions: true,
        pipeStrategy: 'input',
      }) as Tool['inputSchema'],
      annotations: tool.annotations,
    };
    listed.set(tool.name, entry);
  }
  return entry;
}

/** The tools a credential mode is offered, as `tools/list` shows them. */
function externalToolListing(mode: ExternalCredentialMode): Tool[] {
  return externalToolsFor(mode).map(toolListing);
}

/** A refused or failed call: text for a reader, and the structured error code for the integrator. */
function externalError(code: string, message: string, details?: unknown): CallToolResult {
  const structured = { errorCode: code, message, ...(details === undefined ? {} : { details }) };
  return {
    content: [{ type: 'text', text: `Error [${code}]: ${message}` }],
    structuredContent: structured,
    isError: true,
  };
}

const TOOL_ERROR_CODES = {
  not_found: 'not_found',
  forbidden: 'insufficient_access',
  invalid: 'invalid_request',
  gate_blocked: 'gate_blocked',
} as const;

function resultOf(output: ExternalResult): CallToolResult {
  if (typeof output === 'string') return { content: [{ type: 'text', text: output }] };
  if ('structured' in output)
    return {
      content: [{ type: 'text', text: output.text ?? JSON.stringify(output.structured) }],
      structuredContent: output.structured,
    };
  return {
    content: [
      { type: 'text', text: output.text },
      ...output.images.map((image) => ({
        type: 'image' as const,
        data: image.data.toString('base64'),
        mimeType: image.mimeType,
      })),
    ],
  };
}

/**
 * A fresh MCP server for one HTTP request of the bearer endpoint (PM-760): stateless like the member one, but
 * bound to a key, not to a session. `tools/list` shows what the key's mode may call, and `tools/call` refuses
 * the rest with a domain denial, so a client that skips the list gains nothing.
 */
export function createExternalMcpServer(
  call: { principal: IntegratorPrincipal; requestId: string },
  state: ExternalCallState,
  deps: ExternalServerDeps,
): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: EXTERNAL_INSTRUCTIONS,
    jsonSchemaValidator,
  });
  server.onerror = (err) => deps.logger.debug({ err }, 'external MCP protocol error');
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: externalToolListing(call.principal.mode),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    runExternalTool(call, state, deps, request.params.name, request.params.arguments ?? {}),
  );
  return server;
}

async function runExternalTool(
  call: { principal: IntegratorPrincipal; requestId: string },
  state: ExternalCallState,
  deps: ExternalServerDeps,
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<CallToolResult> {
  const { principal, requestId } = call;
  const tool = externalToolNamed(name);
  if (!tool) {
    // A shared tool nobody bound is denied, an unknown name is just unknown; neither reaches a handler.
    if ((TEAM_TOOL_NAMES as readonly string[]).includes(name))
      return externalError(
        'integrator_not_allowed',
        `${name} is not available to the integrator: ${externalDenial(name)}.`,
      );
    return externalError('not_found', `Unknown tool ${name}.`);
  }
  if (!tool.modes.includes(principal.mode))
    return principal.mode === 'read' && tool.access === 'write'
      ? externalError('integrator_read_only', `${name} changes data, and a read-only key cannot.`)
      : externalError('integrator_not_allowed', `${name} is not available to a ${principal.mode} key.`);
  const parsed = await safeParseAsync(tool.inputSchema, rawArgs);
  if (!parsed.success)
    return externalError('invalid_request', `Invalid arguments for ${name}: ${issuesOf(parsed.error)}`);
  const args = parsed.data as Record<string, unknown>;
  const log = { tool: name, requestId, keyId: principal.keyId };
  const startedAt = Date.now();
  const run = async (): Promise<ExternalResult> => {
    if (tool.projectless) return tool.run({ principal, requestId, args, handler: deps.backend.handler });
    const projectKey = args.project_key as string;
    const taskKey =
      typeof args.task_key === 'string' && TaskKey.safeParse(args.task_key).success
        ? args.task_key
        : undefined;
    // Work on a queue item is made as the member who issued it, with the key's holder behind it (decision 66).
    const queueItemId = typeof args.queue_item_id === 'string' ? args.queue_item_id : undefined;
    const issuer = queueItemId
      ? ((await deps.backend.queueIssuer({ principal, projectKey }, queueItemId)) ?? undefined)
      : undefined;
    return deps.backend.execute(
      { principal, requestId, ...(issuer ? { issuer } : {}) },
      { projectKey, ...(taskKey ? { taskKey } : {}), operation: `mcp_${name}` },
      async () => {
        const ctx = await deps.backend.bind(
          { principal, projectKey, requestId, ...(issuer ? { issuer } : {}) },
          tool.access,
        );
        return tool.run({ ctx, args, handler: deps.backend.handler });
      },
    );
  };
  const pending = run();
  try {
    const output = await withTimeout(pending, deps.toolTimeoutMs);
    deps.logger.debug({ ...log, ms: Date.now() - startedAt }, 'external tool call');
    return resultOf(output);
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.status === 401 || err.code === 'integrator_key_invalid') state.unauthorized = true;
      deps.logger.debug({ ...log, code: err.code }, 'external tool refused');
      return externalError(err.code, err.message, err.details);
    }
    if (err instanceof TeamToolError) {
      deps.logger.debug({ ...log, code: err.code }, 'external tool refused');
      return externalError(TOOL_ERROR_CODES[err.code], err.message);
    }
    if (err instanceof ToolTimeoutError) {
      deps.logger.warn({ ...log, ms: deps.toolTimeoutMs }, 'external tool timed out');
      pending.then(
        () => deps.logger.warn(log, 'external tool finished after its timeout'),
        (lateErr: unknown) =>
          deps.logger.error({ ...log, err: lateErr }, 'external tool failed after its timeout'),
      );
      return externalError(
        'timeout',
        'The service did not answer in time. The action may still complete: read its effect before retrying.',
      );
    }
    deps.logger.error({ ...log, err }, 'external tool failed');
    return externalError('internal_error', `${name} failed because of an internal error.`);
  }
}

function issuesOf(error: unknown): string {
  const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (!issues) return error instanceof Error ? error.message : 'invalid input';
  return issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
}
