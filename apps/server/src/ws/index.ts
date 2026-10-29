import type { Me } from '@projectman/shared';
import { randomUUID } from 'node:crypto';
import type { RunnerModule, EventBus } from '../contracts';
import type { TaskService } from '../core/tasks';
import type { EngineRegistry, SessionOrchestrator } from '../runtime/sessions';
import type { MessageService } from '../core/messages';
import type { MemberService, PresenceService, ProjectAccess } from '../core/members';

import type { FastifyInstance } from 'fastify';
import { canSeeOperatorSessions, ClientCommand, routes, systemFeedbackAccess } from '@projectman/shared';
import type { ErrorCode, HumanAccess, ServerEvent } from '@projectman/shared';
import { sameOrigin } from '../kernel';
import type { AuthService, AuthUser } from '../auth';
import { DomainError, forbidden, notFound } from '../kernel';
import { hasAccess } from '@projectman/shared';
import { canSeeProjectEvent, visibleProjectEvent } from '../core/projects';

interface WsDomain {
  readonly runnerModule: RunnerModule;
  readonly bus: EventBus;
  readonly tasks: TaskService;
  readonly sessions: SessionOrchestrator;
  readonly messages: MessageService;
  readonly members: MemberService;
  readonly presence: PresenceService;
  projectsFor(email: string): Promise<Me['projects']>;
  accessFor(projectKey: string, email: string): Promise<ProjectAccess | null>;
}

/** The part of the `ws` WebSocket API this module uses. */
interface WsSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close' | 'pong', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

const OPEN = 1;
const POLICY_VIOLATION = 1008;
/** How long a client's login check stands: a delivery to many events does not read the session table each time. */
const LOGIN_CHECK_TTL_MS = 5_000;
/** Commands a client may have waiting; a client that sends faster than they run is closed. */
const MAX_PENDING_COMMANDS = 200;

/** A command's refusal: the error code is the message. */
const errorEvent = (code: ErrorCode): ServerEvent => ({ type: 'error', message: code });

interface Client {
  id: string;
  socket: WsSocket;
  user: AuthUser;
  token: string;
  /** Subscribed project keys (membership is rechecked for every delivery). */
  projects: Set<string>;
  /** Sessions whose terminal this client is attached to. */
  terminals: Set<string>;
  alive: boolean;
  /** When the login was last found valid (ms); 0 forces a new check (a revoke clears it). */
  checkedAt: number;
}

function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
}

/**
 * /ws: login-cookie websocket. Clients subscribe to projects and receive their bus events;
 * terminal data goes only to clients attached to that session's terminal.
 */
export function registerWebsocket(
  app: FastifyInstance,
  deps: { domain: WsDomain; auth: AuthService; engineRegistry?: EngineRegistry; heartbeatMs?: number },
): void {
  const { domain } = deps;
  const runner = domain.runnerModule.runner;
  const clients = new Set<Client>();

  const authenticated = (client: Client) => {
    const now = Date.now();
    if (now - client.checkedAt < LOGIN_CHECK_TTL_MS) return true;
    if (deps.auth.resolve(client.token)) {
      client.checkedAt = now;
      return true;
    }
    client.socket.close(POLICY_VIOLATION, 'session expired');
    return false;
  };

  // A logout or a new login ends the session at once, not after the remembered check.
  const stopListeningForRevokes = deps.auth.onSessionRevoked((token) => {
    for (const client of clients) if (client.token === token) client.checkedAt = 0;
  });

  /** Sends the event if the client's login session is still valid (else closes the socket). */
  const send = (client: Client, event: ServerEvent) => {
    if (!authenticated(client)) return;
    if (client.socket.readyState !== OPEN) return;
    try {
      client.socket.send(JSON.stringify(event));
    } catch (err) {
      app.log.debug({ err }, 'websocket send failed');
    }
  };

  /** Whether any client has the session's terminal attached. */
  const viewed = (sessionId: string): boolean => {
    for (const client of clients) if (client.terminals.has(sessionId)) return true;
    return false;
  };

  /** A client stops viewing a terminal; the runner hears of it when it was the last viewer (PM-312). */
  const leave = (client: Client, sessionId: string): void => {
    if (!client.terminals.delete(sessionId)) return;
    if (!viewed(sessionId)) runner.detachTerminal?.(sessionId);
  };

  // Every delivery rechecks the current membership and then the login session (in send),
  // terminal streams included; clients that did not subscribe to the project or attach the
  // terminal are skipped first, without any lookups.
  let delivery = Promise.resolve();
  const unsubscribe = domain.bus.subscribe((event) => {
    delivery = delivery
      .then(async () => {
        if (event.type === 'hello' || event.type === 'error') return;
        for (const client of clients) {
          if (event.type === 'engine_changed') {
            // Only whom the engine concerns (PM-1061): the host owner, the engine's owner (a project or not),
            // a member of a project that uses it. A project–engine binding names its project (PM-1060).
            const engines = deps.engineRegistry;
            if (deps.auth.isHostOwner(client.user.id) || engines?.ownerOf(event.engine.id) === client.user.id)
              send(client, event);
            else if (event.projectKey !== undefined) {
              const access = await domain.accessFor(event.projectKey, client.user.email).catch(() => null);
              if (access) send(client, event);
            } else if (engines) {
              const projects = await domain.projectsFor(client.user.email);
              if (
                engines.canSee(event.engine.id, {
                  userId: client.user.id,
                  projectKeys: projects.map((p) => p.key),
                })
              )
                send(client, event);
            }
            continue;
          }
          // System feedback (PM-472) belongs to the installation: the instance owner, and an owner of the
          // project the item is for. The event names no text; a client that may not read it is skipped.
          if (event.type === 'system_feedback_changed') {
            const access = event.projectKey
              ? await domain.accessFor(event.projectKey, client.user.email).catch(() => null)
              : null;
            if (systemFeedbackAccess(deps.auth.isHostOwner(client.user.id), access?.access ?? null))
              send(client, event);
            continue;
          }
          if (event.type === 'terminal_data' || event.type === 'terminal_snapshot') {
            if (!client.terminals.has(event.sessionId)) continue;
            try {
              await requireTerminalAccess(client, event.sessionId, 'viewer');
            } catch {
              leave(client, event.sessionId);
              continue;
            }
            send(client, event);
          } else {
            if (!client.projects.has(event.projectKey)) continue;
            const access = await domain.accessFor(event.projectKey, client.user.email).catch(() => null);
            if (!access) client.projects.delete(event.projectKey);
            else {
              if (canSeeProjectEvent(access, event, (id) => domain.sessions.isRestrictedSession(id)))
                send(
                  client,
                  visibleProjectEvent(access, event, (id) => domain.messages.get(id)),
                );
            }
          }
        }
      })
      .catch((err: unknown) => app.log.warn({ err }, 'websocket delivery failed'));
  });

  /** Every member watches a terminal; typing and resizing need developer access. */
  const requireTerminalAccess = async (
    client: Client,
    sessionId: string,
    minimum: HumanAccess,
    options: { operatorInput?: boolean } = {},
  ) => {
    const session = domain.sessions.find(sessionId);
    if (!session) throw notFound('session', sessionId);
    const access = await domain.accessFor(session.projectKey, client.user.email);
    if (!access || !hasAccess(access.access, minimum)) {
      throw forbidden('insufficient_access', 'no access to this terminal');
    }
    // The Operator's terminals and the PM's conversations with others are the owner's and the admin's to see
    // (PM-475, PM-1080).
    if (!canSeeOperatorSessions(access) && domain.sessions.isRestrictedSession(sessionId))
      throw forbidden('insufficient_access', 'no access to this terminal');
    // Raw input to the Operator is a request of the owner's: an admin watches, but does not type (PM-475).
    if (options.operatorInput && access.access !== 'owner' && domain.sessions.isRestrictedSession(sessionId))
      throw forbidden('insufficient_access', 'only the owner types into the Operator’s terminal');
  };

  const handle = async (client: Client, data: unknown) => {
    if (!clients.has(client)) return;
    if (!authenticated(client)) return;
    if (Buffer.byteLength(messageText(data)) > 1024 * 1024) {
      client.socket.close(1009);
      return;
    }
    let command: ClientCommand;
    try {
      command = ClientCommand.parse(JSON.parse(messageText(data)));
    } catch {
      send(client, errorEvent('invalid_command'));
      return;
    }
    try {
      switch (command.type) {
        case 'visibility':
          domain.presence.setVisible(client.id, client.user.email, command.visible);
          return;
        case 'subscribe_project': {
          const access = await domain.accessFor(command.projectKey, client.user.email);
          if (!access) send(client, errorEvent('not_a_member'));
          else client.projects.add(command.projectKey);
          return;
        }
        case 'unsubscribe_project':
          client.projects.delete(command.projectKey);
          return;
        case 'terminal_attach': {
          await requireTerminalAccess(client, command.sessionId, 'viewer');
          client.terminals.add(command.sessionId);
          let snapshot: { data: string; cols: number; rows: number } | null;
          try {
            snapshot = runner.attachTerminal
              ? await runner.attachTerminal(command.sessionId)
              : runner.snapshot(command.sessionId);
          } catch (err) {
            leave(client, command.sessionId);
            throw err;
          }
          // The viewer left while the engine was answering: what the attach started stops with no viewer.
          if (!client.terminals.has(command.sessionId)) {
            if (!viewed(command.sessionId)) runner.detachTerminal?.(command.sessionId);
            return;
          }
          if (snapshot)
            send(client, { type: 'terminal_snapshot', sessionId: command.sessionId, ...snapshot });
          return;
        }
        case 'terminal_detach':
          leave(client, command.sessionId);
          return;
        case 'terminal_input':
          if (!client.terminals.has(command.sessionId))
            throw forbidden('not_attached', 'attach the terminal first');
          await requireTerminalAccess(client, command.sessionId, 'developer', { operatorInput: true });
          if (authenticated(client)) runner.writeTerminal(command.sessionId, command.data);
          return;
        case 'terminal_resize':
          if (!client.terminals.has(command.sessionId))
            throw forbidden('not_attached', 'attach the terminal first');
          await requireTerminalAccess(client, command.sessionId, 'developer');
          if (authenticated(client)) runner.resize(command.sessionId, command.cols, command.rows);
          return;
      }
    } catch (err) {
      if (!(err instanceof DomainError))
        app.log.error({ err, command: command.type }, 'websocket command failed');
      send(client, errorEvent(err instanceof DomainError ? err.code : 'internal_error'));
    }
  };

  const presenceChanged = (email: string) =>
    domain.members
      .presenceChanged(email)
      .catch((err: unknown) => app.log.warn({ err }, 'presence update failed'));

  app.get(routes.websocket(), { websocket: true }, (rawSocket, request) => {
    const socket = rawSocket as WsSocket;
    const user = request.user;
    if (!user || !sameOrigin(request)) {
      socket.close(POLICY_VIOLATION, 'forbidden');
      return;
    }
    const client: Client = {
      id: randomUUID(),
      socket,
      user,
      token: request.authToken!,
      projects: new Set(),
      terminals: new Set(),
      alive: true,
      checkedAt: 0,
    };
    clients.add(client);
    let commands = Promise.resolve();
    let pendingCommands = 0;
    socket.on('message', (data) => {
      if (pendingCommands >= MAX_PENDING_COMMANDS) {
        socket.close(POLICY_VIOLATION, 'too many commands');
        return;
      }
      pendingCommands += 1;
      commands = commands.then(() => handle(client, data)).finally(() => (pendingCommands -= 1));
    });
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('error', (err) => app.log.debug({ err }, 'websocket error'));
    socket.on('close', () => {
      domain.presence.setVisible(client.id, user.email, false);
      clients.delete(client);
      for (const sessionId of client.terminals) if (!viewed(sessionId)) runner.detachTerminal?.(sessionId);
      client.terminals.clear();
      if (domain.presence.disconnect(user.email)) void presenceChanged(user.email);
    });
    if (domain.presence.connect(user.email)) void presenceChanged(user.email);
    send(client, { type: 'hello', serverTime: new Date().toISOString() });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!authenticated(client)) continue;
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        // closed meanwhile
      }
      // A browser cannot see a ping: this frame tells its client the connection lives (it closes after a long silence).
      send(client, { type: 'hello', serverTime: new Date().toISOString() });
    }
  }, deps.heartbeatMs ?? 30_000);
  heartbeat.unref();

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    stopListeningForRevokes();
    unsubscribe();
  });
}
