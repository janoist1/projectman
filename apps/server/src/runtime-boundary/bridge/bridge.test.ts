import { stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freePort, silentLogger, tempDirs } from '../../runner/test-helpers';
import { createServiceBridges } from './service-bridges';
import type { ServiceBridges } from './service-bridges';
import { forward, parseBridgeArgs } from './worker-bridge';

const dirs = tempDirs();

/** Some sandboxes (the agents' own) refuse to bind a unix socket: those tests run elsewhere. */
async function canListenOnUnixSockets(): Promise<boolean> {
  const dir = await dirs.make('pmb-probe-');
  const server = net.createServer();
  const ok = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(path.join(dir, 's.sock'), () => resolve(true));
  });
  if (ok) await new Promise<void>((resolve) => server.close(() => resolve()));
  return ok;
}
const unixSockets = await canListenOnUnixSockets();
if (!unixSockets)
  console.warn('No unix socket can be bound here (a sandbox?): skipping the bridge socket tests.');
let root: string;
let app: net.Server;
let appPort: number;
let egress: Array<{ member: string; socket: net.Socket }>;
let bridges: ServiceBridges;
const gid = process.getgid?.() ?? 0;

/** Sends `text` over a connection and resolves with what comes back before it closes. */
function roundTrip(connect: () => net.Socket, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect();
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    socket.end(text);
  });
}

beforeEach(async () => {
  root = await dirs.make('pmb-');
  egress = [];
  app = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.end(`app:${chunk.toString()}`));
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  appPort = (app.address() as net.AddressInfo).port;
  bridges = createServiceBridges({
    root,
    appPort,
    groupOf: (member) => (member === 'nobody' ? null : gid),
    onEgress: (socket, member) => {
      egress.push({ member, socket });
      socket.end('egress');
    },
    logger: silentLogger(),
  });
});

afterEach(async () => {
  await bridges.close();
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await dirs.cleanup();
});

describe.skipIf(!unixSockets)('the service side of the worker bridges', () => {
  it('makes the member’s sockets in a directory only its group can enter', async () => {
    await bridges.ensure('dev');
    await bridges.ensure('dev');
    const dir = await stat(path.join(root, 'dev'));
    expect(dir.mode & 0o7777).toBe(0o2750);
    expect(dir.gid).toBe(gid);
    for (const name of ['app.sock', 'egress.sock']) {
      const socket = await stat(path.join(root, 'dev', name));
      expect(socket.isSocket()).toBe(true);
      expect(socket.mode & 0o777).toBe(0o660);
    }
    expect(bridges.paths('dev')).toEqual({
      app: path.join(root, 'dev', 'app.sock'),
      egress: path.join(root, 'dev', 'egress.sock'),
    });
  });

  it('pipes the app socket to the app’s port and hands the egress socket over with its member', async () => {
    await bridges.ensure('dev');
    expect(await roundTrip(() => net.connect({ path: bridges.paths('dev').app }), 'hook')).toBe('app:hook');
    expect(await roundTrip(() => net.connect({ path: bridges.paths('dev').egress }), 'x')).toBe('egress');
    expect(egress.map((e) => e.member)).toEqual(['dev']);
  });
});

it('refuses bridge sockets for a member without a worker account and for an odd handle', async () => {
  await expect(bridges.ensure('nobody')).rejects.toThrow(/no worker account/);
  await expect(bridges.ensure('../x')).rejects.toThrow();
});

describe('the bridge inside a worker unit', () => {
  it('passes the whole answer back after the client has sent everything (half-close)', async () => {
    const port = await freePort();
    // A slow answer: it comes after the client's FIN.
    const slow = net.createServer({ allowHalfOpen: true }, (socket) => {
      let text = '';
      socket.on('data', (chunk) => (text += chunk.toString()));
      socket.on('end', () => setTimeout(() => socket.end(`app:${text}`), 50));
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const server = await forward(port, { host: '127.0.0.1', port: (slow.address() as net.AddressInfo).port });
    try {
      expect(await roundTrip(() => net.connect(port, '127.0.0.1'), 'hook')).toBe('app:hook');
    } finally {
      server.close();
      slow.close();
    }
  });

  it.skipIf(!unixSockets)('carries a loopback port to a unix socket', async () => {
    await bridges.ensure('dev');
    const port = await freePort();
    const server = await forward(port, bridges.paths('dev').app);
    try {
      expect(await roundTrip(() => net.connect(port, '127.0.0.1'), 'mcp')).toBe('app:mcp');
    } finally {
      server.close();
    }
  });

  it('reads its options and the program to run', () => {
    expect(
      parseBridgeArgs([
        '--app',
        '/run/b/dev/app.sock',
        '--egress',
        '/run/b/dev/egress.sock',
        '--app-port',
        '4700',
        '--egress-port',
        '4780',
        '--',
        '/usr/bin/git',
        'status',
      ]),
    ).toEqual({
      options: {
        appSocket: '/run/b/dev/app.sock',
        egressSocket: '/run/b/dev/egress.sock',
        appPort: 4700,
        egressPort: 4780,
      },
      command: ['/usr/bin/git', 'status'],
    });
    expect(() => parseBridgeArgs(['--app', 'relative', '--', 'x'])).toThrow();
    expect(() =>
      parseBridgeArgs(['--app', '/a', '--egress', '/b', '--app-port', '0', '--egress-port', '1', '--', 'x']),
    ).toThrow();
    expect(() => parseBridgeArgs(['--app', '/a'])).toThrow();
  });
});
