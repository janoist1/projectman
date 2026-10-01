import { spawn } from 'node:child_process';
import net from 'node:net';
import * as pty from '@lydell/node-pty';
import { loadBoundaryConfig } from '../config';
import { passwdAccounts } from './accounts';
import { createLauncher } from './daemon';

/**
 * Entry point of the protected launcher (`dist/launcher.js`), run as root by
 * projectman-launcher.service. Its socket comes from projectman-launcher.socket (systemd socket
 * activation, fd 3: root-owned, group = the service's, mode 0660), so the launcher itself never
 * creates or chowns it. The only argument is the boundary configuration file. It logs to stderr
 * (the journal), never a request's arguments.
 */

const SD_LISTEN_FDS_START = 3;

function log(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string): void {
  process.stderr.write(`${JSON.stringify({ level, msg: message, ...fields })}\n`);
}

function main(): void {
  const configPath = process.argv[2] ?? '/etc/projectman/boundary.json';
  const config = loadBoundaryConfig(configPath);
  if (process.getuid?.() !== 0) throw new Error('the launcher must run as root');
  const launcher = createLauncher({
    config,
    accounts: passwdAccounts(),
    spawnPty: (file, args, opts) =>
      pty.spawn(file, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: '/', env: opts.env }),
    spawnChild: (file, args, opts) => spawn(file, args, { cwd: '/', env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] }),
    log,
  });
  const server = net.createServer({ allowHalfOpen: false }, (conn) => launcher.handle(conn));
  server.maxConnections = config.launcher.maxSessions + 32;
  const fds = Number(process.env.LISTEN_FDS ?? '0');
  if (fds !== 1 || Number(process.env.LISTEN_PID) !== process.pid)
    throw new Error('the launcher expects exactly one socket from systemd (projectman-launcher.socket)');
  server.listen({ fd: SD_LISTEN_FDS_START });
  log('info', { config: configPath }, 'launcher ready');
  const stop = () => {
    launcher.stopAll();
    server.close();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

try {
  main();
} catch (err) {
  log('error', { err: (err as Error).message }, 'launcher failed to start');
  process.exit(1);
}
