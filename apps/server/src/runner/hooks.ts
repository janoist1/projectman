import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { HookPayload } from './hook-payload';
import type { AgentSession } from './session';

/**
 * POST /hooks/:token — Claude Code's HTTP hooks, and the forwarder of command hooks
 * (Claude Code's SessionStart, every Codex hook).
 *
 * Only loopback connections that did not come through a proxy are accepted (`tailscale
 * serve` also connects from 127.0.0.1, but adds forwarding headers). The token in the path
 * is random per session; an unknown token gets 404. Answers follow the hooks reference: an
 * empty 200 is a no-op, and a PermissionRequest gets the decision JSON (which may take as
 * long as a human needs, up to the permission timeout).
 */

export interface HookRouteDeps {
  sessionForToken(token: string): AgentSession | undefined;
  /** Validates a hook body for the session's CLI (default: Claude Code's payload schema). */
  parse?(session: AgentSession, body: unknown): HookPayload | null;
  logger: FastifyBaseLogger;
}

function parseClaudePayload(_session: AgentSession, body: unknown): HookPayload | null {
  const parsed = HookPayload.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** Tool responses in PostToolUse payloads can be large (file contents, command output). */
const BODY_LIMIT = 32 * 1024 * 1024;

const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'x-real-ip',
];

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

export function isProxied(headers: IncomingHttpHeaders): boolean {
  return FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

export function registerHookRoutes(app: FastifyInstance, deps: HookRouteDeps): void {
  app.post<{ Params: { token: string } }>(
    '/hooks/:token',
    { bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      if (!isLoopback(request.socket.remoteAddress) || isProxied(request.headers)) {
        return reply.code(403).send();
      }
      const session = deps.sessionForToken(request.params.token);
      if (!session) return reply.code(404).send();

      const payload = (deps.parse ?? parseClaudePayload)(session, request.body);
      if (!payload) {
        deps.logger.warn({ sessionId: session.id }, 'malformed hook payload');
        return reply.code(400).send();
      }

      // The CLI closes the request when it stops waiting (e.g. the prompt was answered in the
      // terminal, or its own hook timeout); a pending permission request is then withdrawn.
      const withdrawn = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) withdrawn.abort();
      };
      reply.raw.on('close', onClose);
      try {
        const body = await session.handleHook(payload, withdrawn.signal);
        if (body === null) return reply.code(200).send();
        return reply.code(200).header('content-type', 'application/json').send(JSON.stringify(body));
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );
}
