import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { PtyProcess, SpawnPty } from './session';

/** The exit code a shell reports for a command that cannot be started. */
const START_FAILED_EXIT_CODE = 127;

/**
 * Starts a process with plain pipes instead of a pseudo-terminal (PM-267), for the fake CLIs in a
 * development instance whose sandbox has no PTY. Standard output and error are one stream, as on a
 * terminal; the terminal size and name are ignored, and resizing does nothing. A real CLI does not
 * run interactively this way: the server only allows it with the fake CLIs (`parseTerminalMode`).
 */
export const pipeSpawn: SpawnPty = (file, args, options): PtyProcess => {
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  let exited = false;

  const finish = (event: { exitCode: number; signal?: number }): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener(event);
  };

  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      for (const listener of dataListeners) listener(chunk);
    });
  }
  // A closed pipe (EPIPE) must not become an unhandled error that stops the server.
  child.stdin.on('error', () => {});
  // The start failed (no such file): there will be no exit code from the process itself. Later errors
  // (a kill that failed) change nothing.
  child.on('error', () => {
    if (child.pid === undefined) finish({ exitCode: START_FAILED_EXIT_CODE });
  });
  // `close`, not `exit`: the output the process wrote last arrives before it.
  child.on('close', (code, signalName) => {
    if (child.pid === undefined) return finish({ exitCode: START_FAILED_EXIT_CODE });
    finish({
      exitCode: code ?? 0,
      signal: signalName ? constants.signals[signalName] : undefined,
    });
  });

  return {
    get pid() {
      return child.pid ?? -1;
    },
    write(data) {
      if (exited || child.stdin.destroyed || !child.stdin.writable) return;
      child.stdin.write(data);
    },
    resize() {},
    kill(signal) {
      try {
        child.kill((signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
      } catch {
        // the process is gone already
      }
    },
    onData(listener) {
      dataListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
  };
};
