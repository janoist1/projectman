import { spawn } from 'node:child_process';
import net from 'node:net';

/**
 * The bridge in front of every program the launcher starts (`dist/worker-bridge.js`, PM-140).
 * Each worker unit has its own network namespace with only its own loopback: a member's test and
 * dev servers are its own, it reaches no other member's and cannot take a port of the service.
 * The two endpoints a session needs are carried out of it: 127.0.0.1:<app port> (the hook and MCP
 * endpoints) and 127.0.0.1:<egress port> (the egress proxy) inside the namespace lead to the
 * member's own unix sockets of the service, which nobody else can open. Then the program runs,
 * with this process's terminal; its exit status is the bridge's.
 *
 *   node worker-bridge.js --app SOCK --egress SOCK --app-port N --egress-port N -- PROGRAM ARGS...
 */

export interface BridgeOptions {
  appSocket: string;
  egressSocket: string;
  appPort: number;
  egressPort: number;
}

export function parseBridgeArgs(argv: string[]): { options: BridgeOptions; command: string[] } {
  const end = argv.indexOf('--');
  if (end === -1 || end === argv.length - 1) throw new Error('usage: worker-bridge OPTIONS -- PROGRAM ARGS');
  const values = new Map<string, string>();
  for (let i = 0; i < end; i += 2) values.set(argv[i]!, argv[i + 1] ?? '');
  const port = (key: string) => {
    const value = Number(values.get(key));
    if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`bad ${key}`);
    return value;
  };
  const socket = (key: string) => {
    const value = values.get(key) ?? '';
    if (!value.startsWith('/')) throw new Error(`bad ${key}`);
    return value;
  };
  return {
    options: {
      appSocket: socket('--app'),
      egressSocket: socket('--egress'),
      appPort: port('--app-port'),
      egressPort: port('--egress-port'),
    },
    command: argv.slice(end + 1),
  };
}

/** Listens on 127.0.0.1:port and pipes each connection to the unix socket. */
export function forward(port: number, socketPath: string): Promise<net.Server> {
  const server = net.createServer((inner) => {
    const outer = net.connect({ path: socketPath });
    inner.on('error', () => outer.destroy());
    outer.on('error', () => inner.destroy());
    inner.pipe(outer);
    outer.pipe(inner);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

async function main(): Promise<void> {
  const { options, command } = parseBridgeArgs(process.argv.slice(2));
  const servers = await Promise.all([
    forward(options.appPort, options.appSocket),
    forward(options.egressPort, options.egressSocket),
  ]);
  for (const server of servers) server.unref();
  const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', (err) => {
    process.stderr.write(`worker-bridge: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 128 + (signalNumber(signal) ?? 15) : 1));
  });
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal];
}

if (process.argv[1]?.endsWith('worker-bridge.js')) {
  main().catch((err: unknown) => {
    process.stderr.write(`worker-bridge: ${(err as Error).message}\n`);
    process.exit(126);
  });
}
