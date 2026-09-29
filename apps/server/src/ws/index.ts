import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ClientCommand, routes } from '@projectman/shared';
import type { HumanAccess, ServerEvent } from '@projectman/shared';
import type { AuthUser } from '../auth/auth-service';
import type { Domain, ProjectAccess } from '../domain';
import { DomainError, forbidden, hasAccess, notFound } from '../domain';

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

interface Client {
  socket: WsSocket;
  user: AuthUser;
  /** Subscribed projects with the user's access at subscription time. */
  projects: Map<string, ProjectAccess>;
  /** Sessions whose terminal this client is attached to. */
  terminals: Set<string>;
  alive: boolean;
}

type ProjectEvent = Exclude<ServerEvent, { type: 'hello' | 'error' | 'terminal_data' | 'terminal_snapshot' }>;

/** Client members only receive what is shared with them. */
function canSee(access: ProjectAccess, event: ProjectEvent): boolean {
  if (access.access !== 'client') return true;
  switch (event.type) {
    case 'task_upserted':
      return event.task.visibility === 'shared';
    case 'inbox_upserted':
      return event.item.assignees.includes(access.handle);
    case 'team_message':
      return event.message.from === access.handle || event.message.to.includes(access.handle);
    case 'config_changed':
    case 'member_changed':
      return true;
    default:
      return false;
  }
}

/** Browsers send Origin; it must name the host the page talks to (blocks cross-site websocket use). */
function sameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const strip = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, '');
    const host = (request.headers.host ?? '').replace(/:\d+$/, '');
    return strip(new URL(origin).hostname) === strip(host);
  } catch {
    return false;
  }
}

function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
}

export interface WebsocketHub {
  clientCount(): number;
}

/**
 * /ws: login-cookie websocket. Clients subscribe to projects and receive their bus events;
 * terminal data goes only to clients attached to that session's terminal.
 */
export function registerWebsocket(
  app: FastifyInstance,
  deps: { domain: Domain; heartbeatMs?: number },
): WebsocketHub {
  const { domain } = deps;
  const runner = domain.runnerModule.runner;
  const clients = new Set<Client>();

  const send = (client: Client, event: ServerEvent) => {
    if (client.socket.readyState !== OPEN) return;
    try {
      client.socket.send(JSON.stringify(event));
    } catch (err) {
      app.log.debug({ err }, 'websocket send failed');
    }
  };

  const refreshAccess = async (projectKey: string) => {
    for (const client of clients) {
      if (!client.projects.has(projectKey)) continue;
      const access = await domain.accessFor(projectKey, client.user.email).catch(() => null);
      if (access) client.projects.set(projectKey, access);
      else {
        client.projects.delete(projectKey);
        send(client, { type: 'error', message: 'not_a_member' });
      }
    }
  };

  const unsubscribe = domain.bus.subscribe((event) => {
    if (event.type === 'hello' || event.type === 'error') return;
    if (event.type === 'terminal_data' || event.type === 'terminal_snapshot') {
      for (const client of clients) if (client.terminals.has(event.sessionId)) send(client, event);
      return;
    }
    for (const client of clients) {
      const access = client.projects.get(event.projectKey);
      if (access && canSee(access, event)) send(client, event);
    }
    if (event.type === 'config_changed') {
      refreshAccess(event.projectKey).catch((err: unknown) => app.log.warn({ err }, 'access refresh failed'));
    }
  });

  /** Terminals are for internal members; typing and resizing need developer access. */
  const requireTerminalAccess = async (client: Client, sessionId: string, minimum: HumanAccess) => {
    const session = domain.ctx.repos.sessions.get(sessionId);
    if (!session) throw notFound('session', sessionId);
    const access = await domain.accessFor(session.projectKey, client.user.email);
    if (!access || access.access === 'client' || !hasAccess(access.access, minimum)) {
      throw forbidden('insufficient_access', 'no access to this terminal');
    }
  };

  const handle = async (client: Client, data: unknown) => {
    let command: ClientCommand;
    try {
      command = ClientCommand.parse(JSON.parse(messageText(data)));
    } catch {
      send(client, { type: 'error', message: 'invalid_command' });
      return;
    }
    try {
      switch (command.type) {
        case 'subscribe_project': {
          const access = await domain.accessFor(command.projectKey, client.user.email);
          if (!access) send(client, { type: 'error', message: 'not_a_member' });
          else client.projects.set(command.projectKey, access);
          return;
        }
        case 'unsubscribe_project':
          client.projects.delete(command.projectKey);
          return;
        case 'terminal_attach': {
          await requireTerminalAccess(client, command.sessionId, 'viewer');
          client.terminals.add(command.sessionId);
          const snapshot = runner.snapshot(command.sessionId);
          if (snapshot)
            send(client, { type: 'terminal_snapshot', sessionId: command.sessionId, ...snapshot });
          return;
        }
        case 'terminal_detach':
          client.terminals.delete(command.sessionId);
          return;
        case 'terminal_input':
          if (!client.terminals.has(command.sessionId))
            throw forbidden('not_attached', 'attach the terminal first');
          await requireTerminalAccess(client, command.sessionId, 'developer');
          runner.writeTerminal(command.sessionId, command.data);
          return;
        case 'terminal_resize':
          if (!client.terminals.has(command.sessionId))
            throw forbidden('not_attached', 'attach the terminal first');
          await requireTerminalAccess(client, command.sessionId, 'developer');
          runner.resize(command.sessionId, command.cols, command.rows);
          return;
      }
    } catch (err) {
      if (!(err instanceof DomainError))
        app.log.error({ err, command: command.type }, 'websocket command failed');
      send(client, { type: 'error', message: err instanceof DomainError ? err.code : 'internal_error' });
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
    const client: Client = { socket, user, projects: new Map(), terminals: new Set(), alive: true };
    clients.add(client);
    socket.on('message', (data) => void handle(client, data));
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('error', (err) => app.log.debug({ err }, 'websocket error'));
    socket.on('close', () => {
      clients.delete(client);
      if (domain.presence.disconnect(user.email)) void presenceChanged(user.email);
    });
    if (domain.presence.connect(user.email)) void presenceChanged(user.email);
    send(client, { type: 'hello', serverTime: new Date().toISOString() });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
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

  return { clientCount: () => clients.size };
}
