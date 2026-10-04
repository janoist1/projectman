#!/usr/bin/env node
/**
 * Runs a command as the guard's child and stops it, with everything it started, when the pipe
 * to the parent closes: the guard's standard input is a pipe from the parent, which never writes
 * to it, so it closes when the parent exits, even after a SIGKILL. SIGINT and SIGTERM stop the
 * child the same way. The guard exits with the child's exit code.
 *
 *   node child-guard.mjs <command> [args...]
 *
 * The child leads its own process group, so `kill(-pid)` also reaches the processes it started
 * (a server's agent sessions, Vite's esbuild service). It inherits the guard's output.
 */
import { spawn } from 'node:child_process';

const GRACE_MS = 5_000;
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: child-guard.mjs <command> [args...]');
  process.exit(2);
}

const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
let exited = false;
let killTimer;

function killGroup(signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

function stop() {
  if (exited || killTimer) return;
  killGroup('SIGTERM');
  killTimer = setTimeout(() => killGroup('SIGKILL'), GRACE_MS);
}

child.once('error', (err) => {
  console.error(`child-guard: cannot start ${command}: ${err.message}`);
  process.exit(127);
});
child.once('exit', (code, signal) => {
  exited = true;
  clearTimeout(killTimer);
  // The leader is gone, but a member of its group may remain: nothing may outlive the guard.
  killGroup('SIGKILL');
  process.exit(code ?? (signal ? 128 + (signal === 'SIGKILL' ? 9 : 15) : 1));
});

process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.on('error', stop);
process.stdin.resume();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
