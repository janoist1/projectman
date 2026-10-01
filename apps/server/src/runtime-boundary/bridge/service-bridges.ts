import { chmod, chown, lstat, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { MEMBER_HANDLE } from '../config';

/**
 * The service's side of the worker bridges (PM-140): for each member, `<root>/<handle>/app.sock`
 * (piped to the app's loopback port: hooks and MCP) and `<root>/<handle>/egress.sock` (handed to
 * the egress proxy, which then knows the member from the socket). The directory is the service's
 * with the member's group and the set-group-id bit, mode 2750, and the sockets 0660: only that
 * member's worker (and the service) can open them. Opened for every worker account when the
 * service starts (`openWorkerBridges`, PM-175), and again on demand before a member's unit.
 */
export interface ServiceBridges {
  /** Listens for the member (idempotent); rejects when the directory cannot be prepared. */
  ensure(member: string): Promise<void>;
  /** The member's socket paths. */
  paths(member: string): { app: string; egress: string };
  close(): Promise<void>;
}

export function createServiceBridges(opts: {
  root: string;
  appPort: number;
  /** The member's worker group (its primary gid), or null when it has no worker account. */
  groupOf(member: string): number | null;
  /** A connection to the member's egress socket. */
  onEgress(socket: net.Socket, member: string): void;
  logger: FastifyBaseLogger;
}): ServiceBridges {
  const ready = new Map<string, Promise<net.Server[]>>();
  /** Every open bridge connection (both ends): a shutdown ends them instead of waiting for them. */
  const connections = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  };

  const paths = (member: string) => {
    if (!MEMBER_HANDLE.test(member)) throw new Error(`invalid member handle: ${member}`);
    const dir = path.posix.join(opts.root, member);
    return { dir, app: path.posix.join(dir, 'app.sock'), egress: path.posix.join(dir, 'egress.sock') };
  };

  function listen(file: string, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
    // Half-open: a client that has sent everything (FIN) still gets the whole answer.
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      track(socket);
      onConnection(socket);
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(file, () => {
        server.removeListener('error', reject);
        resolve(server);
      });
    });
  }

  async function open(member: string): Promise<net.Server[]> {
    const gid = opts.groupOf(member);
    if (gid === null) throw new Error(`no worker account for ${member}`);
    const { dir, app, egress } = paths(member);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const entry = await lstat(dir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
    await chown(dir, -1, gid);
    await chmod(dir, 0o2750);
    const servers: net.Server[] = [];
    for (const [file, handler] of [
      [
        app,
        (inner: net.Socket) => {
          const outer = net.connect({ host: '127.0.0.1', port: opts.appPort, allowHalfOpen: true });
          track(outer);
          inner.on('error', () => outer.destroy());
          outer.on('error', () => inner.destroy());
          inner.pipe(outer);
          outer.pipe(inner);
        },
      ],
      [egress, (socket: net.Socket) => opts.onEgress(socket, member)],
    ] as const) {
      await rm(file, { force: true });
      servers.push(await listen(file, handler));
      await chmod(file, 0o660);
    }
    opts.logger.info({ member }, 'worker bridge sockets ready');
    return servers;
  }

  return {
    paths: (member) => {
      const { app, egress } = paths(member);
      return { app, egress };
    },
    ensure(member) {
      let pending = ready.get(member);
      if (!pending) {
        pending = open(member);
        ready.set(member, pending);
        pending.catch(() => ready.delete(member));
      }
      return pending.then(() => undefined);
    },
    async close() {
      const all = await Promise.all([...ready.values()].map((p) => p.catch(() => [] as net.Server[])));
      ready.clear();
      const closed = Promise.all(
        all.flat().map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      // A keep-alive hook or MCP connection, or a half-closed one, would hold the shutdown.
      for (const socket of connections) socket.destroy();
      connections.clear();
      await closed;
    },
  };
}
