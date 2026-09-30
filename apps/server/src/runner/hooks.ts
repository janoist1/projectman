import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { nonLocalReason } from '../http/local-guard';
import type { HookPayload } from './hook-payload';
import type { AgentSession } from './session';

/**
 * POST /hooks/:token — Claude Code's HTTP hooks, and the forwarder of command hooks
 * (Claude Code's SessionStart, every Codex hook).
 *
 * Before the body is read, only local requests are accepted (loopback peer, loopback Host and
 * Origin, no forwarding headers: `tailscale serve` also connects from 127.0.0.1 but adds
 * them), and the token must name a live session. The token in the path is random per session;
 * an unknown token gets 404. It is looked up again once the body has arrived, so a session
 * that exited meanwhile gets 404 too. Answers follow the hooks reference: an empty 200 is a
 * no-op, and a PermissionRequest gets the decision JSON (which may take as long as a human
 * needs, up to the permission timeout).
 */

export interface HookRouteDeps {
  sessionForToken(token: string): AgentSession | undefined;
  /** Validates a hook body for the session's CLI; null when malformed. */
  parse(session: AgentSession, body: unknown): HookPayload | null;
  logger: FastifyBaseLogger;
}

/** Tool responses in PostToolUse payloads can be large (file contents, command output). */
const BODY_LIMIT = 32 * 1024 * 1024;

export function registerHookRoutes(app: FastifyInstance, deps: HookRouteDeps): void {
  app.post<{ Params: { token: string } }>(
    '/hooks/:token',
    {
      bodyLimit: BODY_LIMIT,
      onRequest: async (request, reply) => {
        if (nonLocalReason({ remoteAddress: request.socket.remoteAddress, headers: request.headers }))
          return reply.code(403).send();
        if (!deps.sessionForToken(request.params.token)) return reply.code(404).send();
      },
    },
    async (request, reply) => {
      const session = deps.sessionForToken(request.params.token);
      if (!session) return reply.code(404).send();

      const payload = deps.parse(session, request.body);
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
