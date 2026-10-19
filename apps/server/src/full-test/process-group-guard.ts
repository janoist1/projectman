/**
 * Runs outside the sandbox as the detached group leader. The engine keeps its stdin pipe open;
 * EOF survives even an engine SIGKILL, when no engine-side finalizer can run. Keep this standalone
 * JavaScript: it runs with plain Node in both source checkouts and the bundled engine.
 */
export const PROCESS_GROUP_GUARD = String.raw`
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const [file, args, graceMs] = JSON.parse(process.argv[1]);
let orphaned = false;
process.on('SIGTERM', () => {});
const killGroup = (signal) => {
  try { process.kill(-process.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const stop = () => {
  if (orphaned) return;
  orphaned = true;
  killGroup('SIGTERM');
  setTimeout(() => killGroup('SIGKILL'), graceMs);
};
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.resume();
const child = spawn(file, args, { detached: false, stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', (error) => {
  if (orphaned) return;
  process.send({ exitCode: null, signal: null, error: error.message }, (sendError) => {
    if (sendError) stop();
    else process.exit(127);
  });
});
child.on('exit', (code, signal) => {
  if (orphaned) return;
  // Node reserves some signals (SIGUSR1 starts its debugger), so re-signalling the guard
  // cannot faithfully relay every command signal. Only the engine receives this IPC channel.
  process.send({ exitCode: code, signal }, (error) => {
    if (error) stop();
    else process.exit(code ?? (128 + constants.signals[signal]));
  });
});
`;
