import type { FastifyInstance } from 'fastify';
import { ClientCommand, routes } from '@projectman/shared';
import type { ErrorCode, HumanAccess, ServerEvent } from '@projectman/shared';
import { sameOrigin } from '../auth/local-request';
import type { AuthService, AuthUser } from '../auth/auth-service';
import type { Domain } from '../domain';
import { DomainError, forbidden, hasAccess, notFound } from '../domain';
import { canSeeProjectEvent, visibleProjectEvent } from '../domain/visibility';

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

/** A command's refusal: the error code is the message. */
const errorEvent = (code: ErrorCode): ServerEvent => ({ type: 'error', message: code });

interface Client {
  socket: WsSocket;
  user: AuthUser;
  token: string;
  /** Subscribed project keys (membership is rechecked for every delivery). */
  projects: Set<string>;
  /** Sessions whose terminal this client is attached to. */
  terminals: Set<string>;
  alive: boolean;
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
  deps: { domain: Domain; auth: AuthService; heartbeatMs?: number },
): void {
  const { domain } = deps;
  const runner = domain.runnerModule.runner;
  const clients = new Set<Client>();

  const authenticated = (client: Client) => {
    if (deps.auth.resolve(client.token)) return true;
    client.socket.close(POLICY_VIOLATION, 'session expired');
    return false;
  };

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
              const taskOf = (taskKey: string) => domain.tasks.find(event.projectKey, taskKey);
              if (canSeeProjectEvent(access, event, taskOf))
                send(
                  client,
                  visibleProjectEvent(access, event, taskOf, (id) => domain.messages.get(id)),
                );
            }
          }
        }
      })
      .catch((err: unknown) => app.log.warn({ err }, 'websocket delivery failed'));
  });

  /** Terminals are for internal members; typing and resizing need developer access. */
  const requireTerminalAccess = async (client: Client, sessionId: string, minimum: HumanAccess) => {
    const session = domain.sessions.find(sessionId);
    if (!session) throw notFound('session', sessionId);
    const access = await domain.accessFor(session.projectKey, client.user.email);
    if (!access || access.access === 'client' || !hasAccess(access.access, minimum)) {
      throw forbidden('insufficient_access', 'no access to this terminal');
    }
  };

  const handle = async (client: Client, data: unknown) => {
    if (!authenticated(client)) return;
    let command: ClientCommand;
    try {
      command = ClientCommand.parse(JSON.parse(messageText(data)));
    } catch {
      send(client, errorEvent('invalid_command'));
      return;
    }
    try {
      switch (command.type) {
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
          await requireTerminalAccess(client, command.sessionId, 'developer');
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
      socket,
      user,
      token: request.authToken!,
      projects: new Set(),
      terminals: new Set(),
      alive: true,
    };
    clients.add(client);
    let commands = Promise.resolve();
    socket.on('message', (data) => {
      commands = commands.then(() => handle(client, data));
    });
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('error', (err) => app.log.debug({ err }, 'websocket error'));
    socket.on('close', () => {
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
    }
  }, deps.heartbeatMs ?? 30_000);
  heartbeat.unref();

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
